import type {} from 'multer';

export const INVOICE_STATUSES = ['RECEIVED', 'PARSED', 'PENDING_MATCH', 'MATCHED',
  'EXCEPTION', 'APPROVED', 'READY_FOR_PAYMENT', 'REJECTED', 'CANCELLED'] as const;
export type IngestionStatus = 'PENDING_UPLOAD' | 'STORED' | 'PARSED' | 'OCR_REQUIRED' | 'FAILED';
export type FileKind = 'XML' | 'PDF';

export interface CanonicalInvoiceItem {
  sku?: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  lineSubtotal: string;
  taxAmount: string;
  lineTotal: string;
}
export interface CanonicalInvoiceData {
  sellerTaxCode: string;
  buyerTaxCode: string;
  invoiceNumber: string;
  invoiceDate: string;
  currency: string;
  items: CanonicalInvoiceItem[];
  subtotal: string;
  taxAmount: string;
  totalAmount: string;
}
export interface InvoiceFile {
  id: string;
  ingestionId: string;
  fileKind: FileKind;
  objectKey: string;
  originalFilename: string;
  mediaType: string;
  sizeBytes: string;
  sha256: string;
  processingStatus: IngestionStatus;
  parseErrorCode?: string;
  parseErrorMessage?: string;
}
export interface InvoiceIngestion {
  id: string;
  purchaseOrderId: string;
  supplierId: string;
  invoiceId: string | null;
  status: IngestionStatus;
  errorCode?: string;
  errorMessage?: string;
  files?: InvoiceFile[];
}
export interface PurchaseOrderBinding {
  id: string;
  status: string;
  supplierId: string;
  taxCode: string;
  supplierStatus: string;
}
export type UploadedInvoiceFiles = { xml?: Express.Multer.File[]; pdf?: Express.Multer.File[] };
