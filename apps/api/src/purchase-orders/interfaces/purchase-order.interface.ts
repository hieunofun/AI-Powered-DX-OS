import { PurchaseOrderStatus } from '../domain/po-state-machine';

export interface PurchaseOrderItemEntity {
  id: string;
  purchaseOrderId: string;
  lineNumber: number;
  sku?: string | null;
  description: string;
  orderedQuantity: string;
  unitPrice: string;
  taxRate: string;
  lineSubtotal: string;
  taxAmount: string;
  lineTotal: string;
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
  subtotal: string;
  taxAmount: string;
  totalAmount: string;
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
