import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { InvoicesRepository } from './invoices.repository';
import { MinioStorageService } from '../storage/minio-storage.service';
import { InvoiceXmlParserService } from './parsers/invoice-xml-parser.service';
import { INVOICE_OCR_PROVIDER, InvoiceOcrProvider } from './ocr/invoice-ocr-provider';
import { InvoiceFile, UploadedInvoiceFiles } from './interfaces/invoice.interface';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { objectKey, sha256, validateFile } from './domain/file-validation';
import { IngestionError } from './domain/ingestion-error';
import { normalizeInvoiceNumber, normalizeTaxCode } from './domain/normalization';

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);
  constructor(private readonly repository: InvoicesRepository, private readonly storage: MinioStorageService,
    private readonly parser: InvoiceXmlParserService,
    @Inject(INVOICE_OCR_PROVIDER) private readonly ocr: InvoiceOcrProvider) {}

  async ingest(poId: string, upload: UploadedInvoiceFiles, user: AuthenticatedUser) {
    if (!upload || (!upload.xml?.length && !upload.pdf?.length)) {
      throw new IngestionError('FILE_REQUIRED', 'At least one XML or PDF file is required.', 400);
    }
    const incoming = [upload.xml?.[0], upload.pdf?.[0]].filter(Boolean);
    if ((upload.xml?.length || 0) > 1 || (upload.pdf?.length || 0) > 1 ||
        Object.keys(upload).some(key => !['xml', 'pdf'].includes(key))) {
      throw new IngestionError('INVALID_UPLOAD_FIELDS', 'Only one XML and one PDF file are permitted.', 400);
    }
    incoming.forEach(file => validateFile(file, file.fieldname === 'xml' ? 'XML' : 'PDF'));
    const id = randomUUID();
    const files: InvoiceFile[] = incoming.map(file => {
      const fileId = randomUUID(), kind = file.fieldname === 'xml' ? 'XML' : 'PDF';
      return { id: fileId, ingestionId: id, fileKind: kind, objectKey: objectKey(id, fileId, kind),
        originalFilename: Array.from(file.originalname).filter(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127).join('').slice(0, 255) || 'invoice',
        mediaType: kind === 'XML' ? 'application/xml' : 'application/pdf', sizeBytes: String(file.buffer.length),
        sha256: sha256(file.buffer), processingStatus: 'PENDING_UPLOAD' };
    });
    const binding = await this.repository.start(id, poId, files, user.sub);
    let stage: 'UPLOAD' | 'DATABASE' | 'PARSE' = 'UPLOAD';
    try {
      for (const [index, file] of files.entries()) {
        stage = 'UPLOAD';
        await this.storage.upload(file.objectKey, incoming[index].buffer, file.mediaType, file.sha256);
        stage = 'DATABASE';
        await this.repository.fileStored(file, user.sub);
      }
      await this.repository.stored(id);
      if (!upload.xml?.length) {
        stage = 'PARSE';
        const result = await this.ocr.extract(upload.pdf[0].buffer);
        // A real provider requires a separately validated persistence path in a later issue.
        if (result.status !== 'OCR_REQUIRED') throw new IngestionError('UNSUPPORTED_OCR_RESULT', 'Structured OCR persistence is not enabled.');
        stage = 'DATABASE';
        await this.repository.ocrRequired(id, user.sub);
        return { ingestionId: id, invoiceId: null, status: 'OCR_REQUIRED' as const, reason: result.reason,
          files: files.map(file => ({ ...file, processingStatus: 'OCR_REQUIRED' as const })) };
      }
      stage = 'PARSE';
      const data = this.parser.parse(upload.xml[0].buffer);
      if (!normalizeTaxCode(binding.taxCode) || normalizeTaxCode(data.sellerTaxCode) !== normalizeTaxCode(binding.taxCode)) {
        throw new IngestionError('SELLER_TAX_CODE_MISMATCH', 'XML seller tax code does not match the PO supplier.');
      }
      const normalized = normalizeInvoiceNumber(data.invoiceNumber);
      stage = 'DATABASE';
      const invoiceId = await this.repository.persist(id, poId, binding.supplierId, data, normalized, files, user.sub);
      return { ingestionId: id, invoiceId, status: 'PARSED' as const,
        files: files.map(file => ({ ...file, processingStatus: file.fileKind === 'XML' ? 'PARSED' as const : 'STORED' as const })) };
    } catch (cause) {
      const error = cause instanceof IngestionError ? cause : stage === 'UPLOAD'
        ? new IngestionError('UPLOAD_FAILED', 'Raw file storage or integrity verification failed.', 503)
        : new IngestionError('PERSISTENCE_FAILED', 'Invoice ingestion could not be completed.', 503);
      try { await this.repository.fail(id, error, user.sub); } catch {
        this.logger.error(`Ingestion ${id} requires reconciliation; failure state could not be persisted.`);
      }
      throw error.withIngestion(id);
    }
  }
}
