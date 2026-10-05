import { MatchingInput, InvoiceLine } from '../../src/matching/interfaces/matching.interface';
import { D } from '../../src/matching/domain/quantities';
export function line(overrides: Partial<InvoiceLine> = {}): InvoiceLine {
  const values = { id: 'line-1', lineNumber: 1, poItemId: null, sku: 'SKU-1', description: 'HP 85A',
    quantity: '100.0000', unitPrice: '100.0000', taxRate: '0.1000', ...overrides };
  const subtotal = new D(values.quantity).times(values.unitPrice).toDecimalPlaces(2);
  const tax = subtotal.times(values.taxRate).toDecimalPlaces(2);
  return { ...values, lineSubtotal: subtotal.toFixed(2), taxAmount: tax.toFixed(2),
    lineTotal: subtotal.plus(tax).toFixed(2), ...overrides };
}
export function fixture(overrides: Partial<MatchingInput> = {}): MatchingInput {
  const invoiceItems = overrides.invoiceItems ?? [line()];
  return {
    invoice: { id: 'invoice-1', invoiceNumber: 'INV-1', purchaseOrderId: 'po-1', supplierId: 'supplier-1',
      sellerTaxCode: '0101234567-001', currency: 'VND', status: 'PARSED',
      subtotal: invoiceItems.reduce((sum, item) => sum.plus(item.lineSubtotal), new D(0)).toFixed(2),
      taxAmount: invoiceItems.reduce((sum, item) => sum.plus(item.taxAmount), new D(0)).toFixed(2),
      totalAmount: invoiceItems.reduce((sum, item) => sum.plus(item.lineTotal), new D(0)).toFixed(2) },
    po: { id: 'po-1', poNumber: 'PO-1', supplierId: 'supplier-1', currency: 'VND', status: 'FULLY_RECEIVED' },
    supplierTaxCode: '0101234567001', invoiceItems,
    poItems: [{ id: 'po-item-1', purchaseOrderId: 'po-1', sku: 'SKU-1', description: 'HP 85A',
      orderedQuantity: '100.0000', unitPrice: '100.0000', taxRate: '0.1000' }],
    receipts: [{ purchaseOrderItemId: 'po-item-1', status: 'RECEIVED', acceptedQuantity: '100.0000' }],
    previousInvoices: [], policy: { id: 'policy-1', policyCode: 'MATCH_DEFAULT', quantityTolerancePercent: '0.00',
      priceTolerancePercent: '1.00', taxTolerancePercent: '0.00', totalTolerancePercent: '0.00' },
    ...overrides,
  };
}
