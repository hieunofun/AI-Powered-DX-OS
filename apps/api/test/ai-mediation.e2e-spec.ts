/* SPDX-License-Identifier: MIT */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import Ajv from 'ajv';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AiMediationModule } from '../src/packs/openresolve/mediation/mediation.module';
import { EvidenceErrorFilter } from '../src/platform/evidence/evidence.controller';
import { fail } from '../src/platform/evidence/evidence.types';
import { mediationFixture } from './mediation.fixtures';
const platform = JSON.parse(readFileSync(resolve(__dirname, '../../../packages/contracts/opendx/v1/schemas/platform.schema.json'), 'utf8'));
const proposed = JSON.parse(readFileSync(resolve(__dirname, '../../../packages/contracts/opendx/proposed/issue54-mediation.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true }); ajv.addSchema(platform); ajv.addSchema(proposed);
const shape = (name: string, value: unknown, schema = proposed) => expect(ajv.getSchema(schema.$id + '#/definitions/' + name)(value)).toBe(true);
describe('AI mediation HTTP (actual Nest; labelled identity/SQL/model/owner adapters doubles)', () => {
  let app: INestApplication, f: ReturnType<typeof mediationFixture>;
  const prefix = '/apps/openresolve/v1/ai';
  const post = (path: string, body: object | string, actor = 'requester', key = randomUUID()) => request(app.getHttpServer()).post(prefix + path)
    .set('Authorization', 'Bearer fixture-' + actor).set('Idempotency-Key', key).send(body);
  const get = (path: string, actor = 'requester') => request(app.getHttpServer()).get(prefix + path).set('Authorization', 'Bearer fixture-' + actor);
  async function explained() {
    const response = await post('/cases/' + f.caseId + '/explanations', { question: 'What evidence is missing?' }).expect(202);
    shape('Operation', response.body, platform); await f.service.processNext(f.contexts.worker); return response.body.resource_ref.id;
  }
  beforeEach(async () => {
    f = mediationFixture(); const resolver = { resolve: async req => {
      const name = req.header('Authorization')?.replace(/^Bearer fixture-/, ''), ctx = f.contexts[name];
      if (!ctx) fail('UNAUTHENTICATED', 401); if (!f.active.has(ctx.subject)) fail('FORBIDDEN', 403); return ctx;
    } };
    const module = await Test.createTestingModule({ imports: [AiMediationModule.register(f.service, resolver)] }).compile();
    app = module.createNestApplication(); app.useGlobalFilters(new EvidenceErrorFilter()); await app.init();
  });
  afterEach(async () => { await app.close(); });
  it('requires a verified current identity and returns the shared safe error DTO', async () => {
    const response = await request(app.getHttpServer()).post(prefix + '/cases/' + f.caseId + '/explanations').send({ question: 'Why?' }).expect(401);
    shape('Error', response.body, platform); expect(f.store.jobs.size).toBe(0);
  });
  it('returns durable 202 before model work and an authorized contract-valid explanation', async () => {
    const first = await post('/cases/' + f.caseId + '/explanations', { question: 'Why?' }).expect(202);
    expect(f.provider.select).not.toHaveBeenCalled(); expect(f.store.jobs.size).toBe(1);
    await f.service.processNext(f.contexts.worker); const detail = await get('/explanations/' + first.body.resource_ref.id).expect(200);
    shape('Explanation', detail.body); expect(detail.body.result.missing_evidence).toEqual(['RECEIPT']);
  });
  it('rejects client authority, action injection and missing idempotency before storing requests', async () => {
    for (const body of [{ question: 'Why?', tenant_id: f.tenant }, { question: 'Why?', approved: true }, { question: 'Why?', tool: 'payment.transfer' }, { question: 'x'.repeat(1001) }]) {
      const response = await post('/cases/' + f.caseId + '/explanations', body).expect(400); shape('Error', response.body, platform);
    }
    await request(app.getHttpServer()).post(prefix + '/cases/' + f.caseId + '/explanations').set('Authorization', 'Bearer fixture-requester').send({ question: 'Why?' }).expect(400);
    expect(f.store.jobs.size).toBe(0);
  });
  it('implements proposal, verified independent approval and exactly one transactional execution', async () => {
    const id = await explained(), created = await post('/explanations/' + id + '/proposals', { tool: 'case.request_evidence', missing_evidence_codes: ['RECEIPT'] }).expect(201);
    shape('Proposal', created.body); const proposalId = created.body.id; expect(f.store.effects.size).toBe(0);
    await post('/proposals/' + proposalId + '/execute', {}).expect(403);
    await post('/proposals/' + proposalId + '/approval', { decision_ref: { pack_id: 'platform', type: 'decision', id: randomUUID() } }, 'approver').expect(403);
    const ref = f.decision(proposalId); await post('/proposals/' + proposalId + '/approval', { decision_ref: ref }).expect(403);
    shape('Proposal', (await post('/proposals/' + proposalId + '/approval', { decision_ref: ref }, 'approver').expect(200)).body);
    const key = randomUUID(), first = await post('/proposals/' + proposalId + '/execute', {}, 'requester', key).expect(200); shape('Proposal', first.body);
    expect((await post('/proposals/' + proposalId + '/execute', {}, 'requester', key).expect(200)).body).toEqual(first.body);
    expect(f.store.effects.size).toBe(1); expect(f.executor.executeInTransaction).toHaveBeenCalledTimes(1);
  });
  it('cannot downgrade R2, execute R3, select foreign facts or invent missing evidence', async () => {
    const id = await explained();
    for (const body of [{ tool: 'payment.transfer' }, { tool: 'case.add_note', fact_ids: [randomUUID()] }, { tool: 'case.request_evidence', missing_evidence_codes: ['INVOICE'] },
      { tool: 'case.add_note', fact_ids: [f.snapshot.facts[0].id], risk: 'R0' }, { tool: { toString: 'invalid' } },
      { tool: 'case.add_note', fact_ids: [{ toString: 'invalid' }] }, { tool: 'case.request_evidence', missing_evidence_codes: [null] }]) {
      shape('Error', (await post('/explanations/' + id + '/proposals', body).expect(400)).body, platform);
    }
    expect(f.store.proposals.size).toBe(0); expect(f.store.effects.size).toBe(0);
  });
  it('protects explanation and proposal IDs across active tenants and current revocation', async () => {
    const id = await explained(), proposal = await post('/explanations/' + id + '/proposals', { tool: 'case.request_evidence', missing_evidence_codes: ['RECEIPT'] }).expect(201);
    for (const path of ['/explanations/' + id, '/proposals/' + proposal.body.id]) shape('Error', (await get(path, 'foreign').expect(404)).body, platform);
    await post('/proposals/' + proposal.body.id + '/execute', {}, 'foreign').expect(404); f.active.delete('requester'); await get('/explanations/' + id).expect(403);
  });
  it('does not accept client approval/execution fields, even after a real fixture decision exists', async () => {
    const id = await explained(), proposal = await post('/explanations/' + id + '/proposals', { tool: 'case.request_evidence', missing_evidence_codes: ['RECEIPT'] }).expect(201);
    const ref = f.decision(proposal.body.id);
    await post('/proposals/' + proposal.body.id + '/approval', { decision_ref: ref, approved: true }, 'approver').expect(400);
    await post('/proposals/' + proposal.body.id + '/execute', { actor: 'approver' }).expect(400); expect(f.store.effects.size).toBe(0);
  });
  it('honors the live kill switch without removing historical authorized evidence', async () => {
    const id = await explained(); f.store.enabled = false;
    await post('/cases/' + f.caseId + '/explanations', { question: 'Why?' }).expect(503);
    await post('/explanations/' + id + '/proposals', { tool: 'case.request_evidence', missing_evidence_codes: ['RECEIPT'] }).expect(503);
    shape('Explanation', (await get('/explanations/' + id).expect(200)).body);
  });
  it('sanitizes invalid JSON, unsupported MIME/charset and framework size overflow', async () => {
    const url = prefix + '/cases/' + f.caseId + '/explanations';
    const malformed = await request(app.getHttpServer()).post(url).set('Content-Type', 'application/json').send('{broken').expect(400); shape('Error', malformed.body, platform);
    await request(app.getHttpServer()).post(url).set('Content-Type', 'application/json; charset=latin1').send('{}').expect(415);
    await request(app.getHttpServer()).post(url).set('Authorization', 'Bearer fixture-requester').set('Idempotency-Key', randomUUID()).set('Content-Type', 'text/plain').send('text').expect(415);
    const overflow = await request(app.getHttpServer()).post(url).set('Content-Type', 'application/json').send(JSON.stringify({ question: 'x'.repeat(150000) })).expect(413);
    shape('Error', overflow.body, platform); expect(JSON.stringify(overflow.body)).not.toContain('150000'); expect(f.store.jobs.size).toBe(0);
  });
});
