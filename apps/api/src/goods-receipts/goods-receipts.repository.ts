import { Injectable, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { PoolClient, QueryResult } from 'pg';
import Decimal from 'decimal.js';
import { DatabaseService } from '../database/database.service';
import {
  GoodsReceiptEntity,
  GoodsReceiptItemEntity,
  GoodsReceiptPolicyEntity,
} from './interfaces/goods-receipt.interface';
import { GrnStatus } from './domain/grn-state-machine';
import { PurchaseOrderStatus } from '../purchase-orders/domain/po-state-machine';
import { FulfillmentCalculator } from './domain/fulfillment-calculator';
import { QueryGoodsReceiptDto } from './dto/query-goods-receipt.dto';
import { PaginatedResult } from '../purchase-orders/interfaces/purchase-order.interface';

@Injectable()
export class GoodsReceiptsRepository {
  constructor(private readonly db: DatabaseService) {}

  private async executeQuery<T>(query: string, params: any[] = [], client?: PoolClient): Promise<QueryResult<T>> {
    if (client) {
      return client.query<T>(query, params);
    }
    return this.db.query<T>(query, params);
  }

  /**
   * Concurrency-safe, deterministic GRN number generation using PostgreSQL sequence.
   * Format: GRN-YYYY-XXXXXX (e.g. GRN-2026-000001)
   */
  async generateGrnNumber(client?: PoolClient): Promise<string> {
    const query = `
      SELECT 'GRN-' || to_char(CURRENT_DATE, 'YYYY') || '-' || lpad(nextval('goods_receipt_number_seq')::text, 6, '0') AS grn_number
    `;
    const res = await this.executeQuery<{ grn_number: string }>(query, [], client);
    return res.rows[0].grn_number;
  }

  /**
   * Retrieves the currently active warehouse over-delivery policy.
   */
  async getActivePolicy(client?: PoolClient): Promise<GoodsReceiptPolicyEntity> {
    const query = `
      SELECT id, policy_code AS "policyCode",
             over_delivery_tolerance_percent::text AS "overDeliveryTolerancePercent",
             is_active AS "isActive",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM goods_receipt_policies
      WHERE is_active = true
      LIMIT 1
    `;
    const res = await this.executeQuery<GoodsReceiptPolicyEntity>(query, [], client);
    if (!res.rows[0]) {
      // Fallback default if not seeded
      return {
        id: '00000000-0000-0000-0000-000000000000',
        policyCode: 'DEFAULT',
        overDeliveryTolerancePercent: '0.00',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }
    return res.rows[0];
  }

  /**
   * Updates the active over-delivery tolerance policy percentage inside an atomic transaction.
   * Locks the active policy FOR UPDATE, captures previous tolerance, updates tolerance,
   * inserts GRN_POLICY_UPDATED into audit_records, and commits.
   * If any step fails, rolls back completely.
   */
  async updateActivePolicy(
    tolerancePercent: string,
    actor?: { subject?: string; roles?: string[] },
    existingClient?: PoolClient,
  ): Promise<GoodsReceiptPolicyEntity> {
    const client = existingClient || (await this.db.getClient());
    const isOwnerOfClient = !existingClient;

    try {
      if (isOwnerOfClient) {
        await client.query('BEGIN');
      }

      // 1. SELECT active policy FOR UPDATE and capture previous tolerance
      const selectRes = await client.query<{
        id: string;
        policy_code: string;
        over_delivery_tolerance_percent: string;
      }>(
        `SELECT id, policy_code, over_delivery_tolerance_percent::text
         FROM goods_receipt_policies
         WHERE is_active = true
         FOR UPDATE`,
      );

      if (!selectRes.rows[0]) {
        throw new NotFoundException('Active goods receipt policy not found');
      }

      const activePolicyRow = selectRes.rows[0];
      const previousTolerancePercent = activePolicyRow.over_delivery_tolerance_percent;

      // 2. UPDATE policy
      const updateQuery = `
        UPDATE goods_receipt_policies
        SET over_delivery_tolerance_percent = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING id, policy_code AS "policyCode",
                  over_delivery_tolerance_percent::text AS "overDeliveryTolerancePercent",
                  is_active AS "isActive",
                  created_at AS "createdAt", updated_at AS "updatedAt"
      `;
      const updateRes = await client.query<GoodsReceiptPolicyEntity>(updateQuery, [
        tolerancePercent,
        activePolicyRow.id,
      ]);
      const updatedPolicy = updateRes.rows[0];

      // 3. INSERT audit_records event: GRN_POLICY_UPDATED
      const auditQuery = `
        INSERT INTO audit_records (
          entity_type, entity_id, event_type, actor_subject, metadata
        ) VALUES (
          'GOODS_RECEIPT_POLICY', $1, 'GRN_POLICY_UPDATED', $2, $3::jsonb
        )
      `;
      await client.query(auditQuery, [
        updatedPolicy.id,
        actor?.subject || null,
        JSON.stringify({
          policyCode: updatedPolicy.policyCode,
          previousTolerancePercent,
          newTolerancePercent: updatedPolicy.overDeliveryTolerancePercent,
          previousTolerance: previousTolerancePercent,
          newTolerance: updatedPolicy.overDeliveryTolerancePercent,
          roles: actor?.roles || [],
        }),
      ]);

      if (isOwnerOfClient) {
        await client.query('COMMIT');
      }

      return updatedPolicy;
    } catch (error) {
      if (isOwnerOfClient) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      if (isOwnerOfClient) {
        client.release();
      }
    }
  }

  /**
   * Retrieves a Purchase Order header and its line items.
   */
  async getPurchaseOrder(
    poId: string,
    client?: PoolClient,
  ): Promise<{
    id: string;
    poNumber: string;
    status: PurchaseOrderStatus;
    version: number;
    items: Array<{ id: string; lineNumber: number; orderedQuantity: string; description: string }>;
  } | null> {
    const poQuery = `
      SELECT id, po_number AS "poNumber", status, version
      FROM purchase_orders
      WHERE id = $1
    `;
    const poRes = await this.executeQuery<{
      id: string;
      poNumber: string;
      status: PurchaseOrderStatus;
      version: number;
    }>(poQuery, [poId], client);

    if (!poRes.rows[0]) {
      return null;
    }

    const itemsQuery = `
      SELECT id, line_number AS "lineNumber", ordered_quantity::text AS "orderedQuantity", description
      FROM purchase_order_items
      WHERE purchase_order_id = $1
      ORDER BY line_number ASC
    `;
    const itemsRes = await this.executeQuery<{
      id: string;
      lineNumber: number;
      orderedQuantity: string;
      description: string;
    }>(itemsQuery, [poId], client);

    return {
      ...poRes.rows[0],
      items: itemsRes.rows,
    };
  }

  /**
   * Queries cumulative accepted quantities for PO items across all finalized (RECEIVED) GRNs.
   */
  async getCumulativeAcceptedByPo(
    purchaseOrderId: string,
    client?: PoolClient,
    excludeGrnId?: string,
  ): Promise<Map<string, Decimal>> {
    const query = `
      SELECT gri.purchase_order_item_id AS "purchaseOrderItemId",
             COALESCE(SUM(gri.accepted_quantity), 0)::text AS "cumulativeAccepted"
      FROM goods_receipts gr
      JOIN goods_receipt_items gri ON gr.id = gri.goods_receipt_id
      WHERE gr.purchase_order_id = $1
        AND gr.status = 'RECEIVED'
        AND ($2::uuid IS NULL OR gr.id != $2::uuid)
      GROUP BY gri.purchase_order_item_id
    `;
    const res = await this.executeQuery<{
      purchaseOrderItemId: string;
      cumulativeAccepted: string;
    }>(query, [purchaseOrderId, excludeGrnId || null], client);

    const map = new Map<string, Decimal>();
    for (const row of res.rows) {
      map.set(row.purchaseOrderItemId, new Decimal(row.cumulativeAccepted));
    }
    return map;
  }

  /**
   * Atomically persists a new Goods Receipt in DRAFT status with child items and audit record.
   */
  async createGRN(
    grnHeader: {
      grnNumber: string;
      purchaseOrderId: string;
      receivedAt?: string;
      referenceNote?: string;
    },
    itemsData: Array<{
      purchaseOrderItemId: string;
      lotNumber?: string | null;
      receivedQuantity: string;
      acceptedQuantity: string;
      rejectedQuantity: string;
      damageNote?: string | null;
    }>,
    actor: { subject?: string; roles?: string[] },
  ): Promise<GoodsReceiptEntity> {
    const client = await this.db.getClient();
    try {
      await client.query('BEGIN');

      // 1. Insert Goods Receipt header
      const insertGrnQuery = `
        INSERT INTO goods_receipts (
          grn_number, purchase_order_id, received_at, status, reference_note
        ) VALUES (
          $1, $2, COALESCE($3::timestamptz, CURRENT_TIMESTAMP), 'DRAFT', $4
        )
        RETURNING id, grn_number AS "grnNumber", purchase_order_id AS "purchaseOrderId",
                  to_char(received_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "receivedAt",
                  status, reference_note AS "referenceNote",
                  cancelled_at AS "cancelledAt", cancelled_reason AS "cancelledReason",
                  created_at AS "createdAt", updated_at AS "updatedAt"
      `;
      const grnRes = await client.query<GoodsReceiptEntity>(insertGrnQuery, [
        grnHeader.grnNumber,
        grnHeader.purchaseOrderId,
        grnHeader.receivedAt || null,
        grnHeader.referenceNote || null,
      ]);
      const createdGrn = grnRes.rows[0];

      // 2. Insert Goods Receipt item lines
      const insertItemQuery = `
        INSERT INTO goods_receipt_items (
          goods_receipt_id, purchase_order_item_id, line_number, lot_number,
          received_quantity, accepted_quantity, rejected_quantity, damage_note
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8
        )
        RETURNING id, goods_receipt_id AS "goodsReceiptId",
                  purchase_order_item_id AS "purchaseOrderItemId",
                  line_number AS "lineNumber", lot_number AS "lotNumber",
                  received_quantity::text AS "receivedQuantity",
                  accepted_quantity::text AS "acceptedQuantity",
                  rejected_quantity::text AS "rejectedQuantity",
                  damage_note AS "damageNote",
                  created_at AS "createdAt", updated_at AS "updatedAt"
      `;

      const insertedItems: GoodsReceiptItemEntity[] = [];
      let lineNum = 1;
      for (const item of itemsData) {
        const trimmedLot = item.lotNumber !== undefined && item.lotNumber !== null ? String(item.lotNumber).trim() : null;
        const normalizedLot = trimmedLot && trimmedLot.length > 0 ? trimmedLot : null;

        const trimmedDamage = item.damageNote !== undefined && item.damageNote !== null ? String(item.damageNote).trim() : null;
        const normalizedDamage = trimmedDamage && trimmedDamage.length > 0 ? trimmedDamage : null;

        const itemRes = await client.query<GoodsReceiptItemEntity>(insertItemQuery, [
          createdGrn.id,
          item.purchaseOrderItemId,
          lineNum++,
          normalizedLot,
          item.receivedQuantity,
          item.acceptedQuantity,
          item.rejectedQuantity,
          normalizedDamage,
        ]);
        insertedItems.push(itemRes.rows[0]);
      }
      createdGrn.items = insertedItems;

      // 3. Write Audit Record
      const auditQuery = `
        INSERT INTO audit_records (
          entity_type, entity_id, event_type, actor_subject, metadata
        ) VALUES (
          'GOODS_RECEIPT', $1, 'GRN_CREATED', $2, $3::jsonb
        )
      `;
      await client.query(auditQuery, [
        createdGrn.id,
        actor.subject || null,
        JSON.stringify({
          actorRoles: actor.roles || [],
          grnNumber: createdGrn.grnNumber,
          purchaseOrderId: createdGrn.purchaseOrderId,
          status: GrnStatus.DRAFT,
          lineCount: insertedItems.length,
        }),
      ]);

      await client.query('COMMIT');
      return createdGrn;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Finds a Goods Receipt by ID, including its line items.
   */
  async findById(id: string, client?: PoolClient): Promise<GoodsReceiptEntity | null> {
    const grnQuery = `
      SELECT id, grn_number AS "grnNumber", purchase_order_id AS "purchaseOrderId",
             to_char(received_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "receivedAt",
             status, reference_note AS "referenceNote",
             cancelled_at AS "cancelledAt", cancelled_reason AS "cancelledReason",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM goods_receipts
      WHERE id = $1
    `;
    const grnRes = await this.executeQuery<GoodsReceiptEntity>(grnQuery, [id], client);
    if (!grnRes.rows[0]) {
      return null;
    }

    const grn = grnRes.rows[0];
    const itemsQuery = `
      SELECT id, goods_receipt_id AS "goodsReceiptId",
             purchase_order_item_id AS "purchaseOrderItemId",
             line_number AS "lineNumber", lot_number AS "lotNumber",
             received_quantity::text AS "receivedQuantity",
             accepted_quantity::text AS "acceptedQuantity",
             rejected_quantity::text AS "rejectedQuantity",
             damage_note AS "damageNote",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM goods_receipt_items
      WHERE goods_receipt_id = $1
      ORDER BY line_number ASC
    `;
    const itemsRes = await this.executeQuery<GoodsReceiptItemEntity>(itemsQuery, [id], client);
    grn.items = itemsRes.rows;
    return grn;
  }

  /**
   * Updates a DRAFT Goods Receipt and atomically replaces line items if provided.
   */
  async updateDraftGRN(
    id: string,
    updateData: { receivedAt?: string; referenceNote?: string },
    itemsData?: Array<{
      purchaseOrderItemId: string;
      lotNumber?: string | null;
      receivedQuantity: string;
      acceptedQuantity: string;
      rejectedQuantity: string;
      damageNote?: string | null;
    }>,
    actor?: { subject?: string; roles?: string[] },
  ): Promise<GoodsReceiptEntity | null> {
    const client = await this.db.getClient();
    try {
      await client.query('BEGIN');

      // 1. Lock GRN for update
      const lockRes = await client.query<{ id: string; status: GrnStatus; grn_number: string }>(
        `SELECT id, status, grn_number FROM goods_receipts WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!lockRes.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      if (lockRes.rows[0].status !== GrnStatus.DRAFT) {
        throw new ConflictException(
          `Cannot modify Goods Receipt in '${lockRes.rows[0].status}' status. Only 'DRAFT' receipts can be edited.`,
        );
      }

      // 2. Update GRN header fields
      const updateHeaderQuery = `
        UPDATE goods_receipts
        SET received_at = COALESCE($2::timestamptz, received_at),
            reference_note = COALESCE($3, reference_note),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING id, grn_number AS "grnNumber", purchase_order_id AS "purchaseOrderId",
                  to_char(received_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "receivedAt",
                  status, reference_note AS "referenceNote",
                  cancelled_at AS "cancelledAt", cancelled_reason AS "cancelledReason",
                  created_at AS "createdAt", updated_at AS "updatedAt"
      `;
      const grnRes = await client.query<GoodsReceiptEntity>(updateHeaderQuery, [
        id,
        updateData.receivedAt || null,
        updateData.referenceNote !== undefined ? updateData.referenceNote : null,
      ]);
      const updatedGrn = grnRes.rows[0];

      // 3. Atomically replace line items if provided
      if (itemsData && itemsData.length > 0) {
        await client.query(`DELETE FROM goods_receipt_items WHERE goods_receipt_id = $1`, [id]);

        const insertItemQuery = `
          INSERT INTO goods_receipt_items (
            goods_receipt_id, purchase_order_item_id, line_number, lot_number,
            received_quantity, accepted_quantity, rejected_quantity, damage_note
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8
          )
          RETURNING id, goods_receipt_id AS "goodsReceiptId",
                    purchase_order_item_id AS "purchaseOrderItemId",
                    line_number AS "lineNumber", lot_number AS "lotNumber",
                    received_quantity::text AS "receivedQuantity",
                    accepted_quantity::text AS "acceptedQuantity",
                    rejected_quantity::text AS "rejectedQuantity",
                    damage_note AS "damageNote",
                    created_at AS "createdAt", updated_at AS "updatedAt"
        `;
        const insertedItems: GoodsReceiptItemEntity[] = [];
        let lineNum = 1;
        for (const item of itemsData) {
          const trimmedLot = item.lotNumber !== undefined && item.lotNumber !== null ? String(item.lotNumber).trim() : null;
          const normalizedLot = trimmedLot && trimmedLot.length > 0 ? trimmedLot : null;

          const trimmedDamage = item.damageNote !== undefined && item.damageNote !== null ? String(item.damageNote).trim() : null;
          const normalizedDamage = trimmedDamage && trimmedDamage.length > 0 ? trimmedDamage : null;

          const itemRes = await client.query<GoodsReceiptItemEntity>(insertItemQuery, [
            id,
            item.purchaseOrderItemId,
            lineNum++,
            normalizedLot,
            item.receivedQuantity,
            item.acceptedQuantity,
            item.rejectedQuantity,
            normalizedDamage,
          ]);
          insertedItems.push(itemRes.rows[0]);
        }
        updatedGrn.items = insertedItems;
      } else {
        const currentItems = await client.query<GoodsReceiptItemEntity>(
          `SELECT id, goods_receipt_id AS "goodsReceiptId",
                  purchase_order_item_id AS "purchaseOrderItemId",
                  line_number AS "lineNumber", lot_number AS "lotNumber",
                  received_quantity::text AS "receivedQuantity",
                  accepted_quantity::text AS "acceptedQuantity",
                  rejected_quantity::text AS "rejectedQuantity",
                  damage_note AS "damageNote",
                  created_at AS "createdAt", updated_at AS "updatedAt"
           FROM goods_receipt_items WHERE goods_receipt_id = $1 ORDER BY line_number`,
          [id],
        );
        updatedGrn.items = currentItems.rows;
      }

      // 4. Insert Audit Record
      const auditQuery = `
        INSERT INTO audit_records (
          entity_type, entity_id, event_type, actor_subject, metadata
        ) VALUES (
          'GOODS_RECEIPT', $1, 'GRN_UPDATED', $2, $3::jsonb
        )
      `;
      await client.query(auditQuery, [
        id,
        actor?.subject || null,
        JSON.stringify({
          actorRoles: actor?.roles || [],
          grnNumber: updatedGrn.grnNumber,
          lineCount: updatedGrn.items?.length || 0,
        }),
      ]);

      await client.query('COMMIT');
      return updatedGrn;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Finalizes inspection and receives a Goods Receipt.
   *
   * Executes inside ONE PostgreSQL transaction with row-level locking on PO:
   * 1. Lock GRN (FOR UPDATE) and confirm status is DRAFT
   * 2. Lock parent PO (FOR UPDATE) and confirm status is ISSUED or PARTIALLY_RECEIVED
   * 3. Validate every item belongs to PO and fulfills exact conservation (accepted + rejected === received)
   * 4. Re-read cumulative accepted quantities inside transaction lock
   * 5. Enforce over-delivery threshold
   * 6. Transition GRN status to RECEIVED
   * 7. Recalculate PO fulfillment status (ISSUED -> PARTIALLY_RECEIVED -> FULLY_RECEIVED)
   * 8. Update PO status & increment PO version
   * 9. Write audit records (GRN_RECEIVED, and PO_FULFILLMENT_UPDATED if PO changed)
   * 10. COMMIT
   */
  async receiveGRN(
    id: string,
    actor: { subject?: string; roles?: string[] },
  ): Promise<{ grn: GoodsReceiptEntity; poStatus: PurchaseOrderStatus; poVersion: number }> {
    const client = await this.db.getClient();
    try {
      await client.query('BEGIN');

      // 1. Lock GRN and check DRAFT status
      const grnLockRes = await client.query<{
        id: string;
        grn_number: string;
        purchase_order_id: string;
        status: GrnStatus;
      }>(
        `SELECT id, grn_number, purchase_order_id, status FROM goods_receipts WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!grnLockRes.rows[0]) {
        throw new NotFoundException(`Goods Receipt '${id}' not found`);
      }
      const grnRow = grnLockRes.rows[0];
      if (grnRow.status !== GrnStatus.DRAFT) {
        throw new ConflictException(
          `Cannot receive Goods Receipt in '${grnRow.status}' status. Only 'DRAFT' receipts can be received.`,
        );
      }

      // 2. Lock parent PO
      const poLockRes = await client.query<{
        id: string;
        po_number: string;
        status: PurchaseOrderStatus;
        version: number;
      }>(
        `SELECT id, po_number, status, version FROM purchase_orders WHERE id = $1 FOR UPDATE`,
        [grnRow.purchase_order_id],
      );
      if (!poLockRes.rows[0]) {
        throw new NotFoundException(`Parent Purchase Order '${grnRow.purchase_order_id}' not found`);
      }
      const poRow = poLockRes.rows[0];

      if (
        poRow.status !== PurchaseOrderStatus.ISSUED &&
        poRow.status !== PurchaseOrderStatus.PARTIALLY_RECEIVED
      ) {
        throw new ConflictException(
          `Cannot receive goods against Purchase Order '${poRow.po_number}' in '${poRow.status}' status. PO must be in ISSUED or PARTIALLY_RECEIVED status.`,
        );
      }

      // 3. Fetch PO items
      const poItemsRes = await client.query<{
        id: string;
        line_number: number;
        ordered_quantity: string;
        description: string;
      }>(
        `SELECT id, line_number, ordered_quantity::text AS ordered_quantity, description
         FROM purchase_order_items WHERE purchase_order_id = $1 ORDER BY line_number`,
        [poRow.id],
      );
      const poItems = poItemsRes.rows.map((row) => ({
        id: row.id,
        orderedQuantity: row.ordered_quantity,
      }));

      // 4. Fetch GRN line items and validate inspection classification
      const grnItemsRes = await client.query<GoodsReceiptItemEntity>(
        `SELECT id, goods_receipt_id AS "goodsReceiptId",
                purchase_order_item_id AS "purchaseOrderItemId",
                line_number AS "lineNumber", lot_number AS "lotNumber",
                received_quantity::text AS "receivedQuantity",
                accepted_quantity::text AS "acceptedQuantity",
                rejected_quantity::text AS "rejectedQuantity",
                damage_note AS "damageNote",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM goods_receipt_items WHERE goods_receipt_id = $1 ORDER BY line_number`,
        [id],
      );
      const grnItems = grnItemsRes.rows;
      if (grnItems.length === 0) {
        throw new BadRequestException('Cannot receive a Goods Receipt with zero item lines');
      }

      for (const item of grnItems) {
        try {
          FulfillmentCalculator.validateLineQuantities(
            {
              receivedQuantity: item.receivedQuantity,
              acceptedQuantity: item.acceptedQuantity,
              rejectedQuantity: item.rejectedQuantity,
              damageNote: item.damageNote,
            },
            true, // isFinalizing = true requires exact accepted + rejected === received
          );
        } catch (err: any) {
          throw new ConflictException(err.message);
        }
      }

      // 5. Fetch active over-delivery policy
      const policyRes = await client.query<{ over_delivery_tolerance_percent: string }>(
        `SELECT over_delivery_tolerance_percent::text FROM goods_receipt_policies WHERE is_active = true LIMIT 1`,
      );
      const tolerancePercent = policyRes.rows[0]?.over_delivery_tolerance_percent || '0.00';

      // 6. Re-read cumulative accepted quantities inside locked transaction
      const prevAcceptedMap = await this.getCumulativeAcceptedByPo(poRow.id, client, id);

      // 7. Enforce over-delivery threshold
      const overDeliveryResult = FulfillmentCalculator.checkOverDelivery(
        poItems,
        prevAcceptedMap,
        grnItems.map((it) => ({
          purchaseOrderItemId: it.purchaseOrderItemId,
          acceptedQuantity: it.acceptedQuantity,
        })),
        tolerancePercent,
      );

      if (overDeliveryResult.isOverDelivered) {
        throw new ConflictException(
          `Over-delivery violation on PO item ${overDeliveryResult.poItemId}: ` +
            `Ordered: ${overDeliveryResult.orderedQuantity}, Previously Accepted: ${overDeliveryResult.previousAccepted}, ` +
            `Current GRN Accepted: ${overDeliveryResult.currentAccepted}, Proposed Total Accepted: ${overDeliveryResult.proposedAccepted} ` +
            `exceeds Allowed Accepted: ${overDeliveryResult.allowedAccepted} (Tolerance: ${overDeliveryResult.tolerancePercent}%)`,
        );
      }

      // 8. Transition GRN status to RECEIVED
      const updateGrnRes = await client.query<GoodsReceiptEntity>(
        `UPDATE goods_receipts
         SET status = 'RECEIVED', updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING id, grn_number AS "grnNumber", purchase_order_id AS "purchaseOrderId",
                   to_char(received_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "receivedAt",
                   status, reference_note AS "referenceNote",
                   cancelled_at AS "cancelledAt", cancelled_reason AS "cancelledReason",
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [id],
      );
      const receivedGrn = updateGrnRes.rows[0];
      receivedGrn.items = grnItems;

      // 9. Recalculate PO fulfillment status including newly accepted items
      const newCumulativeMap = new Map<string, Decimal>(prevAcceptedMap);
      for (const item of grnItems) {
        const prev = newCumulativeMap.get(item.purchaseOrderItemId) ?? new Decimal(0);
        newCumulativeMap.set(item.purchaseOrderItemId, prev.plus(new Decimal(item.acceptedQuantity)));
      }

      const newPoStatus = FulfillmentCalculator.calculatePoStatus(poItems, newCumulativeMap);

      // 10. Update PO status & increment PO version
      const updatePoRes = await client.query<{ status: PurchaseOrderStatus; version: number }>(
        `UPDATE purchase_orders
         SET status = $1, version = version + 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING status, version`,
        [newPoStatus, poRow.id],
      );
      const updatedPo = updatePoRes.rows[0];

      // 11. Write audit records
      const grnAuditQuery = `
        INSERT INTO audit_records (
          entity_type, entity_id, event_type, actor_subject, metadata
        ) VALUES (
          'GOODS_RECEIPT', $1, 'GRN_RECEIVED', $2, $3::jsonb
        )
      `;
      await client.query(grnAuditQuery, [
        id,
        actor.subject || null,
        JSON.stringify({
          actorRoles: actor.roles || [],
          grnNumber: receivedGrn.grnNumber,
          purchaseOrderId: receivedGrn.purchaseOrderId,
          previousStatus: GrnStatus.DRAFT,
          newStatus: GrnStatus.RECEIVED,
          lineCount: grnItems.length,
          poStatus: updatedPo.status,
          poVersion: updatedPo.version,
        }),
      ]);

      if (poRow.status !== updatedPo.status) {
        const poAuditQuery = `
          INSERT INTO audit_records (
            entity_type, entity_id, event_type, actor_subject, metadata
          ) VALUES (
            'PURCHASE_ORDER', $1, 'PO_FULFILLMENT_UPDATED', $2, $3::jsonb
          )
        `;
        await client.query(poAuditQuery, [
          poRow.id,
          actor.subject || null,
          JSON.stringify({
            actorRoles: actor.roles || [],
            poNumber: poRow.po_number,
            triggerGrnId: id,
            triggerGrnNumber: receivedGrn.grnNumber,
            previousStatus: poRow.status,
            newStatus: updatedPo.status,
            previousVersion: poRow.version,
            newVersion: updatedPo.version,
          }),
        ]);
      }

      await client.query('COMMIT');
      return {
        grn: receivedGrn,
        poStatus: updatedPo.status,
        poVersion: updatedPo.version,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Cancels a Goods Receipt.
   * If cancelling a RECEIVED GRN, atomically reverses PO fulfillment status inside transaction lock.
   */
  async cancelGRN(
    id: string,
    reason: string,
    actor: { subject?: string; roles?: string[] },
  ): Promise<{ grn: GoodsReceiptEntity; poStatus?: PurchaseOrderStatus; poVersion?: number }> {
    const client = await this.db.getClient();
    try {
      await client.query('BEGIN');

      // 1. Lock GRN
      const grnLockRes = await client.query<{
        id: string;
        grn_number: string;
        purchase_order_id: string;
        status: GrnStatus;
      }>(
        `SELECT id, grn_number, purchase_order_id, status FROM goods_receipts WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!grnLockRes.rows[0]) {
        throw new NotFoundException(`Goods Receipt '${id}' not found`);
      }
      const grnRow = grnLockRes.rows[0];
      if (grnRow.status === GrnStatus.CANCELLED) {
        throw new ConflictException(`Goods Receipt '${grnRow.grn_number}' is already CANCELLED`);
      }

      // 2. Lock parent PO
      const poLockRes = await client.query<{
        id: string;
        po_number: string;
        status: PurchaseOrderStatus;
        version: number;
      }>(
        `SELECT id, po_number, status, version FROM purchase_orders WHERE id = $1 FOR UPDATE`,
        [grnRow.purchase_order_id],
      );
      if (!poLockRes.rows[0]) {
        throw new NotFoundException(`Parent Purchase Order '${grnRow.purchase_order_id}' not found`);
      }
      const poRow = poLockRes.rows[0];

      // Terminal PO protection: RECEIVED GRN cannot be cancelled if parent PO is CLOSED or CANCELLED
      if (
        grnRow.status === GrnStatus.RECEIVED &&
        (poRow.status === PurchaseOrderStatus.CLOSED || poRow.status === PurchaseOrderStatus.CANCELLED)
      ) {
        throw new ConflictException(
          `Cannot cancel Goods Receipt '${grnRow.grn_number}' because parent Purchase Order '${poRow.po_number}' is in terminal status '${poRow.status}'.`,
        );
      }

      // 3. Update GRN status to CANCELLED
      const updateGrnRes = await client.query<GoodsReceiptEntity>(
        `UPDATE goods_receipts
         SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP, cancelled_reason = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING id, grn_number AS "grnNumber", purchase_order_id AS "purchaseOrderId",
                   to_char(received_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "receivedAt",
                   status, reference_note AS "referenceNote",
                   cancelled_at AS "cancelledAt", cancelled_reason AS "cancelledReason",
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [id, reason],
      );
      const cancelledGrn = updateGrnRes.rows[0];

      let updatedPoStatus = poRow.status;
      let updatedPoVersion = poRow.version;

      // 4. If previous status was RECEIVED, recalculate cumulative fulfillment without this GRN
      if (grnRow.status === GrnStatus.RECEIVED) {
        const poItemsRes = await client.query<{
          id: string;
          ordered_quantity: string;
        }>(
          `SELECT id, ordered_quantity::text AS ordered_quantity
           FROM purchase_order_items WHERE purchase_order_id = $1`,
          [poRow.id],
        );
        const poItems = poItemsRes.rows.map((row) => ({
          id: row.id,
          orderedQuantity: row.ordered_quantity,
        }));

        // Cumulative accepted excluding this cancelled GRN
        const remainingCumulativeMap = await this.getCumulativeAcceptedByPo(poRow.id, client, id);
        const recalculatedPoStatus = FulfillmentCalculator.calculatePoStatus(
          poItems,
          remainingCumulativeMap,
        );

        if (poRow.status !== recalculatedPoStatus) {
          const updatePoRes = await client.query<{ status: PurchaseOrderStatus; version: number }>(
            `UPDATE purchase_orders
             SET status = $1, version = version + 1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2
             RETURNING status, version`,
            [recalculatedPoStatus, poRow.id],
          );
          updatedPoStatus = updatePoRes.rows[0].status;
          updatedPoVersion = updatePoRes.rows[0].version;

          const poAuditQuery = `
            INSERT INTO audit_records (
              entity_type, entity_id, event_type, actor_subject, metadata
            ) VALUES (
              'PURCHASE_ORDER', $1, 'PO_FULFILLMENT_UPDATED', $2, $3::jsonb
            )
          `;
          await client.query(poAuditQuery, [
            poRow.id,
            actor.subject || null,
            JSON.stringify({
              actorRoles: actor.roles || [],
              poNumber: poRow.po_number,
              triggerGrnId: id,
              triggerGrnNumber: cancelledGrn.grnNumber,
              action: 'GRN_CANCELLED_REVERSAL',
              previousStatus: poRow.status,
              newStatus: updatedPoStatus,
              previousVersion: poRow.version,
              newVersion: updatedPoVersion,
            }),
          ]);
        }
      }

      // 5. Write audit record for GRN cancellation
      const auditQuery = `
        INSERT INTO audit_records (
          entity_type, entity_id, event_type, actor_subject, metadata
        ) VALUES (
          'GOODS_RECEIPT', $1, 'GRN_CANCELLED', $2, $3::jsonb
        )
      `;
      await client.query(auditQuery, [
        id,
        actor.subject || null,
        JSON.stringify({
          actorRoles: actor.roles || [],
          grnNumber: cancelledGrn.grnNumber,
          previousStatus: grnRow.status,
          newStatus: GrnStatus.CANCELLED,
          cancelledReason: reason,
          poStatus: updatedPoStatus,
          poVersion: updatedPoVersion,
        }),
      ]);

      await client.query('COMMIT');
      return {
        grn: cancelledGrn,
        poStatus: updatedPoStatus,
        poVersion: updatedPoVersion,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Retrieves a paginated list of Goods Receipts matching query filters.
   */
  async findAll(query: QueryGoodsReceiptDto): Promise<PaginatedResult<GoodsReceiptEntity>> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (query.purchaseOrderId) {
      conditions.push(`gr.purchase_order_id = $${paramIndex++}`);
      params.push(query.purchaseOrderId);
    }

    if (query.status) {
      conditions.push(`gr.status = $${paramIndex++}`);
      params.push(query.status);
    }

    if (query.grnNumber) {
      conditions.push(`gr.grn_number ILIKE $${paramIndex++}`);
      params.push(`%${query.grnNumber}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countQuery = `SELECT count(*) FROM goods_receipts gr ${whereClause}`;
    const countRes = await this.db.query<{ count: string }>(countQuery, params);
    const total = parseInt(countRes.rows[0]?.count || '0', 10);

    const page = query.page || 1;
    const limit = query.limit || 20;
    const offset = (page - 1) * limit;

    const dataQuery = `
      SELECT gr.id, gr.grn_number AS "grnNumber", gr.purchase_order_id AS "purchaseOrderId",
             to_char(gr.received_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "receivedAt",
             gr.status, gr.reference_note AS "referenceNote",
             gr.cancelled_at AS "cancelledAt", gr.cancelled_reason AS "cancelledReason",
             gr.created_at AS "createdAt", gr.updated_at AS "updatedAt"
      FROM goods_receipts gr
      ${whereClause}
      ORDER BY gr.created_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    params.push(limit, offset);
    const dataRes = await this.db.query<GoodsReceiptEntity>(dataQuery, params);

    return {
      data: dataRes.rows,
      page,
      limit,
      total,
    };
  }
}
