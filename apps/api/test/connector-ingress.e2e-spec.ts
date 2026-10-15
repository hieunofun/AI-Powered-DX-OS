/* SPDX-License-Identifier: MIT */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv from 'ajv';
import { ConnectorIngressModule } from '../src/packs/openresolve/connectors/ingress.module';
import { ConnectorIngressService } from '../src/packs/openresolve/connectors/ingress.service';
import { EvidenceService } from '../src/platform/evidence/evidence.service';
import { EvidenceErrorFilter } from '../src/platform/evidence/evidence.controller';
import { fail } from '../src/platform/evidence/evidence.types';
import { MemoryEvidenceStorage, MemoryEvidenceStore } from './evidence.fixtures';
import { MemoryIngressStore } from './connector.fixtures';
const platform = JSON.parse(readFileSync(resolve(__dirname, '../../../packages/contracts/opendx/v1/schemas/platform.schema.json'), 'utf8'));
const proposed = JSON.parse(readFileSync(resolve(__dirname, '../../../packages/contracts/opendx/proposed/issue51-connectors.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true }); ajv.addSchema(platform); ajv.addSchema(proposed);
const shape = (name: string, value: unknown, schema = platform) => expect(ajv.getSchema(schema.$id + '#/definitions/' + name)(value)).toBe(true);
describe('two connector HTTP contracts (identity/catalog/DB/storage/AV doubles; actual Nest raw parser)', () => {
  let app: INestApplication, store: MemoryIngressStore, sourceId: string, sensorId: string, tenant: string, active: boolean;
  const body = () => ({ source_event_id: randomUUID(), schema_id: 'openresolve.external-order.v1', observed_at: new Date().toISOString(),
    data: { external_order_id: 'ERP-1', source_revision: 1, supplier_ref: 'SUP-1', currency: 'VND', lines: [{ external_item_id: 'L1', sku: 'SKU-1', description: 'Fictional order', ordered_quantity: '2', unit_price: '1', tax_rate: '0.1' }] } });
  const route = () => '/apps/openresolve/v1/connectors/external-orders/' + sourceId + '/events';
  const http = (method: 'get' | 'post', path: string, actor = 'source') => request(app.getHttpServer())[method](path).set('Authorization', 'Bearer fixture-' + actor).set('Content-Type', 'application/json');
  beforeEach(async () => {
    tenant = randomUUID(); sourceId = randomUUID(); sensorId = randomUUID(); active = true;
    const evidenceStore = new MemoryEvidenceStore(); store = new MemoryIngressStore(evidenceStore);
    const authority = { authorize: async ctx => { if (!active) fail('FORBIDDEN', 403); if (ctx.tenantId !== tenant) fail('NOT_FOUND', 404); } };
    const evidence = new EvidenceService(evidenceStore, new MemoryEvidenceStorage(), { scan: async () => { throw new Error('No worker in this HTTP admission suite'); } }, { check: async () => undefined }, 'fixture-connector-cursor-secret-at-least32bytes');
    const service = new ConnectorIngressService(store, { resolve: async (ctx, id, kind) => {
      if (ctx.tenantId !== tenant || ![sourceId, sensorId].includes(id) || kind !== (id === sourceId ? 'EXTERNAL_ORDER' : 'RECEIVING_SENSOR')) fail('NOT_FOUND', 404);
      if (!active) fail('FORBIDDEN', 403); return { id, tenantId: tenant, principal: ctx.subject, kind, active: true, simulated: true };
    } }, authority, evidence, { snapshot: async () => { throw new Error('No catalog query in admission'); } },
    { enqueue: async () => { throw new Error('No case execution in admission'); } }, { capture: async () => { throw new Error('No lineage in admission'); } });
    const resolver = { resolve: async req => {
      if (!active) fail('FORBIDDEN', 403);
      if (req.header('Authorization') === 'Bearer fixture-source') return { tenantId: tenant, subject: 'source-service' };
      if (req.header('Authorization') === 'Bearer fixture-foreign') return { tenantId: '00000000-0000-4000-8000-000000000999', subject: 'source-service' };
      fail('UNAUTHENTICATED', 401);
    } };
    const module = await Test.createTestingModule({ imports: [ConnectorIngressModule.register(service, resolver)] }).compile();
    app = module.createNestApplication({ rawBody: true }); app.useGlobalFilters(new EvidenceErrorFilter()); await app.init();
  });
  afterEach(async () => app.close());
  test('202 proves durable original raw bytes and never runs scanner or domain execution', async () => {
    const original = JSON.stringify(body(), null, 2), response = await http('post', route()).set('Idempotency-Key', randomUUID()).send(original).expect(202); shape('Operation', response.body);
    const record = [...store.records.values()][0]; expect(await store.bytes({ tenantId: tenant, subject: 'source-service' }, record)).toEqual(Buffer.from(original));
    expect(store.cases).toHaveLength(0); expect(response.body.state).toBe('PENDING');
  });
  test('same-key and canonical reencoding return the original response and retain both byte receipts', async () => {
    const input = body(), key = randomUUID(), first = await http('post', route()).set('Idempotency-Key', key).send(JSON.stringify(input)).expect(202);
    const next = await http('post', route()).set('Idempotency-Key', key).send(JSON.stringify(input, null, 2)).expect(202);
    expect(next.body).toEqual(first.body); expect(store.records.size).toBe(1); expect(store.receipts.size).toBe(2);
  });
  test('unknown tenant/actor/simulation authority fields cannot be accepted', async () => {
    for (const injected of [{ tenant_id: tenant }, { actor_subject: 'admin' }, { simulated: false }]) {
      const response = await http('post', route()).set('Idempotency-Key', randomUUID()).send({ ...body(), ...injected }).expect(400); shape('Error', response.body);
    }
    expect(store.records.size).toBe(0);
  });
  test('wrong schema/family does not become another registered source', async () => {
    const response = await http('post', '/apps/openresolve/v1/connectors/receiving-sensors/' + sourceId + '/events').set('Idempotency-Key', randomUUID()).send(body()).expect(404); shape('Error', response.body);
    await http('post', '/apps/openresolve/v1/connectors/receiving-sensors/' + sensorId + '/events').set('Idempotency-Key', randomUUID()).send(body()).expect(400);
  });
  test('malformed JSON and unsupported encoding use safe shared errors', async () => {
    const missing = await http('post', route()).set('Idempotency-Key', randomUUID()).send().expect(400); shape('Error', missing.body);
    const bad = await http('post', route()).set('Idempotency-Key', randomUUID()).send('{broken-untrusted').expect(400); shape('Error', bad.body); expect(JSON.stringify(bad.body)).not.toContain('broken-untrusted');
    const encoded = await http('post', route()).set('Content-Type', 'application/json; charset=iso-8859-1').set('Idempotency-Key', randomUUID()).send(JSON.stringify(body())).expect(415); shape('Error', encoded.body);
  });
  test('both profile overflow and framework-parser overflow return 413 without persisting a source', async () => {
    for (const size of [65537, 150000]) {
      const response = await http('post', route()).set('Idempotency-Key', randomUUID()).send(JSON.stringify(body()) + ' '.repeat(size)).expect(413); shape('Error', response.body); expect(response.body.code).toBe('FILE_TOO_LARGE');
    }
    expect(store.records.size).toBe(0);
  });
  test('current membership revocation and a foreign tenant block the original source ID', async () => {
    await http('post', route(), 'foreign').set('Idempotency-Key', randomUUID()).send(body()).expect(404);
    active = false; await http('post', route()).set('Idempotency-Key', randomUUID()).send(body()).expect(403); expect(store.records.size).toBe(0);
  });
  test('status exposes trusted simulation/provenance and matches the proposed snake_case DTO', async () => {
    const created = await http('post', route()).set('Idempotency-Key', randomUUID()).send(body()).expect(202);
    const response = await http('get', '/apps/openresolve/v1/connectors/observations/' + created.body.resource_ref.id).expect(200); shape('Observation', response.body, proposed);
    expect(response.body.simulated).toBe(true); expect(response.body.source_id).toBe(sourceId); expect(response.body.raw_sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
