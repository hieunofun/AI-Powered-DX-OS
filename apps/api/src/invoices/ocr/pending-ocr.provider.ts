import { Injectable } from '@nestjs/common';
import { InvoiceOcrProvider, OcrResult } from './invoice-ocr-provider';

@Injectable()
export class PendingOcrProvider implements InvoiceOcrProvider {
  async extract(_pdfBuffer: Buffer): Promise<OcrResult> {
    return { status: 'OCR_REQUIRED', reason: 'NOT_CONFIGURED' };
  }
}
