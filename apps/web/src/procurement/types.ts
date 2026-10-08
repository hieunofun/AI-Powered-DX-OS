export type PoStatus = 'DRAFT' | 'ISSUED' | 'PARTIALLY_RECEIVED' | 'FULLY_RECEIVED' | 'CLOSED' | 'CANCELLED';
export type GrnStatus = 'DRAFT' | 'RECEIVED' | 'CANCELLED';
export interface PageResult<T> { data: T[]; page: number; limit: number; total: number }
export interface Supplier {
  id: string; name: string; supplierCode: string; taxCode: string;
  status: 'ACTIVE' | 'INACTIVE' | 'BLOCKED';
}
export interface PoLineInput {
  sku: string; description: string; orderedQuantity: string; unitPrice: string; taxRate: string;
}
export interface PoLine extends PoLineInput {
  id: string; lineNumber: number; lineSubtotal: string; taxAmount: string; lineTotal: string;
}
export interface PurchaseOrder {
  id: string; poNumber: string; supplierId: string; supplierName?: string; supplierTaxCode?: string;
  currency: string; status: PoStatus; orderDate: string; expectedDeliveryDate: string | null;
  subtotal: string; taxAmount: string; totalAmount: string; version: number;
  cancelledReason: string | null; items?: PoLine[];
}
export interface PoInput {
  supplierId: string; currency: string; orderDate: string; expectedDeliveryDate?: string;
  items: PoLineInput[];
}
export interface GrnLineInput {
  purchaseOrderItemId: string; receivedQuantity: string; acceptedQuantity: string;
  rejectedQuantity: string; lotNumber: string; damageNote: string;
}
export interface GrnLine extends GrnLineInput { id: string; lineNumber: number }
export interface GoodsReceipt {
  id: string; grnNumber: string; purchaseOrderId: string; status: GrnStatus;
  poNumber?: string;
  receivedAt: string; referenceNote: string | null; cancelledReason: string | null;
  items?: GrnLine[];
}
export interface GrnInput {
  purchaseOrderId: string; receivedAt: string; referenceNote: string; items: GrnLineInput[];
}
export interface Fulfillment {
  purchaseOrderItemId: string; orderedQuantity: string; acceptedQuantity: string; rejectedQuantity: string;
}
