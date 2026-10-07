import Decimal from 'decimal.js';
import { PreviousQuantity, ReceiptQuantity } from '../interfaces/matching.interface';
export const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP });
export function acceptedQuantities(receipts: readonly ReceiptQuantity[]): Map<string, Decimal> {
  const sums = new Map<string, Decimal>();
  for (const row of receipts) {
    if (row.status === 'RECEIVED') sums.set(row.purchaseOrderItemId,
      new D(sums.get(row.purchaseOrderItemId) ?? '0').plus(row.acceptedQuantity));
  }
  return sums;
}
export function consumedQuantities(previous: readonly PreviousQuantity[], currentInvoiceId: string): Map<string, Decimal> {
  const sums = new Map<string, Decimal>();
  for (const row of previous) {
    // The repository supplies effective claims: pending allocations, durable approval
    // reservations, or cleared invoice quantities. Original matching status is evidence,
    // not the authority for releasing a financially approved exception's quantity.
    if (row.invoiceId !== currentInvoiceId &&
        ['MATCHED', 'EXCEPTION', 'APPROVED', 'READY_FOR_PAYMENT'].includes(row.invoiceStatus)) {
      sums.set(row.purchaseOrderItemId, new D(sums.get(row.purchaseOrderItemId) ?? '0').plus(row.quantity));
    }
  }
  return sums;
}
