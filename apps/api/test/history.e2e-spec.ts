/* SPDX-License-Identifier: MIT */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { historyEntry, historyFixture } from './history.fixtures';
import { HistoryQueryService } from '../src/platform/history/history-query.service';
import { HistoryModule } from '../src/platform/history/history.module';
import { EvidenceErrorFilter } from '../src/platform/evidence/evidence.controller';
import { fail } from '../src/platform/evidence/evidence.types';
const platform = JSON.parse(readFileSync(resolve(__dirname, '../../../packages/contracts/opendx/v1/schemas/platform.schema.json'), 'utf8')),
  proposed = JSON.parse(readFileSync(resolve(__dirname, '../../../packages/contracts/opendx/proposed/issue57-history.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true }); ajv.addSchema(platform); ajv.addSchema(proposed);
const shape = (name: string, body: unknown, schema = proposed) => expect(ajv.getSchema(schema.$id + '#/definitions/' + name)(body)).toBe(true);
describe('history HTTP (real Nest; SQL/source/current authority doubles)', () => {
  let app: INestApplication, f: ReturnType<typeof historyFixture>, foreign: { tenantId: string; subject: string };
  const get = (path = 'cases', actor = 'worker') => request(app.getHttpServer()).get('/platform/v1/history/case.history/' + path).set('Authorization', 'Bearer fixture-' + actor);
  beforeEach(async () => {
    f = historyFixture(); f.entries.push(historyEntry(f.ctx.tenantId, '2')); await f.projector.processPage(f.ctx, 'case.history');
    foreign = { tenantId: randomUUID(), subject: 'foreign-reader' };
    f.access.check.mockImplementation(async (ctx, action, stream) => { if (!f.state.active || ![f.ctx.tenantId, foreign.tenantId].includes(ctx.tenantId) ||
      stream !== 'case.history' || !['history.read', 'history.report'].includes(action)) fail('FORBIDDEN', 403); });
    const service = new HistoryQueryService(f.store, f.access, 'history-fixture-private-cursor-key-at-least32bytes');
    const resolver = { resolve: async req => {
      const auth = req.header('Authorization'), ctx = auth === 'Bearer fixture-worker' ? f.ctx : auth === 'Bearer fixture-foreign' ? foreign : undefined;
      if (!ctx) fail('UNAUTHENTICATED', 401); if (!f.state.active) fail('FORBIDDEN', 403); return ctx;
    } };
    const module = await Test.createTestingModule({ imports: [HistoryModule.register(service, resolver)] }).compile();
    app = module.createNestApplication(); app.useGlobalFilters(new EvidenceErrorFilter()); await app.init();
  });
  afterEach(async () => { await app.close(); });
  it('requires verified current identity and does not expose histories after revocation', async () => {
    shape('Error', (await request(app.getHttpServer()).get('/platform/v1/history/case.history/cases').expect(401)).body, platform);
    f.state.active = false; shape('Error', (await get().expect(403)).body, platform);
  });
  it('returns contract-valid lineage, exact page metrics and explicit synthetic provenance without cache retention', async () => {
    const response = await get().expect(200); shape('CasePage', response.body); expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.metrics).toMatchObject({ case_count: 2, total_duration_ms: '120000', data_origin: 'SIMULATED' }); expect(response.body.items[0].lineage).toHaveLength(2);
  });
  it('pages events through opaque bound cursors and rejects mode/limit changes', async () => {
    const first = await get('events?limit=1').expect(200); shape('EventPage', first.body);
    const second = await get('events?limit=1&cursor=' + first.body.next_cursor).expect(200); shape('EventPage', second.body); expect(second.body.complete).toBe(true);
    await get('cases?limit=1&cursor=' + first.body.next_cursor).expect(400); await get('events?limit=2&cursor=' + first.body.next_cursor).expect(400);
  });
  it('an active foreign tenant gets no own-tenant records and cannot reuse another tenant cursor', async () => {
    const first = await get('events?limit=1').expect(200), foreignPage = await get('cases', 'foreign').expect(200);
    shape('CasePage', foreignPage.body); expect(foreignPage.body.metrics.case_count).toBe(0); expect(foreignPage.body.items).toEqual([]);
    shape('Error', (await get('events?limit=1&cursor=' + first.body.next_cursor, 'foreign').expect(400)).body, platform);
  });
  it('denied resources and expired held data do not leak through metrics or caller filters', async () => {
    f.access.inspect.mockImplementation(async (_ctx, _stream, entry) => ({ allowed: true, currentRetention: { ...entry.retention, retain_until: '2020-01-01T00:00:00Z', legal_hold: true }, allowExpired: false }));
    const response = await get().expect(200); shape('CasePage', response.body); expect(response.body.metrics.case_count).toBe(0); expect(f.store.rows.size).toBe(2);
    for (const path of ['cases?tenant_id=' + foreign.tenantId, 'cases?include_restricted=true', 'events?limit=101', 'events?limit=0']) shape('Error', (await get(path).expect(400)).body, platform);
  });
  it('authority outages fail closed with a safe error instead of a partial successful report', async () => {
    f.access.inspect.mockRejectedValue(new Error('Private backend diagnostic marker'));
    const response = await get().expect(503); shape('Error', response.body, platform); expect(JSON.stringify(response.body)).not.toContain('diagnostic marker');
  });
  it('exposes read routes only, with no client projection, SQL or purge endpoint', async () => {
    const before = f.store.rows.size;
    for (const suffix of ['cases', 'events', 'purge', 'projection']) await request(app.getHttpServer()).post('/platform/v1/history/case.history/' + suffix).set('Authorization', 'Bearer fixture-worker').send({ sql: 'DELETE', tenant_id: f.ctx.tenantId }).expect(404);
    expect(f.store.rows.size).toBe(before);
  });
});
