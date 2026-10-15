/* SPDX-License-Identifier: MIT */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { ReviewedMappingService } from '../src/packs/openresolve/mapping/mapping.service';
import { ReviewedMappingModule } from '../src/packs/openresolve/mapping/mapping.module';
import { ReviewedMappingEngine } from '../src/packs/openresolve/mapping/mapping-engine';
import { PostgresMappingOutbox } from '../src/packs/openresolve/mapping/mapping-outbox.target';
import { EvidenceService } from '../src/platform/evidence/evidence.service';
import { fail } from '../src/platform/evidence/evidence.types';
import { mappingContext as ctx, mappingSnapshot, mappingSuggestion, MemoryMappingStore } from './mapping.fixtures';
const base = JSON.parse(readFileSync(resolve(__dirname, '../../../packages/contracts/opendx/v1/schemas/platform.schema.json'), 'utf8'));
const schema = JSON.parse(readFileSync(resolve(__dirname, '../../../packages/contracts/opendx/proposed/issue25-mapping.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true }); ajv.addSchema(base); ajv.addSchema(schema);
const shape = (name: string, value: unknown) => expect(ajv.getSchema((['Operation', 'Error'].includes(name) ? base.$id : schema.$id) + '#/definitions/' + name)(value)).toBe(true);
describe('reviewed item mapping HTTP (static identities/DB/storage/catalog/provider doubles)', () => {
  let app: INestApplication, service: ReviewedMappingService, store: MemoryMappingStore, snapshot: ReturnType<typeof mappingSnapshot>, suggest: jest.Mock;
  beforeEach(async () => {
    snapshot = mappingSnapshot(); store = new MemoryMappingStore(); suggest = jest.fn(async () => mappingSuggestion(snapshot));
    const evidence = { detail: async () => ({ quarantine_state: 'CLEAN', sha256: snapshot.sourceHash }),
      withCleanBytes: async (_ctx, _id, _action, work) => work(Buffer.from('fixture'), async () => undefined) } as unknown as EvidenceService;
    service = new ReviewedMappingService(store, { snapshot: async context => { if (context.tenantId !== ctx.tenantId) fail('NOT_FOUND', 404); return structuredClone(snapshot); } },
      evidence, { check: async () => undefined }, new ReviewedMappingEngine({ suggest }), { resolve: async () => 'SYNTHETIC' }, new PostgresMappingOutbox({ check: async () => undefined }));
    const resolver = { resolve: async req => {
      if (req.header('Authorization') === 'Bearer fixture-member') return ctx;
      if (req.header('Authorization') === 'Bearer fixture-foreign') return { ...ctx, tenantId: '00000000-0000-4000-8000-000000000099' };
      fail('UNAUTHENTICATED', 401);
    } };
    const module = await Test.createTestingModule({ imports: [ReviewedMappingModule.register(service, resolver)] }).compile(); app = module.createNestApplication(); await app.init();
  });
  afterEach(async () => app.close());
  const api = (method: 'get' | 'post', route: string, token = 'fixture-member') => request(app.getHttpServer())[method]('/apps/openresolve/v1/' + route).set('Authorization', 'Bearer ' + token);
  const enqueue = () => api('post', 'verified-invoices/' + snapshot.confirmationId + '/item-mapping-suggestions').set('Idempotency-Key', randomUUID()).send({ line_path: '/lines/0' }).expect(202);
  async function ready() { const response = await enqueue(); await service.processNext(ctx); const value = await api('get', 'item-mapping-suggestions/' + response.body.resource_ref.id).expect(200); shape('View', value.body); return value.body; }
  const body = record => ({ expected_revision: record.revision, selected_po_item_id: snapshot.candidates[0].id, reason: 'Inspected authorized source/catalog' });
  test('202 operation is persisted before model I/O and pending view conforms', async () => {
    const response = await enqueue(); shape('Operation', response.body); expect(suggest).not.toHaveBeenCalled();
    const pending = await api('get', 'item-mapping-suggestions/' + response.body.resource_ref.id).expect(200); shape('View', pending.body); expect(pending.body.suggestion).toBeUndefined();
  });
  test('worker result remains a review suggestion with no decision or outbox', async () => {
    const record = await ready(); shape('Suggestion', record.suggestion); expect(record.suggestion.state).toBe('REVIEW_REQUIRED'); expect(store.decisions).toHaveLength(0); expect(store.outbox).toHaveLength(0);
  });
  test('foreign suggestion IDs and confirmations return generic 404', async () => {
    const record = await ready();
    for (const method of ['get', 'post'] as const) {
      const route = 'item-mapping-suggestions/' + record.id + (method === 'post' ? '/confirmations' : '');
      const response = await api(method, route, 'fixture-foreign').set('Idempotency-Key', randomUUID()).send(method === 'post' ? body(record) : undefined).expect(404); shape('Error', response.body);
    }
  });
  test('client tenant/actor/candidate catalog properties are rejected', async () => {
    for (const extra of [{ tenant_id: ctx.tenantId }, { actor_subject: 'admin' }, { candidates: [] }]) {
      const response = await api('post', 'verified-invoices/' + snapshot.confirmationId + '/item-mapping-suggestions').set('Idempotency-Key', randomUUID()).send({ line_path: '/lines/0', ...extra }).expect(400); shape('Error', response.body);
    }
    expect(suggest).not.toHaveBeenCalled();
  });
  test('explicit decision records server identity; retry returns original response and one outbox row', async () => {
    const record = await ready(), key = randomUUID(), route = 'item-mapping-suggestions/' + record.id + '/confirmations';
    const first = await api('post', route).set('Idempotency-Key', key).send(body(record)).expect(202); shape('Decision', first.body); expect(first.body.actor_subject).toBe(ctx.subject);
    const repeat = await api('post', route).set('Idempotency-Key', key).send(body(record)).expect(202); expect(repeat.body).toEqual(first.body); expect(store.outbox).toHaveLength(1);
  });
  test('foreign selection and stale revision cannot create an outbox', async () => {
    const record = await ready(), route = 'item-mapping-suggestions/' + record.id + '/confirmations';
    for (const [input, status] of [[{ ...body(record), selected_po_item_id: randomUUID() }, 404], [{ ...body(record), expected_revision: 1 }, 409]] as const) {
      const response = await api('post', route).set('Idempotency-Key', randomUUID()).send(input).expect(status); shape('Error', response.body);
    }
    expect(store.outbox).toHaveLength(0);
  });
  test('explicit rejection conforms and enqueues no dispatch', async () => {
    const record = await ready(); const response = await api('post', 'item-mapping-suggestions/' + record.id + '/confirmations').set('Idempotency-Key', randomUUID()).send({ ...body(record), selected_po_item_id: null }).expect(202);
    shape('Decision', response.body); expect(response.body.dispatch_state).toBe('NONE'); expect(store.outbox).toHaveLength(0);
  });
  test('finalization outage yields safe 503 and rolls back decision/outbox', async () => {
    const record = await ready(); store.failFinalization = true;
    const response = await api('post', 'item-mapping-suggestions/' + record.id + '/confirmations').set('Idempotency-Key', randomUUID()).send(body(record)).expect(503); shape('Error', response.body);
    expect(store.decisions).toHaveLength(0); expect(store.outbox).toHaveLength(0);
  });
});
