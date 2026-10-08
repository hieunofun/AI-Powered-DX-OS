import { GrnStatus } from '../domain/grn-state-machine';

export interface GoodsReceiptItemEntity {
  id: string;
  goodsReceiptId: string;
  purchaseOrderItemId: string;
  lineNumber: number;
  lotNumber?: string | null;
  receivedQuantity: string;
  acceptedQuantity: string;
  rejectedQuantity: string;
  damageNote?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GoodsReceiptEntity {
  id: string;
  grnNumber: string;
  purchaseOrderId: string;
  poNumber?: string;
  receivedAt: string;
  status: GrnStatus;
  referenceNote?: string | null;
  cancelledAt?: Date | null;
  cancelledReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
  items?: GoodsReceiptItemEntity[];
}

export interface GoodsReceiptPolicyEntity {
  id: string;
  policyCode: string;
  overDeliveryTolerancePercent: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CumulativeAcceptedPoItem {
  purchaseOrderItemId: string;
  cumulativeAccepted: string;
}
