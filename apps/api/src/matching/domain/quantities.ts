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
    if (row.invoiceId !== currentInvoiceId && row.resultStatus === 'PASSED' &&
        ['MATCHED', 'APPROVED', 'READY_FOR_PAYMENT'].includes(row.invoiceStatus)) {
      sums.set(row.purchaseOrderItemId, new D(sums.get(row.purchaseOrderItemId) ?? '0').plus(row.quantity));
    }
  }
  return sums;
}
