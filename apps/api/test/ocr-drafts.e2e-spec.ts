/* SPDX-License-Identifier: MIT */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DraftService } from '../src/platform/extraction/draft.service';
import { DraftModule } from '../src/platform/extraction/draft.module';
import { EvidenceModule } from '../src/platform/evidence/evidence.module';
import { EvidenceService } from '../src/platform/evidence/evidence.service';
import { fail } from '../src/platform/evidence/evidence.types';
import { InvoiceDraftProfile } from '../src/packs/openresolve/extraction/invoice-draft.profile';
import { InvoiceDraftTarget } from '../src/packs/openresolve/extraction/invoice-draft.target';
import { context, foreign, key, MemoryEvidenceStore, MemoryEvidenceStorage, metadata, pdf, stream } from './evidence.fixtures';
import { fixturePo, invoiceSuggestion, MemoryDraftStore } from './ocr.fixtures';
const schema = JSON.parse(readFileSync(resolve(__dirname, '../../../packages/contracts/opendx/v1/schemas/platform.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true }); ajv.addSchema(schema);
function shape(name: string, body: unknown) { const validate = ajv.getSchema(schema.$id + '#/definitions/' + name); expect(validate(body)).toBe(true); }
describe('reviewed OCR HTTP (static server identity/provider/DB/storage doubles)', () => {
  let app: INestApplication, service: DraftService, evidence: EvidenceService, store: MemoryDraftStore, sourceId: string, extract: jest.Mock;
  const profile = new InvoiceDraftProfile();
  beforeEach(async () => {
    const rawStore = new MemoryEvidenceStore(), storage = new MemoryEvidenceStorage();
    evidence = new EvidenceService(rawStore, storage, { scan: async () => ({ state: 'CLEAN', retryable: false }) }, { check: async () => undefined }, 'x'.repeat(32), Date.now,
      { read: (ctx, id) => service.operation(ctx, id) });
    const registered = await evidence.register(context, metadata(), key()); sourceId = registered.evidence.id;
    await evidence.upload(context, sourceId, stream(pdf), 'application/pdf', key()); await evidence.processNextScan(context);
    store = new MemoryDraftStore(rawStore);
    extract = jest.fn(async () => { const result = invoiceSuggestion(sourceId); return { fields: result.fields, runs: [result] }; });
    service = new DraftService(store, evidence, { extract }, [profile], { check: async () => undefined },
      new InvoiceDraftTarget({ verify: async (_ctx, payload) => { if (payload.purchase_order_id !== fixturePo) fail('FORBIDDEN', 403); } }));
    const resolver = { resolve: async req => {
      if (req.header('Authorization') === 'Bearer fixture-member') return context;
      if (req.header('Authorization') === 'Bearer fixture-foreign') return foreign;
      fail('UNAUTHENTICATED', 401);
    } };
    const module = await Test.createTestingModule({ imports: [EvidenceModule.register(evidence, resolver), DraftModule.register(service, resolver)] }).compile();
    app = module.createNestApplication(); await app.init();
  });
  afterEach(async () => app.close());
  const api = (method: 'get' | 'post', path: string, identity = 'fixture-member') => request(app.getHttpServer())[method](path).set('Authorization', 'Bearer ' + identity);
  async function queued() {
    const response = await api('post', '/platform/v1/evidence/' + sourceId + '/extractions').set('Idempotency-Key', key()).send({ schema_id: profile.id, mode: 'OCR' }).expect(202);
    shape('Operation', response.body); return response.body;
  }
  async function reviewed() { const op = await queued(); await service.processNext(context); const response = await api('get', '/platform/v1/extraction-drafts/' + op.resource_ref.id).expect(200); shape('ExtractionDraft', response.body); return response.body; }
  test('202 is a durable pending extraction; operation route delegates and no model call precedes worker', async () => {
    const op = await queued(); expect(extract).not.toHaveBeenCalled();
    const status = await api('get', '/platform/v1/operations/' + op.id).expect(200); shape('Operation', status.body); expect(status.body.state).toBe('PENDING');
    await service.processNext(context); const done = await api('get', '/platform/v1/operations/' + op.id).expect(200); expect(done.body.state).toBe('SUCCEEDED');
    expect(store.outbox).toHaveLength(0);
  });
  test('foreign draft/operation IDs are generic 404', async () => {
    const op = await queued(); await service.processNext(context);
    for (const path of ['/platform/v1/extraction-drafts/' + op.resource_ref.id, '/platform/v1/operations/' + op.id]) {
      const result = await api('get', path, 'fixture-foreign').expect(404); shape('Error', result.body); expect(result.body.code).toBe('NOT_FOUND');
    }
  });
  test('unauthenticated and client-controlled tenant/state/fields cannot enqueue', async () => {
    await request(app.getHttpServer()).post('/platform/v1/evidence/' + sourceId + '/extractions').send({ schema_id: profile.id, mode: 'OCR' }).expect(401);
    for (const addition of [{ tenant_id: foreign.tenantId }, { state: 'CONFIRMED' }, { fields: [] }]) {
      const result = await api('post', '/platform/v1/evidence/' + sourceId + '/extractions').set('Idempotency-Key', key()).send({ schema_id: profile.id, mode: 'OCR', ...addition }).expect(400); shape('Error', result.body);
    }
    expect(store.records.size).toBe(0); expect(extract).not.toHaveBeenCalled();
  });
  test('corrections follow schema/server provenance and stale revision fails', async () => {
    const draft = await reviewed(), path = '/platform/v1/extraction-drafts/' + draft.id + '/corrections';
    const body = { expected_revision: 1, corrections: [{ field_path: '/invoice_number', previous_value: 'SYN-26', new_value: 'REVIEW-26', reason: 'Inspected authorized raw file' }] };
    const result = await api('post', path).set('Idempotency-Key', key()).send(body).expect(200); shape('ExtractionDraft', result.body);
    expect(result.body.corrections[0].actor_subject).toBe(context.subject); expect(result.body.revision).toBe(2);
    const stale = await api('post', path).set('Idempotency-Key', key()).send(body).expect(409); shape('Error', stale.body); expect(stale.body.code).toBe('REVISION_CONFLICT');
  });
  test('missing field correction omits previous_value and stores actor', async () => {
    extract.mockImplementation(async () => { const result = invoiceSuggestion(sourceId, { '/purchase_order_id': undefined }); return { fields: result.fields, runs: [result] }; });
    const draft = await reviewed(); const result = await api('post', '/platform/v1/extraction-drafts/' + draft.id + '/corrections').set('Idempotency-Key', key())
      .send({ expected_revision: 1, corrections: [{ field_path: '/purchase_order_id', new_value: fixturePo, reason: 'Selected permitted PO' }] }).expect(200);
    shape('ExtractionDraft', result.body); expect(result.body.corrections[0].previous_value).toBeUndefined();
  });
  test('confirmed facts and durable handoff follow schema; repeat command creates no second outbox', async () => {
    const draft = await reviewed(), command = key(), body = { expected_revision: 1, reviewed_field_paths: profile.requiredPaths(draft.fields) }, path = '/platform/v1/extraction-drafts/' + draft.id + '/confirmations';
    const first = await api('post', path).set('Idempotency-Key', command).send(body).expect(202); shape('Confirmation', first.body);
    expect(first.body.operation.state).toBe('PENDING'); expect(store.outbox).toHaveLength(1);
    const repeated = await api('post', path).set('Idempotency-Key', command).send(body).expect(202); expect(repeated.body).toEqual(first.body); expect(store.outbox).toHaveLength(1);
    await api('post', path).set('Idempotency-Key', key()).send(body).expect(409);
    const status = await api('get', '/platform/v1/operations/' + first.body.operation.id).expect(200); shape('Operation', status.body);
  });
  test('outbox outage returns safe 503 and rolls back reviewed/source state', async () => {
    const draft = await reviewed(); store.enqueueFailure = true;
    const result = await api('post', '/platform/v1/extraction-drafts/' + draft.id + '/confirmations').set('Idempotency-Key', key())
      .send({ expected_revision: 1, reviewed_field_paths: profile.requiredPaths(draft.fields) }).expect(503);
    shape('Error', result.body); expect(result.body.message).not.toContain('outbox');
    const current = await api('get', '/platform/v1/extraction-drafts/' + draft.id).expect(200); expect(current.body.state).toBe('REVIEW_REQUIRED'); expect(store.outbox).toHaveLength(0);
  });
  test('cannot submit verified_payload instead of persisted field review', async () => {
    const draft = await reviewed(); const result = await api('post', '/platform/v1/extraction-drafts/' + draft.id + '/confirmations').set('Idempotency-Key', key())
      .send({ expected_revision: 1, reviewed_field_paths: ['/total_amount'], verified_payload: { total_amount: '0' } }).expect(400); shape('Error', result.body);
    expect(store.outbox).toHaveLength(0);
  });
});
