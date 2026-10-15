/* SPDX-License-Identifier: MIT */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EvidenceModule } from '../src/platform/evidence/evidence.module';
import { EvidenceService } from '../src/platform/evidence/evidence.service';
import { fail, ScanResult } from '../src/platform/evidence/evidence.types';
import { context, foreign, key, MemoryEvidenceStore, MemoryEvidenceStorage, metadata, pdf } from './evidence.fixtures';
const schema = JSON.parse(readFileSync(resolve(__dirname, '../../../packages/contracts/opendx/v1/schemas/platform.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true }); ajv.addSchema(schema);
function shape(name: string, body: unknown) {
  const validate = ajv.getSchema(schema.$id + '#/definitions/' + name);
  expect(validate(body)).toBe(true);
}
describe('platform evidence HTTP contract (server identity, DB/storage/scanner doubles)', () => {
  let app: INestApplication, service: EvidenceService, store: MemoryEvidenceStore, storage: MemoryEvidenceStorage;
  let scan: jest.Mock, denied: boolean;
  beforeEach(async () => {
    store = new MemoryEvidenceStore(); storage = new MemoryEvidenceStorage(); denied = false;
    scan = jest.fn(async (): Promise<ScanResult> => ({ state: 'CLEAN', retryable: false }));
    service = new EvidenceService(store, storage, { scan }, { check: async () => { if (denied) fail('FORBIDDEN', 403); } }, 'c'.repeat(32));
    // Static server fixture identities test the mandatory resolver port, not real JWT/membership.
    const module = await Test.createTestingModule({ imports: [EvidenceModule.register(service, { resolve: async req => {
      const auth = req.header('Authorization'); if (!auth) fail('UNAUTHENTICATED', 401);
      if (auth === 'Bearer foreign') return foreign;
      if (auth === 'Bearer no-tenant') return { ...context, tenantId: '' };
      if (auth !== 'Bearer member') fail('UNAUTHENTICATED', 401);
      return context;
    } })] }).compile();
    app = module.createNestApplication(); await app.init();
  });
  afterEach(async () => app.close());
  function api(method: 'get' | 'post' | 'put', path: string, identity = 'member') { return request(app.getHttpServer())[method](path).set('Authorization', 'Bearer ' + identity); }
  async function register() { return api('post', '/platform/v1/evidence').set('Idempotency-Key', key()).send(metadata()).expect(201); }
  async function uploaded() {
    const result = await register();
    const operation = await api('put', result.body.upload.href).set('Idempotency-Key', key()).set('Content-Type', 'application/pdf').send(pdf).expect(202);
    shape('Operation', operation.body); return { result, operation };
  }
  test('register/list/detail conform to merged schemas and echo correlation', async () => {
    const correlation = key(); const result = await api('post', '/platform/v1/evidence').set('Idempotency-Key', key()).set('X-Correlation-ID', correlation).send(metadata()).expect(201);
    expect(result.headers['x-correlation-id']).toBe(correlation); shape('RegistrationResult', result.body);
    const detail = await api('get', '/platform/v1/evidence/' + result.body.evidence.id).expect(200); shape('Evidence', detail.body);
    const list = await api('get', '/platform/v1/evidence?limit=1').expect(200); shape('EvidencePage', list.body);
  });
  test.each(['missing', 'expired'])('%s token cannot reach services', async kind => {
    const call = request(app.getHttpServer()).post('/platform/v1/evidence').set('Idempotency-Key', key());
    if (kind === 'expired') call.set('Authorization', 'Bearer expired');
    const response = await call.send(metadata()).expect(401); shape('Error', response.body);
    expect(response.body.code).toBe('UNAUTHENTICATED'); expect(store.records.size).toBe(0);
  });
  test('no tenant and client identity additions are rejected', async () => {
    await api('post', '/platform/v1/evidence', 'no-tenant').set('Idempotency-Key', key()).send(metadata()).expect(400);
    const result = await api('post', '/platform/v1/evidence').set('Idempotency-Key', key()).set('X-Tenant-ID', foreign.tenantId).send({ ...metadata(), tenant_id: foreign.tenantId }).expect(400);
    shape('Error', result.body); expect(store.records.size).toBe(0);
  });
  test('foreign/absent evidence and operation return same generic 404 without storage', async () => {
    const { result, operation } = await uploaded(); const reads = storage.reads;
    for (const path of ['/evidence/' + result.body.evidence.id, '/evidence/' + key(), '/operations/' + operation.body.id]) {
      const response = await api('get', '/platform/v1' + path, 'foreign').expect(404);
      expect(response.body.code).toBe('NOT_FOUND'); shape('Error', response.body);
    }
    expect(storage.reads).toBe(reads);
  });
  test('denied action is 403 before source/scanner work', async () => {
    const { result } = await uploaded(); const reads = storage.reads; denied = true;
    await api('get', result.body.upload.href).expect(403); expect(storage.reads).toBe(reads); expect(scan).not.toHaveBeenCalled();
  });
  test.each(['PENDING_UPLOAD', 'PENDING_SCAN', 'INFECTED', 'SCAN_FAILED'])('%s denies HTTP bytes but retains authorized metadata', async state => {
    const result = state === 'PENDING_UPLOAD' ? await register() : (await uploaded()).result;
    if (state === 'INFECTED' || state === 'SCAN_FAILED') { scan.mockResolvedValue({ state, retryable: false, reason: 'fixture' }); await service.processNextScan(context); }
    const response = await api('get', result.body.upload.href).expect(409); expect(response.body.code).toBe('FILE_NOT_CLEAN');
    const detail = await api('get', '/platform/v1/evidence/' + result.body.evidence.id).expect(200); expect(detail.body.quarantine_state).toBe(state);
  });
  test('CLEAN download is verified attachment, private and nosniff', async () => {
    const { result, operation } = await uploaded(); await service.processNextScan(context);
    const response = await api('get', result.body.upload.href).expect(200);
    expect(response.body.equals(pdf)).toBe(true); expect(response.headers['content-disposition']).toMatch(/^attachment; filename="evidence-[0-9a-f-]+\.bin"$/);
    expect(response.headers['x-content-type-options']).toBe('nosniff'); expect(response.headers['cache-control']).toBe('private, no-store');
    const status = await api('get', '/platform/v1/operations/' + operation.body.id).expect(200); expect(status.body.state).toBe('SUCCEEDED'); shape('Operation', status.body);
  });
  test('modified object yields shared checksum error and revokes CLEAN', async () => {
    const { result } = await uploaded(); await service.processNextScan(context);
    const row = await store.read(context, result.body.evidence.id); storage.objects.set(row.objectKey, Buffer.concat([pdf, Buffer.from('tampered')]));
    const response = await api('get', result.body.upload.href).expect(422); shape('Error', response.body); expect(response.body.code).toBe('CHECKSUM_MISMATCH');
    expect((await store.read(context, row.evidence.id)).evidence.quarantine_state).toBe('SCAN_FAILED');
  });
  test('before-intent database outage returns 503 and leaks no dependency message', async () => {
    jest.spyOn(store, 'change').mockRejectedValue(new Error('private DSN should never appear'));
    const response = await api('post', '/platform/v1/evidence').set('Idempotency-Key', key()).send(metadata()).expect(503);
    shape('Error', response.body); expect(response.body.code).toBe('DEPENDENCY_UNAVAILABLE'); expect(JSON.stringify(response.body)).not.toContain('DSN');
  });
  test.each(['/platform/v1/evidence?limit=0', '/platform/v1/evidence?limit=101', '/platform/v1/evidence?limit=1&limit=2', '/platform/v1/evidence?tenant_id=other', '/platform/v1/evidence?cursor=invalid'])('invalid query rejects %s', async path => {
    const response = await api('get', path).expect(400); shape('Error', response.body);
  });
  test('invalid correlation and absent idempotency fail with a safe envelope', async () => {
    const response = await api('get', '/platform/v1/evidence').set('X-Correlation-ID', 'bad\tvalue').expect(400); shape('Error', response.body);
    await api('post', '/platform/v1/evidence').send(metadata()).expect(400);
  });
});
