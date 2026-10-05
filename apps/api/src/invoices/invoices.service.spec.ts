import { readFileSync } from 'fs';
import { resolve } from 'path';
import { InvoicesService } from './invoices.service';
import { InvoicesRepository } from './invoices.repository';
import { MinioStorageService } from '../storage/minio-storage.service';
import { InvoiceXmlParserService } from './parsers/invoice-xml-parser.service';
import { SmartProcureInvoiceV1Parser } from './parsers/smartprocure-invoice-v1.parser';
import { MatbaoInvoiceV200Parser } from './parsers/matbao-invoice-v200.parser';
import { PendingOcrProvider } from './ocr/pending-ocr.provider';
import { IngestionError } from './domain/ingestion-error';

describe('Ingestion lifecycle (repository and storage mocked)', () => {
  const bytes = readFileSync(resolve(__dirname, '../../../../infra/invoice/fixtures/valid-vn-einvoice.xml'));
  const xml = { fieldname: 'xml', buffer: bytes, originalname: '../../invoice.xml', mimetype: 'application/xml' } as Express.Multer.File;
  const pdf = { fieldname: 'pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF'), originalname: 'invoice.pdf', mimetype: 'application/pdf' } as Express.Multer.File;
  const user = { sub: 'accountant-sub', username: 'accountant.demo', roles: ['accountant'] };
  let repository: any, storage: any, service: InvoicesService, events: string[];
  beforeEach(() => {
    events = [];
    repository = {
      start: jest.fn(async () => { events.push('PENDING_UPLOAD'); return { supplierId: 'supplier', taxCode: '0101234567001' }; }),
      fileStored: jest.fn(async () => { events.push('FILE_STORED'); }),
      stored: jest.fn(async () => { events.push('STORED'); }),
      persist: jest.fn(async () => { events.push('PARSED'); return 'invoice-id'; }),
      ocrRequired: jest.fn(async () => { events.push('OCR_REQUIRED'); }),
      fail: jest.fn(async () => { events.push('FAILED'); }),
    };
    storage = { upload: jest.fn(async () => { events.push('UPLOAD'); }) };
    service = new InvoicesService(repository as InvoicesRepository, storage as MinioStorageService,
      new InvoiceXmlParserService(new SmartProcureInvoiceV1Parser(), new MatbaoInvoiceV200Parser()), new PendingOcrProvider());
  });
  it('moves pending -> stored -> parsed with PO-derived supplier and safe key', async () => {
    const result = await service.ingest('po', { xml: [xml] }, user);
    expect(result.status).toBe('PARSED');
    expect(events).toEqual(['PENDING_UPLOAD', 'UPLOAD', 'FILE_STORED', 'STORED', 'PARSED']);
    expect(repository.persist.mock.calls[0][2]).toBe('supplier');
    expect(repository.persist.mock.calls[0][4]).toBe('INV001');
    expect(result.files[0].objectKey).not.toContain('invoice.xml');
  });
  it('PDF fallback creates no structured invoice', async () => {
    const result = await service.ingest('po', { pdf: [pdf] }, user);
    expect(result).toMatchObject({ status: 'OCR_REQUIRED', invoiceId: null, reason: 'NOT_CONFIGURED' });
    expect(repository.persist).not.toHaveBeenCalled();
    expect(events).toEqual(['PENDING_UPLOAD', 'UPLOAD', 'FILE_STORED', 'STORED', 'OCR_REQUIRED']);
  });
  it('attaches PDF to the XML ingestion without a second invoice', async () => {
    const result = await service.ingest('po', { xml: [xml], pdf: [pdf] }, user);
    expect(result.files.map(f => f.processingStatus)).toEqual(['PARSED', 'STORED']);
    expect(repository.persist).toHaveBeenCalledTimes(1);
    expect(storage.upload).toHaveBeenCalledTimes(2);
  });
  it('retains trace on malformed XML', async () => {
    await expect(service.ingest('po', { xml: [{ ...xml, buffer: Buffer.from('<bad>') }] }, user)).rejects.toMatchObject({ errorCode: 'MALFORMED_XML' });
    expect(events[events.length - 1]).toBe('FAILED'); expect(repository.persist).not.toHaveBeenCalled();
  });
  it('rejects seller mismatch after archival', async () => {
    repository.start.mockResolvedValue({ supplierId: 'supplier', taxCode: 'other' });
    await expect(service.ingest('po', { xml: [xml] }, user)).rejects.toMatchObject({ errorCode: 'SELLER_TAX_CODE_MISMATCH' });
    expect(repository.persist).not.toHaveBeenCalled(); expect(storage.upload).toHaveBeenCalled();
  });
  it('sanitizes storage failures and marks failed', async () => {
    storage.upload.mockRejectedValue(new Error('credential /secret/path'));
    await expect(service.ingest('po', { xml: [xml] }, user)).rejects.toMatchObject({ errorCode: 'UPLOAD_FAILED' });
    expect(JSON.stringify(repository.fail.mock.calls)).not.toContain('/secret/path');
    expect(repository.persist).not.toHaveBeenCalled();
  });
  it('preserves duplicate conflict and failure audit path', async () => {
    repository.persist.mockRejectedValue(new IngestionError('DUPLICATE_INVOICE', 'Duplicate invoice.', 409));
    await expect(service.ingest('po', { xml: [xml] }, user)).rejects.toMatchObject({ errorCode: 'DUPLICATE_INVOICE' });
    expect(repository.fail).toHaveBeenCalled();
  });
  it('marks unexpected DB failure without leaking internals', async () => {
    repository.persist.mockRejectedValue(new Error('SQL internals'));
    await expect(service.ingest('po', { xml: [xml] }, user)).rejects.toMatchObject({ errorCode: 'PERSISTENCE_FAILED' });
    expect(repository.fail).toHaveBeenCalled();
  });
});
