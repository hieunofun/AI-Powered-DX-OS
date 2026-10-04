import { PurchaseOrderStatus } from '../domain/po-state-machine';

export interface PurchaseOrderItemEntity {
  id: string;
  purchaseOrderId: string;
  lineNumber: number;
  sku?: string | null;
  description: string;
  orderedQuantity: number;
  unitPrice: number;
  taxRate: number;
  lineSubtotal: number;
  taxAmount: number;
  lineTotal: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PurchaseOrderEntity {
  id: string;
  poNumber: string;
  supplierId: string;
  currency: string;
  status: PurchaseOrderStatus;
  orderDate: string; // YYYY-MM-DD
  expectedDeliveryDate?: string | null;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  version: number;
  cancelledAt?: Date | null;
  cancelledReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
  items?: PurchaseOrderItemEntity[];
}

export interface PaginatedResult<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
}
