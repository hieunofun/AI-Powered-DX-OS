export interface MatchingPolicy {
  readonly id: string;
  readonly policyCode: string;
  readonly quantityTolerancePercent: string;
  readonly priceTolerancePercent: string;
  readonly taxTolerancePercent: string;
  readonly totalTolerancePercent: string;
}
export interface InvoiceLine {
  readonly id: string;
  readonly lineNumber: number;
  readonly poItemId: string | null;
  readonly sku: string | null;
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly taxRate: string;
  readonly lineSubtotal: string;
  readonly taxAmount: string;
  readonly lineTotal: string;
}
export interface PoLine {
  readonly id: string;
  readonly purchaseOrderId: string;
  readonly sku: string | null;
  readonly description: string;
  readonly orderedQuantity: string;
  readonly unitPrice: string;
  readonly taxRate: string;
}
export interface MatchingInvoice {
  readonly id: string;
  readonly invoiceNumber: string;
  readonly purchaseOrderId: string;
  readonly supplierId: string;
  readonly sellerTaxCode: string | null;
  readonly currency: string;
  readonly status: string;
  readonly subtotal: string;
  readonly taxAmount: string;
  readonly totalAmount: string;
}
export interface MatchingPo {
  readonly id: string;
  readonly poNumber: string;
  readonly supplierId: string;
  readonly currency: string;
  readonly status: string;
}
export interface ReceiptQuantity {
  readonly purchaseOrderItemId: string;
  readonly status: string;
  readonly acceptedQuantity: string;
}
export interface PreviousQuantity {
  readonly purchaseOrderItemId: string;
  readonly invoiceId: string;
  readonly invoiceStatus: string;
  readonly resultStatus: string;
  readonly quantity: string;
}
export interface MatchingInput {
  readonly invoice: MatchingInvoice;
  readonly po: MatchingPo;
  readonly supplierTaxCode: string;
  readonly invoiceItems: readonly InvoiceLine[];
  readonly poItems: readonly PoLine[];
  readonly receipts: readonly ReceiptQuantity[];
  readonly previousInvoices: readonly PreviousQuantity[];
  readonly policy: MatchingPolicy;
}
