import { PoolClient } from 'pg';
import { D, acceptedQuantities, consumedQuantities } from './domain/quantities';
import { PreviousQuantity, ReceiptQuantity } from './interfaces/matching.interface';

export class QuantityClaimError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

// Call after locking the parent PO under READ COMMITTED. No matching evidence is
// rewritten: workflow's durable approving intent itself holds the stronger claim.
export async function readQuantityClaims(client: PoolClient, poId: string, excludeInvoiceId: string | null) {
  const rows = (await client.query<Omit<PreviousQuantity, 'purchaseOrderItemId'> & { purchaseOrderItemId: string | null }>(`
    SELECT mri.purchase_order_item_id AS "purchaseOrderItemId", i.id AS "invoiceId",
      i.status AS "invoiceStatus", mr.status AS "resultStatus",
      SUM(CASE WHEN i.status='EXCEPTION' AND NOT EXISTS (
        SELECT 1 FROM approval_cases c JOIN workflow_operations op ON op.approval_case_id=c.id
        WHERE c.invoice_id=i.id AND c.status IN ('STARTING','PENDING','FAILED')
          AND op.operation='COMPLETE' AND op.payload->>'action' IN ('APPROVE','APPROVE_WITH_ADJUSTMENT')
          AND op.status IN ('PENDING','FAILED','APPLIED')
      ) THEN LEAST(ii.quantity, COALESCE(mri.matched_received_quantity,0)) ELSE ii.quantity END)::text AS quantity
    FROM invoices i LEFT JOIN match_results mr ON mr.invoice_id=i.id
    JOIN invoice_items ii ON ii.invoice_id=i.id
    LEFT JOIN match_result_items mri ON mri.match_result_id=mr.id AND mri.invoice_item_id=ii.id
    WHERE i.purchase_order_id=$1 AND i.id IS DISTINCT FROM $2::uuid
      AND i.status IN ('MATCHED','EXCEPTION','APPROVED','READY_FOR_PAYMENT')
      AND NOT EXISTS (SELECT 1 FROM approval_cases c WHERE c.invoice_id=i.id
        AND c.status IN ('REJECTED','CREDIT_NOTE_REQUESTED'))
    GROUP BY mri.purchase_order_item_id,i.id,i.status,mr.status`, [poId, excludeInvoiceId])).rows;
  const claims: PreviousQuantity[] = [];
  for (const row of rows) {
    const quantity = new D(row.quantity);
    if (!quantity.isFinite() || quantity.lt(0)) throw new QuantityClaimError('INVALID_QUANTITY_CLAIM', 'A prior invoice has invalid quantity evidence.');
    if (quantity.isZero()) continue;
    if (!row.purchaseOrderItemId) throw new QuantityClaimError('UNRESOLVED_QUANTITY_CLAIM', 'A prior active invoice has quantity without a resolved PO item. Operator review is required.');
    claims.push({ ...row, purchaseOrderItemId: row.purchaseOrderItemId });
  }
  return claims;
}

export async function readReceivedQuantities(client: PoolClient, poId: string, excludeReceiptId: string | null = null) {
  return (await client.query<ReceiptQuantity>(`
    SELECT gri.purchase_order_item_id AS "purchaseOrderItemId", gr.status,
      SUM(gri.accepted_quantity)::text AS "acceptedQuantity"
    FROM goods_receipts gr JOIN goods_receipt_items gri ON gri.goods_receipt_id=gr.id
    WHERE gr.purchase_order_id=$1 AND gr.status='RECEIVED' AND gr.id IS DISTINCT FROM $2::uuid
    GROUP BY gri.purchase_order_item_id,gr.status`, [poId, excludeReceiptId])).rows;
}

export async function assertInvoiceQuantityAvailable(client: PoolClient, invoiceId: string, poId: string) {
  const match = (await client.query<{ policy: { quantityTolerancePercent?: string } }>(
    'SELECT policy_snapshot AS policy FROM match_results WHERE invoice_id=$1', [invoiceId])).rows[0];
  const tolerance = match?.policy?.quantityTolerancePercent;
  if (typeof tolerance !== 'string' || !/^\d+(\.\d+)?$/.test(tolerance)) {
    throw new QuantityClaimError('INVALID_QUANTITY_POLICY', 'The original matching quantity policy is missing. Operator review is required.');
  }
  const lines = (await client.query<{ itemId: string | null; quantity: string; ordered: string | null }>(`
    SELECT mri.purchase_order_item_id AS "itemId", ii.quantity::text AS quantity,
      poi.ordered_quantity::text AS ordered
    FROM invoice_items ii
    LEFT JOIN match_results mr ON mr.invoice_id=ii.invoice_id
    LEFT JOIN match_result_items mri ON mri.match_result_id=mr.id AND mri.invoice_item_id=ii.id
    LEFT JOIN purchase_order_items poi ON poi.id=mri.purchase_order_item_id AND poi.purchase_order_id=$2
    WHERE ii.invoice_id=$1 ORDER BY ii.line_number`, [invoiceId, poId])).rows;
  if (!lines.length || lines.some(line => !line.itemId || line.ordered === null)) {
    throw new QuantityClaimError('UNRESOLVED_INVOICE_QUANTITY', 'Resolve every invoice line to a PO item before approving it.');
  }
  const received = acceptedQuantities(await readReceivedQuantities(client, poId));
  const claimed = consumedQuantities(await readQuantityClaims(client, poId, invoiceId), invoiceId);
  const groups = new Map<string, { quantity: InstanceType<typeof D>; ordered: InstanceType<typeof D> }>();
  for (const line of lines) {
    const quantity = new D(line.quantity), ordered = new D(line.ordered);
    if (!quantity.isFinite() || quantity.lte(0) || !ordered.isFinite() || ordered.lte(0)) {
      throw new QuantityClaimError('INVALID_INVOICE_QUANTITY', 'Invoice quantity evidence must be finite and positive.');
    }
    const existing = groups.get(line.itemId);
    groups.set(line.itemId, { quantity: quantity.plus(existing?.quantity ?? 0), ordered });
  }
  for (const [itemId, group] of groups) {
    const previous = claimed.get(itemId) ?? new D(0);
    const poAllowed = group.ordered.times(new D(1).plus(new D(tolerance).div(100)));
    const available = D.max(0, D.min(new D(received.get(itemId) ?? 0).minus(previous), poAllowed.minus(previous)));
    if (group.quantity.gt(available)) {
      throw new QuantityClaimError('INSUFFICIENT_RECEIVED_QUANTITY', 'Invoice quantity exceeds currently received or ordered quantity after other active reservations. Reject, request a credit note, or correct the receipt evidence before approval.');
    }
  }
}
