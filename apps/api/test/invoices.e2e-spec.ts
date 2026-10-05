import { Test } from '@nestjs/testing';
import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { InvoicesRepository } from '../src/invoices/invoices.repository';
import { MinioStorageService } from '../src/storage/minio-storage.service';

describe('Invoice multipart API (auth, repository and storage mocked)', () => {
  let app: INestApplication;
  const po = randomUUID(), id = randomUUID();
  const xml = readFileSync(resolve(__dirname, '../../../infra/invoice/fixtures/valid-vn-einvoice.xml'));
  const repo = {
    start: jest.fn(async () => ({ supplierId: randomUUID(), taxCode: '0101234567001' })),
    fileStored: jest.fn(), stored: jest.fn(), persist: jest.fn(async () => id), ocrRequired: jest.fn(), fail: jest.fn(),
    list: jest.fn(async query => ({ data: [], ...query, total: 0 })), invoice: jest.fn(async () => ({ id })),
    files: jest.fn(async () => []), ingestion: jest.fn(async () => ({ id, status: 'OCR_REQUIRED' })),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuthService).useValue({ verifyToken: async token => {
        if (!['accountant', 'admin', 'warehouse', 'buyer', 'finance_manager'].includes(token)) throw new UnauthorizedException();
        return { sub: `sub-${token}`, username: `${token}.demo`, roles: [token] };
      } })
      .overrideProvider(InvoicesRepository).useValue(repo)
      .overrideProvider(MinioStorageService).useValue({ upload: jest.fn() }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });
  afterAll(async () => { await app.close(); });
  const ingest = (role = 'accountant') => request(app.getHttpServer()).post('/invoices/ingest').auth(role, { type: 'bearer' });
  it.each(['accountant', 'admin'])('allows %s XML upload', async role => {
    const res = await ingest(role).field('purchaseOrderId', po).attach('xml', xml, { filename: '../../invoice.bin', contentType: 'application/xml' }).expect(201);
    expect(res.body.status).toBe('PARSED'); expect(res.body.files[0].objectKey).toMatch(/\/[^/]+\.xml$/);
  });
  it('returns 202 for PDF-only upload', async () => {
    const res = await ingest().field('purchaseOrderId', po).attach('pdf', Buffer.from('%PDF-1.4\n%%EOF'), { filename: 'invoice.pdf', contentType: 'application/pdf' }).expect(202);
    expect(res.body).toMatchObject({ status: 'OCR_REQUIRED', invoiceId: null });
  });
  it('accepts one XML and one PDF with the PO field', async () => {
    const pdf = readFileSync(resolve(__dirname, '../../../infra/invoice/fixtures/sample.pdf'));
    const res = await ingest().field('purchaseOrderId', po)
      .attach('xml', xml, { filename: 'invoice.xml', contentType: 'application/xml' })
      .attach('pdf', pdf, { filename: 'invoice.pdf', contentType: 'application/pdf' }).expect(201);
    expect(res.body.status).toBe('PARSED');
    expect(res.body.files.map((file: { fileKind: string }) => file.fileKind).sort()).toEqual(['PDF', 'XML']);
  });
  it.each(['warehouse', 'buyer', 'finance_manager'])('forbids %s mutation', role => ingest(role).field('purchaseOrderId', po).attach('xml', xml, 'invoice.xml').expect(403));
  it('requires authentication', () => request(app.getHttpServer()).post('/invoices/ingest').expect(401));
  it('requires PO UUID', () => ingest().field('purchaseOrderId', 'invalid').attach('xml', xml, 'invoice.xml').expect(400));
  it('rejects supplier override', () => ingest().field('purchaseOrderId', po).field('supplierId', randomUUID()).attach('xml', xml, 'invoice.xml').expect(400));
  it('requires a file', () => ingest().field('purchaseOrderId', po).expect(400));
  it('rejects unknown file fields', () => ingest().field('purchaseOrderId', po).attach('other', xml, 'invoice.xml').expect(400));
  it('rejects second XML', () => ingest().field('purchaseOrderId', po).attach('xml', xml, 'a.xml').attach('xml', xml, 'b.xml').expect(400));
  it('rejects forged PDF signature', () => ingest().field('purchaseOrderId', po).attach('pdf', Buffer.from('not pdf'), { filename: 'invoice.pdf', contentType: 'application/pdf' }).expect(415));
  it('reports malformed XML with safe error and ingestion ID', async () => {
    const res = await ingest().field('purchaseOrderId', po).attach('xml', Buffer.from('<bad>'), 'bad.xml').expect(422);
    expect(res.body.errorCode).toBe('MALFORMED_XML'); expect(res.body.ingestionId).toBeDefined();
  });
  it('enforces XML size limit', () => ingest().field('purchaseOrderId', po).attach('xml', Buffer.alloc(5242881, 65), 'invoice.xml').expect(413));
  it('enforces bounded PDF memory upload', () => ingest().field('purchaseOrderId', po).attach('pdf', Buffer.alloc(20971521, 65), 'invoice.pdf').expect(413));
  it.each(['accountant', 'admin', 'buyer', 'finance_manager'])('allows %s reads', async role => {
    for (const path of ['/invoices', `/invoices/${id}`, `/invoices/${id}/files`, `/invoice-ingestions/${id}`]) {
      await request(app.getHttpServer()).get(path).auth(role, { type: 'bearer' }).expect(200);
    }
  });
  it('forbids warehouse invoice reads', () => request(app.getHttpServer()).get('/invoices').auth('warehouse', { type: 'bearer' }).expect(403));
  it('validates list filters and pagination', async () => {
    await request(app.getHttpServer()).get('/invoices?limit=101').auth('accountant', { type: 'bearer' }).expect(400);
    await request(app.getHttpServer()).get('/invoices?status=INVALID').auth('accountant', { type: 'bearer' }).expect(400);
  });
});
