import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import {
  PurchaseOrderEntity,
  PurchaseOrderItemEntity,
  PaginatedResult,
  SupplierLookup,
  PurchaseOrderFulfillment,
} from './interfaces/purchase-order.interface';
import { QueryPurchaseOrderDto } from './dto/query-purchase-order.dto';
import { QuerySupplierDto } from './dto/query-supplier.dto';

@Injectable()
export class PurchaseOrdersRepository {
  constructor(private readonly db: DatabaseService) {}

  private async executeQuery<T extends QueryResultRow = any>(
    query: string,
    params?: any[],
    client?: PoolClient,
  ): Promise<QueryResult<T>> {
    if (client) {
      return client.query<T>(query, params);
    }
    return this.db.query<T>(query, params);
  }

  /**
   * Concurrency-safe, deterministic PO number generation using PostgreSQL sequence.
   * Format: PO-YYYY-XXXXXX (e.g. PO-2026-000001)
   */
  async generatePoNumber(client?: PoolClient): Promise<string> {
    const query = `
      SELECT 'PO-' || to_char(CURRENT_DATE, 'YYYY') || '-' || lpad(nextval('purchase_order_number_seq')::text, 6, '0') AS po_number
    `;
    const res = await this.executeQuery<{ po_number: string }>(query, [], client);
    return res.rows[0].po_number;
  }

  /**
   * Retrieves supplier details by ID.
   */
  async getSupplier(supplierId: string, client?: PoolClient): Promise<{ id: string; name: string; status: string } | null> {
    const query = `SELECT id, name, status FROM suppliers WHERE id = $1`;
    const res = await this.executeQuery<{ id: string; name: string; status: string }>(query, [supplierId], client);
    return res.rows[0] || null;
  }

  async findSuppliers(query: QuerySupplierDto): Promise<PaginatedResult<SupplierLookup>> {
    const { page = 1, limit = 20, search = '', id } = query;
    // Escape LIKE metacharacters: searching for '%' must not enumerate unrelated suppliers.
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    const where = `WHERE ($1::uuid IS NULL OR id = $1)
      AND (name ILIKE $2 OR supplier_code ILIKE $2 OR tax_code ILIKE $2)`;
    const count = await this.db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM suppliers ${where}`, [id ?? null, pattern],
    );
    const result = await this.db.query<SupplierLookup>(
      `SELECT id, supplier_code AS "supplierCode", tax_code AS "taxCode", name, status
       FROM suppliers ${where} ORDER BY name, id LIMIT $3 OFFSET $4`,
      [id ?? null, pattern, limit, (page - 1) * limit],
    );
    return { data: result.rows, page, limit, total: count.rows[0]?.total ?? 0 };
  }

  async findFulfillment(id: string): Promise<PurchaseOrderFulfillment[]> {
    const result = await this.db.query<PurchaseOrderFulfillment>(
      `SELECT poi.id AS "purchaseOrderItemId", poi.ordered_quantity::text AS "orderedQuantity",
         COALESCE(sum(gi.accepted_quantity) FILTER (WHERE gr.status = 'RECEIVED'), 0)::text AS "acceptedQuantity",
         COALESCE(sum(gi.rejected_quantity) FILTER (WHERE gr.status = 'RECEIVED'), 0)::text AS "rejectedQuantity"
       FROM purchase_order_items poi
       LEFT JOIN goods_receipt_items gi ON gi.purchase_order_item_id = poi.id
       LEFT JOIN goods_receipts gr ON gr.id = gi.goods_receipt_id
       WHERE poi.purchase_order_id = $1
       GROUP BY poi.id ORDER BY poi.line_number`, [id],
    );
    return result.rows;
  }

  /**
   * Finds a Purchase Order by ID, including its line items.
   * Returns exact decimal values as strings to prevent floating-point inaccuracy.
   */
  async findById(id: string, client?: PoolClient): Promise<PurchaseOrderEntity | null> {
    const poQuery = `
      SELECT id, po_number AS "poNumber", supplier_id AS "supplierId", currency, status,
             (SELECT name FROM suppliers WHERE id = supplier_id) AS "supplierName",
             (SELECT tax_code FROM suppliers WHERE id = supplier_id) AS "supplierTaxCode",
             to_char(order_date, 'YYYY-MM-DD') AS "orderDate",
             to_char(expected_delivery_date, 'YYYY-MM-DD') AS "expectedDeliveryDate",
             subtotal::text AS subtotal,
             tax_amount::text AS "taxAmount",
             total_amount::text AS "totalAmount",
             version,
             cancelled_at AS "cancelledAt",
             cancelled_reason AS "cancelledReason",
             created_at AS "createdAt",
             updated_at AS "updatedAt"
      FROM purchase_orders
      WHERE id = $1
    `;
    const poRes = await this.executeQuery<PurchaseOrderEntity>(poQuery, [id], client);
    if (poRes.rows.length === 0) {
      return null;
    }

    const po = poRes.rows[0];

    const itemsQuery = `
      SELECT id, purchase_order_id AS "purchaseOrderId", line_number AS "lineNumber",
             sku, description,
             ordered_quantity::text AS "orderedQuantity",
             unit_price::text AS "unitPrice",
             tax_rate::text AS "taxRate",
             line_subtotal::text AS "lineSubtotal",
             tax_amount::text AS "taxAmount",
             line_total::text AS "lineTotal",
             created_at AS "createdAt",
             updated_at AS "updatedAt"
      FROM purchase_order_items
      WHERE purchase_order_id = $1
      ORDER BY line_number ASC
    `;
    const itemsRes = await this.executeQuery<PurchaseOrderItemEntity>(itemsQuery, [id], client);
    po.items = itemsRes.rows;

    return po;
  }

  /**
   * Retrieves a paginated list of Purchase Orders with optional filtering.
   */
  async findAll(queryDto: QueryPurchaseOrderDto): Promise<PaginatedResult<PurchaseOrderEntity>> {
    const { page = 1, limit = 20, status, supplierId, poNumber } = queryDto;
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (status) {
      conditions.push(`status = $${paramIndex++}`);
      values.push(status);
    }
    if (supplierId) {
      conditions.push(`supplier_id = $${paramIndex++}`);
      values.push(supplierId);
    }
    if (poNumber) {
      conditions.push(`po_number ILIKE $${paramIndex++}`);
      values.push(`%${poNumber}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countQuery = `SELECT count(*)::int AS total FROM purchase_orders ${whereClause}`;
    const countRes = await this.db.query<{ total: number }>(countQuery, values);
    const total = countRes.rows[0]?.total || 0;

    const selectQuery = `
      SELECT id, po_number AS "poNumber", supplier_id AS "supplierId", currency, status,
             (SELECT name FROM suppliers WHERE id = supplier_id) AS "supplierName",
             (SELECT tax_code FROM suppliers WHERE id = supplier_id) AS "supplierTaxCode",
             to_char(order_date, 'YYYY-MM-DD') AS "orderDate",
             to_char(expected_delivery_date, 'YYYY-MM-DD') AS "expectedDeliveryDate",
             subtotal::text AS subtotal,
             tax_amount::text AS "taxAmount",
             total_amount::text AS "totalAmount",
             version,
             cancelled_at AS "cancelledAt",
             cancelled_reason AS "cancelledReason",
             created_at AS "createdAt",
             updated_at AS "updatedAt"
      FROM purchase_orders
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    const selectValues = [...values, limit, offset];
    const selectRes = await this.db.query<PurchaseOrderEntity>(selectQuery, selectValues);

    return {
      data: selectRes.rows,
      page,
      limit,
      total,
    };
  }

  /**
   * Creates a Purchase Order, its line items, and an audit record in a single atomic transaction.
   * Conforms strictly to Issue #2 audit_records schema:
   * (id, entity_type, entity_id, event_type, actor_subject, payload_hash, metadata, created_at)
   */
  async createPO(
    poData: {
      poNumber: string;
      supplierId: string;
      currency: string;
      orderDate: string;
      expectedDeliveryDate?: string | null;
      subtotal: string;
      taxAmount: string;
      totalAmount: string;
    },
    itemsData: Array<{
      lineNumber: number;
      sku?: string | null;
      description: string;
      orderedQuantity: string;
      unitPrice: string;
      taxRate: string;
      lineSubtotal: string;
      taxAmount: string;
      lineTotal: string;
    }>,
    actor: { subject: string; roles: string[] },
  ): Promise<PurchaseOrderEntity> {
    return this.db.transaction(async (client) => {
      // 1. Insert Purchase Order Header
      const insertPoQuery = `
        INSERT INTO purchase_orders (
          po_number, supplier_id, currency, status, order_date, expected_delivery_date,
          subtotal, tax_amount, total_amount, version
        ) VALUES (
          $1, $2, $3, 'DRAFT', $4, $5, $6, $7, $8, 1
        ) RETURNING id, po_number AS "poNumber", supplier_id AS "supplierId", currency, status,
                    to_char(order_date, 'YYYY-MM-DD') AS "orderDate",
                    to_char(expected_delivery_date, 'YYYY-MM-DD') AS "expectedDeliveryDate",
                    subtotal::text AS subtotal,
                    tax_amount::text AS "taxAmount",
                    total_amount::text AS "totalAmount",
                    version, created_at AS "createdAt", updated_at AS "updatedAt"
      `;
      const poRes = await client.query<PurchaseOrderEntity>(insertPoQuery, [
        poData.poNumber,
        poData.supplierId,
        poData.currency,
        poData.orderDate,
        poData.expectedDeliveryDate || null,
        poData.subtotal,
        poData.taxAmount,
        poData.totalAmount,
      ]);
      const createdPo = poRes.rows[0];

      // 2. Insert Line Items
      const insertedItems: PurchaseOrderItemEntity[] = [];
      for (const item of itemsData) {
        const insertItemQuery = `
          INSERT INTO purchase_order_items (
            purchase_order_id, line_number, sku, description,
            ordered_quantity, unit_price, tax_rate,
            line_subtotal, tax_amount, line_total
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
          ) RETURNING id, purchase_order_id AS "purchaseOrderId", line_number AS "lineNumber",
                      sku, description,
                      ordered_quantity::text AS "orderedQuantity",
                      unit_price::text AS "unitPrice",
                      tax_rate::text AS "taxRate",
                      line_subtotal::text AS "lineSubtotal",
                      tax_amount::text AS "taxAmount",
                      line_total::text AS "lineTotal",
                      created_at AS "createdAt", updated_at AS "updatedAt"
        `;
        const itemRes = await client.query<PurchaseOrderItemEntity>(insertItemQuery, [
          createdPo.id,
          item.lineNumber,
          item.sku || null,
          item.description,
          item.orderedQuantity,
          item.unitPrice,
          item.taxRate,
          item.lineSubtotal,
          item.taxAmount,
          item.lineTotal,
        ]);
        insertedItems.push(itemRes.rows[0]);
      }
      createdPo.items = insertedItems;

      // 3. Insert Audit Record (conforming strictly to Issue #2 audit_records schema)
      const auditQuery = `
        INSERT INTO audit_records (
          entity_type, entity_id, event_type, actor_subject, metadata
        ) VALUES (
          'PURCHASE_ORDER', $1, 'PO_CREATED', $2, $3::jsonb
        )
      `;
      await client.query(auditQuery, [
        createdPo.id,
        actor.subject,
        JSON.stringify({
          actorRoles: actor.roles,
          poNumber: createdPo.poNumber,
          status: createdPo.status,
          totalAmount: createdPo.totalAmount,
          itemCount: insertedItems.length,
          version: createdPo.version,
        }),
      ]);

      return createdPo;
    });
  }

  /**
   * Updates an existing DRAFT Purchase Order using optimistic locking.
   * Conforms strictly to Issue #2 audit_records schema.
   */
  async updateDraftPO(
    id: string,
    expectedVersion: number,
    poData: {
      supplierId?: string;
      currency?: string;
      orderDate?: string;
      expectedDeliveryDate?: string | null;
      subtotal?: string;
      taxAmount?: string;
      totalAmount?: string;
    },
    itemsData?: Array<{
      lineNumber: number;
      sku?: string | null;
      description: string;
      orderedQuantity: string;
      unitPrice: string;
      taxRate: string;
      lineSubtotal: string;
      taxAmount: string;
      lineTotal: string;
    }>,
    actor?: { subject: string; roles: string[] },
  ): Promise<PurchaseOrderEntity> {
    return this.db.transaction(async (client) => {
      // 1. Fetch current PO with lock check
      const current = await this.findById(id, client);
      if (!current) {
        throw new NotFoundException(`Purchase Order with ID '${id}' not found`);
      }

      // Check version before running update to report clean conflict
      if (current.version !== expectedVersion) {
        throw new ConflictException(
          `Optimistic lock conflict: Purchase Order version is ${current.version}, expected ${expectedVersion}. Please reload and retry.`,
        );
      }

      // 2. Perform optimistic atomic update
      const updateFields: string[] = ['version = version + 1'];
      const values: any[] = [id, expectedVersion];
      let pIdx = 3;

      if (poData.supplierId !== undefined) {
        updateFields.push(`supplier_id = $${pIdx++}`);
        values.push(poData.supplierId);
      }
      if (poData.currency !== undefined) {
        updateFields.push(`currency = $${pIdx++}`);
        values.push(poData.currency);
      }
      if (poData.orderDate !== undefined) {
        updateFields.push(`order_date = $${pIdx++}`);
        values.push(poData.orderDate);
      }
      if (poData.expectedDeliveryDate !== undefined) {
        updateFields.push(`expected_delivery_date = $${pIdx++}`);
        values.push(poData.expectedDeliveryDate);
      }
      if (poData.subtotal !== undefined) {
        updateFields.push(`subtotal = $${pIdx++}`);
        values.push(poData.subtotal);
      }
      if (poData.taxAmount !== undefined) {
        updateFields.push(`tax_amount = $${pIdx++}`);
        values.push(poData.taxAmount);
      }
      if (poData.totalAmount !== undefined) {
        updateFields.push(`total_amount = $${pIdx++}`);
        values.push(poData.totalAmount);
      }

      const updateQuery = `
        UPDATE purchase_orders
        SET ${updateFields.join(', ')}
        WHERE id = $1 AND version = $2
        RETURNING id, version
      `;
      const updateRes = await client.query(updateQuery, values);
      if (updateRes.rowCount === 0) {
        throw new ConflictException(
          `Optimistic lock conflict: Purchase Order was updated concurrently by another transaction.`,
        );
      }

      // 3. If items provided, replace existing lines
      if (itemsData && itemsData.length > 0) {
        await client.query(`DELETE FROM purchase_order_items WHERE purchase_order_id = $1`, [id]);
        for (const item of itemsData) {
          const insertItemQuery = `
            INSERT INTO purchase_order_items (
              purchase_order_id, line_number, sku, description,
              ordered_quantity, unit_price, tax_rate,
              line_subtotal, tax_amount, line_total
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
            )
          `;
          await client.query(insertItemQuery, [
            id,
            item.lineNumber,
            item.sku || null,
            item.description,
            item.orderedQuantity,
            item.unitPrice,
            item.taxRate,
            item.lineSubtotal,
            item.taxAmount,
            item.lineTotal,
          ]);
        }
      }

      // 4. Audit Record (conforming strictly to Issue #2 audit_records schema)
      if (actor) {
        const auditQuery = `
          INSERT INTO audit_records (
            entity_type, entity_id, event_type, actor_subject, metadata
          ) VALUES (
            'PURCHASE_ORDER', $1, 'PO_UPDATED', $2, $3::jsonb
          )
        `;
        await client.query(auditQuery, [
          id,
          actor.subject,
          JSON.stringify({
            actorRoles: actor.roles,
            previousVersion: expectedVersion,
            newVersion: expectedVersion + 1,
            updatedFields: Object.keys(poData),
          }),
        ]);
      }

      return (await this.findById(id, client))!;
    });
  }

  /**
   * Issues a DRAFT Purchase Order using optimistic locking.
   * Conforms strictly to Issue #2 audit_records schema.
   */
  async issuePO(
    id: string,
    expectedVersion: number,
    actor: { subject: string; roles: string[] },
  ): Promise<PurchaseOrderEntity> {
    return this.db.transaction(async (client) => {
      const current = await this.findById(id, client);
      if (!current) {
        throw new NotFoundException(`Purchase Order with ID '${id}' not found`);
      }

      if (current.version !== expectedVersion) {
        throw new ConflictException(
          `Optimistic lock conflict: Purchase Order version is ${current.version}, expected ${expectedVersion}.`,
        );
      }

      const updateQuery = `
        UPDATE purchase_orders
        SET status = 'ISSUED',
            version = version + 1
        WHERE id = $1 AND version = $2 AND status = 'DRAFT'
        RETURNING id, version, status
      `;
      const updateRes = await client.query(updateQuery, [id, expectedVersion]);
      if (updateRes.rowCount === 0) {
        throw new ConflictException(
          `Could not issue Purchase Order: Stale version or status is no longer 'DRAFT'.`,
        );
      }

      // Audit Record (conforming strictly to Issue #2 audit_records schema)
      const auditQuery = `
        INSERT INTO audit_records (
          entity_type, entity_id, event_type, actor_subject, metadata
        ) VALUES (
          'PURCHASE_ORDER', $1, 'PO_ISSUED', $2, $3::jsonb
        )
      `;
      await client.query(auditQuery, [
        id,
        actor.subject,
        JSON.stringify({
          actorRoles: actor.roles,
          previousStatus: 'DRAFT',
          newStatus: 'ISSUED',
          version: expectedVersion + 1,
        }),
      ]);

      return (await this.findById(id, client))!;
    });
  }

  /**
   * Cancels a DRAFT or ISSUED Purchase Order with a mandatory reason.
   * Conforms strictly to Issue #2 audit_records schema.
   */
  async cancelPO(
    id: string,
    expectedVersion: number,
    reason: string,
    actor: { subject: string; roles: string[] },
  ): Promise<PurchaseOrderEntity> {
    return this.db.transaction(async (client) => {
      const current = await this.findById(id, client);
      if (!current) {
        throw new NotFoundException(`Purchase Order with ID '${id}' not found`);
      }

      if (current.version !== expectedVersion) {
        throw new ConflictException(
          `Optimistic lock conflict: Purchase Order version is ${current.version}, expected ${expectedVersion}.`,
        );
      }

      const updateQuery = `
        UPDATE purchase_orders
        SET status = 'CANCELLED',
            cancelled_at = CURRENT_TIMESTAMP,
            cancelled_reason = $3,
            version = version + 1
        WHERE id = $1 AND version = $2 AND status IN ('DRAFT', 'ISSUED')
        RETURNING id, version, status
      `;
      const updateRes = await client.query(updateQuery, [id, expectedVersion, reason]);
      if (updateRes.rowCount === 0) {
        throw new ConflictException(
          `Could not cancel Purchase Order: Stale version or order is not in a cancellable status ('DRAFT' or 'ISSUED').`,
        );
      }

      // Audit Record (conforming strictly to Issue #2 audit_records schema)
      const auditQuery = `
        INSERT INTO audit_records (
          entity_type, entity_id, event_type, actor_subject, metadata
        ) VALUES (
          'PURCHASE_ORDER', $1, 'PO_CANCELLED', $2, $3::jsonb
        )
      `;
      await client.query(auditQuery, [
        id,
        actor.subject,
        JSON.stringify({
          actorRoles: actor.roles,
          previousStatus: current.status,
          newStatus: 'CANCELLED',
          reason,
          version: expectedVersion + 1,
        }),
      ]);

      return (await this.findById(id, client))!;
    });
  }
}
