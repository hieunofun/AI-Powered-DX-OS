import { Injectable } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { MatchingInput, MatchingInvoice, MatchingPo, MatchingPolicy, InvoiceLine, PoLine } from './interfaces/matching.interface';
import { evaluateMatching } from './domain/three-way-matching.engine';
import { snapshotPolicy } from './domain/matching-policy';
import { UpdateMatchingPolicyDto } from './dto/update-matching-policy.dto';
import { MatchingError } from './matching-error';
import { QuantityClaimError, readQuantityClaims, readReceivedQuantities } from './quantity-claims';

const POLICY_COLUMNS = `id, policy_code AS "policyCode", quantity_tolerance_percent::text AS "quantityTolerancePercent",
  price_tolerance_percent::text AS "priceTolerancePercent", tax_tolerance_percent::text AS "taxTolerancePercent",
  total_tolerance_percent::text AS "totalTolerancePercent"`;

@Injectable()
export class MatchingRepository {
  constructor(private readonly db: DatabaseService) {}
  private async audit(client: PoolClient, entityType: string, entityId: string, eventType: string,
    actor: AuthenticatedUser, metadata: unknown) {
    await client.query(`INSERT INTO audit_records(entity_type,entity_id,event_type,actor_subject,metadata)
      VALUES ($1,$2,$3,$4,$5::jsonb)`, [entityType, entityId, eventType, actor.sub, JSON.stringify(metadata)]);
  }
  private async activePolicy(client: PoolClient, lock: 'SHARE' | 'UPDATE') {
    const result = await client.query<MatchingPolicy>(`SELECT ${POLICY_COLUMNS} FROM matching_policies
      WHERE is_active = true FOR ${lock}`);
    if (result.rows.length !== 1) throw new MatchingError('MATCHING_POLICY_UNAVAILABLE', 'Exactly one active matching policy is required.', 503);
    return result.rows[0];
  }
  async policy() {
    return this.db.transaction(client => this.activePolicy(client, 'SHARE'));
  }
  async updatePolicy(dto: UpdateMatchingPolicyDto, actor: AuthenticatedUser) {
    return this.db.transaction(async client => {
      const previous = await this.activePolicy(client, 'UPDATE');
      const result = await client.query<MatchingPolicy>(`UPDATE matching_policies
        SET quantity_tolerance_percent=$2, price_tolerance_percent=$3,
          tax_tolerance_percent=$4, total_tolerance_percent=$5
        WHERE id=$1 RETURNING ${POLICY_COLUMNS}`,
      [previous.id, dto.quantityTolerancePercent ?? previous.quantityTolerancePercent,
        dto.priceTolerancePercent ?? previous.priceTolerancePercent,
        dto.taxTolerancePercent ?? previous.taxTolerancePercent,
        dto.totalTolerancePercent ?? previous.totalTolerancePercent]);
      const policy = result.rows[0];
      await this.audit(client, 'MATCHING_POLICY', policy.id, 'MATCHING_POLICY_UPDATED', actor,
        { policyCode: policy.policyCode, previous: snapshotPolicy(previous), new: snapshotPolicy(policy), roles: actor.roles });
      return policy;
    });
  }
  async match(invoiceId: string, actor: AuthenticatedUser) {
    return this.db.transaction(async client => {
      // Fresh statement snapshots after the PO lock must not depend on a session/database default.
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      const invoice = (await client.query<MatchingInvoice>(`SELECT id,invoice_number AS "invoiceNumber",
        supplier_id AS "supplierId", purchase_order_id AS "purchaseOrderId", seller_tax_code AS "sellerTaxCode",
        currency,status,subtotal::text AS subtotal,tax_amount::text AS "taxAmount",total_amount::text AS "totalAmount"
        FROM invoices WHERE id=$1 FOR UPDATE`, [invoiceId])).rows[0];
      if (!invoice) throw new MatchingError('INVOICE_NOT_FOUND', 'Invoice not found.', 404);
      // Recheck after the invoice lock: concurrent repeat requests see the committed result.
      if ((await client.query('SELECT id FROM match_results WHERE invoice_id=$1', [invoiceId])).rowCount) {
        throw new MatchingError('MATCH_ALREADY_EXISTS', 'This invoice already has a match result.', 409);
      }
      if (invoice.status !== 'PARSED') throw new MatchingError('INVALID_INVOICE_STATE', 'Only PARSED invoices may be matched.', 409);
      const po = (await client.query<MatchingPo>(`SELECT id,po_number AS "poNumber",supplier_id AS "supplierId",
        currency,status FROM purchase_orders WHERE id=$1 FOR UPDATE`, [invoice.purchaseOrderId])).rows[0];
      if (!po) throw new MatchingError('PURCHASE_ORDER_NOT_FOUND', 'Purchase order not found.', 404);
      if (!['ISSUED', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED'].includes(po.status)) {
        throw new MatchingError('INVALID_PURCHASE_ORDER_STATE', 'Purchase order must be active.', 409);
      }
      const policy = await this.activePolicy(client, 'SHARE');
      const supplier = (await client.query<{ taxCode: string }>(
        'SELECT tax_code AS "taxCode" FROM suppliers WHERE id=$1 FOR SHARE', [po.supplierId])).rows[0];
      if (!supplier) throw new MatchingError('SUPPLIER_NOT_FOUND', 'PO supplier not found.', 404);
      const invoiceItems = (await client.query<InvoiceLine>(`SELECT id,line_number AS "lineNumber",po_item_id AS "poItemId",
        sku,description,quantity::text AS quantity,unit_price::text AS "unitPrice",tax_rate::text AS "taxRate",
        line_subtotal::text AS "lineSubtotal",tax_amount::text AS "taxAmount",line_total::text AS "lineTotal"
        FROM invoice_items WHERE invoice_id=$1 ORDER BY line_number`, [invoiceId])).rows;
      const poItems = (await client.query<PoLine>(`SELECT id,purchase_order_id AS "purchaseOrderId",sku,description,
        ordered_quantity::text AS "orderedQuantity",unit_price::text AS "unitPrice",tax_rate::text AS "taxRate"
        FROM purchase_order_items WHERE purchase_order_id=$1 ORDER BY line_number`, [po.id])).rows;
      // All availability inputs are re-read AFTER the PO lock under PostgreSQL READ COMMITTED.
      const receipts = await readReceivedQuantities(client, po.id);
      let previousInvoices;
      try { previousInvoices = await readQuantityClaims(client, po.id, invoiceId); }
      catch (error) {
        if (error instanceof QuantityClaimError) throw new MatchingError(error.code, error.message, 409);
        throw error;
      }
      await client.query("UPDATE invoices SET status='PENDING_MATCH' WHERE id=$1", [invoiceId]);
      const input: MatchingInput = { invoice, po, supplierTaxCode: supplier.taxCode, policy, invoiceItems, poItems, receipts, previousInvoices };
      const started = performance.now();
      const evaluation = evaluateMatching(input);
      const evaluationDurationMs = (performance.now() - started).toFixed(3); // instrumentation only
      const result = (await client.query<{ id: string }>(`INSERT INTO match_results(invoice_id,purchase_order_id,
        matching_policy_id,status,overall_confidence,supplier_match,currency_match,quantity_variance,price_variance,
        tax_variance,total_variance,rule_version,discrepancy_codes,policy_snapshot,evaluation_duration_ms,completed_at)
        VALUES($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,clock_timestamp()) RETURNING id`,
      [invoiceId, po.id, policy.id, evaluation.status, evaluation.supplierMatch, evaluation.currencyMatch,
        evaluation.quantityVariance, evaluation.priceVariance, evaluation.taxVariance, evaluation.totalVariance,
        evaluation.ruleVersion, evaluation.discrepancyCodes, JSON.stringify(evaluation.policySnapshot), evaluationDurationMs])).rows[0];
      const rows = JSON.stringify(evaluation.items);
      await client.query(`INSERT INTO match_result_items(match_result_id,invoice_item_id,purchase_order_item_id,
        matched_received_quantity,quantity_variance,unit_price_variance,tax_rate_variance,line_total_variance,
        semantic_confidence,status,reason_code,discrepancy_codes,details)
        SELECT $1,r."invoiceItemId",r."purchaseOrderItemId",r."matchedReceivedQuantity",r."quantityVariance",
          r."unitPriceVariance",r."taxRateVariance",r."lineTotalVariance",NULL,r.status,r."reasonCode",r."discrepancyCodes",r.details
        FROM jsonb_to_recordset($2::jsonb) AS r("invoiceItemId" uuid,"purchaseOrderItemId" uuid,
          "matchedReceivedQuantity" numeric,"quantityVariance" numeric,"unitPriceVariance" numeric,
          "taxRateVariance" numeric,"lineTotalVariance" numeric,status text,"reasonCode" text,"discrepancyCodes" text[],details jsonb)`,
      [result.id, rows]);
      await client.query(`UPDATE invoice_items ii SET po_item_id=r."purchaseOrderItemId"
        FROM jsonb_to_recordset($2::jsonb) AS r("invoiceItemId" uuid,"purchaseOrderItemId" uuid)
        WHERE ii.id=r."invoiceItemId" AND ii.invoice_id=$1 AND r."purchaseOrderItemId" IS NOT NULL`, [invoiceId, rows]);
      await client.query('UPDATE invoices SET status=$2 WHERE id=$1', [invoiceId, evaluation.invoiceStatus]);
      const metadata = {
        invoiceId, invoiceNumber: invoice.invoiceNumber, purchaseOrderId: po.id, poNumber: po.poNumber,
        resultStatus: evaluation.status, invoiceStatus: evaluation.invoiceStatus,
        policySnapshot: evaluation.policySnapshot, ruleVersion: evaluation.ruleVersion,
        discrepancyCodes: evaluation.discrepancyCodes, lineCount: evaluation.items.length,
        matchedLineCount: evaluation.items.filter(line => line.status === 'MATCHED').length,
        exceptionLineCount: evaluation.items.filter(line => line.status !== 'MATCHED').length,
        evaluationDurationMs, roles: actor.roles,
      };
      await this.audit(client, 'MATCH_RESULT', result.id, 'MATCHING_COMPLETED', actor, metadata);
      await this.audit(client, 'INVOICE', invoiceId, evaluation.invoiceStatus === 'MATCHED' ? 'INVOICE_MATCHED' : 'INVOICE_EXCEPTION',
        actor, { ...metadata, previousStatus: 'PARSED', transitions: ['PARSED', 'PENDING_MATCH', evaluation.invoiceStatus] });
      return this.readResult(client, result.id);
    });
  }
  private async readResult(client: PoolClient, id: string) {
    const result = (await client.query(`SELECT mr.id,mr.invoice_id AS "invoiceId",mr.purchase_order_id AS "purchaseOrderId",
      mr.matching_policy_id AS "matchingPolicyId",mr.status,i.status AS "invoiceStatus",
      mr.overall_confidence::text AS "overallConfidence",mr.supplier_match AS "supplierMatch",mr.currency_match AS "currencyMatch",
      mr.quantity_variance::text AS "quantityVariance",mr.price_variance::text AS "priceVariance",
      mr.tax_variance::text AS "taxVariance",mr.total_variance::text AS "totalVariance",mr.rule_version AS "ruleVersion",
      mr.discrepancy_codes AS "discrepancyCodes",mr.policy_snapshot AS "policySnapshot",
      mr.evaluation_duration_ms::text AS "evaluationDurationMs",mr.completed_at AS "completedAt",mr.created_at AS "createdAt"
      FROM match_results mr JOIN invoices i ON i.id=mr.invoice_id WHERE mr.id=$1`, [id])).rows[0];
    if (!result) throw new MatchingError('MATCH_RESULT_NOT_FOUND', 'Match result not found.', 404);
    result.items = (await client.query(`SELECT mri.id,mri.invoice_item_id AS "invoiceItemId",
      mri.purchase_order_item_id AS "purchaseOrderItemId",ii.line_number AS "lineNumber",
      mri.matched_received_quantity::text AS "matchedReceivedQuantity",mri.quantity_variance::text AS "quantityVariance",
      mri.unit_price_variance::text AS "unitPriceVariance",mri.tax_rate_variance::text AS "taxRateVariance",
      mri.line_total_variance::text AS "lineTotalVariance",mri.semantic_confidence::text AS "semanticConfidence",
      mri.status,mri.reason_code AS "reasonCode",mri.discrepancy_codes AS "discrepancyCodes",mri.details
      FROM match_result_items mri JOIN invoice_items ii ON ii.id=mri.invoice_item_id
      WHERE mri.match_result_id=$1 ORDER BY ii.line_number`, [id])).rows;
    return result;
  }
  async result(id: string) { return this.db.transaction(client => this.readResult(client, id)); }
  async invoiceResult(invoiceId: string) {
    return this.db.transaction(async client => {
      const result = await client.query<{ id: string }>('SELECT id FROM match_results WHERE invoice_id=$1', [invoiceId]);
      if (!result.rows[0]) throw new MatchingError('MATCH_RESULT_NOT_FOUND', 'Match result not found.', 404);
      return this.readResult(client, result.rows[0].id);
    });
  }
}
