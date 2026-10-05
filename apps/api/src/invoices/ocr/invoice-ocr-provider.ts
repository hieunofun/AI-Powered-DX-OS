import { CanonicalInvoiceData } from '../interfaces/invoice.interface';

export const INVOICE_OCR_PROVIDER = Symbol('INVOICE_OCR_PROVIDER');
export type OcrResult = { status: 'OCR_REQUIRED'; reason: 'NOT_CONFIGURED' } |
  { status: 'EXTRACTED'; data: CanonicalInvoiceData };
export interface InvoiceOcrProvider { extract(pdfBuffer: Buffer): Promise<OcrResult>; }
