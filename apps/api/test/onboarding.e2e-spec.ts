/* SPDX-License-Identifier: MIT */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OnboardingModule } from '../src/packs/onboarding/onboarding.module';
import { fail } from '../src/platform/evidence/evidence.types';
import { EvidenceErrorFilter } from '../src/platform/evidence/evidence.controller';
import { onboardingFixture, requester, reviewer, foreign, processor } from './onboarding.fixtures';
const schema = JSON.parse(readFileSync(resolve(__dirname, '../../../packages/contracts/opendx/proposed/issue60-onboarding.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true }); ajv.addSchema(schema);
function shape(name: string, value: unknown) { expect(ajv.getSchema(schema.$id + '#/definitions/' + name)(value)).toBe(true); }
describe('Onboarding HTTP (server identity and owner/DB/engine doubles)', () => {
  let app: INestApplication, fixture: ReturnType<typeof onboardingFixture>;
  beforeEach(async () => {
    fixture = onboardingFixture();
    const module = await Test.createTestingModule({ imports: [OnboardingModule.register(fixture.service, { resolve: async req => {
      const token = req.header('Authorization'), ctx = { 'Bearer requester': requester, 'Bearer reviewer': reviewer, 'Bearer foreign': foreign }[token];
      if (!ctx) fail('UNAUTHENTICATED', 401); return ctx;
    } })] }).compile(); app = module.createNestApplication(); app.useGlobalFilters(new EvidenceErrorFilter()); await app.init();
  });
  afterEach(async () => app.close());
  const route = '/packs/onboarding/v1';
  const get = (path: string, actor = 'requester') => request(app.getHttpServer()).get(route + path).set('Authorization', 'Bearer ' + actor);
  const post = (path: string, body: object, actor = 'requester', key = randomUUID()) => request(app.getHttpServer()).post(route + path).set('Authorization', 'Bearer ' + actor).set('Idempotency-Key', key).send(body);
  test('authentication, correlation and idempotency required before creation', async () => {
    await request(app.getHttpServer()).post(route + '/cases').send({ display_label: 'Fixture' }).expect(401);
    await request(app.getHttpServer()).post(route + '/cases').set('Authorization', 'Bearer requester').send({ display_label: 'Fixture' }).expect(400);
    const correlation = randomUUID(), response = await post('/cases', { display_label: 'Fixture' }).set('X-Correlation-ID', correlation).expect(201);
    expect(response.headers['x-correlation-id']).toBe(correlation); expect(response.headers['cache-control']).toBe('private, no-store');
  });
  test('caller cannot inject tenant, subject, role, provisioning or unrecognized query', async () => {
    for (const extra of [{ tenant_id: foreign.tenantId }, { requester_subject: reviewer.subject }, { role: 'admin' }, { provisioning_state: 'PROVISIONED' }])
      await post('/cases', { display_label: 'Fixture', ...extra }).expect(400);
    await post('/cases?tenant=foreign', { display_label: 'Fixture' }).expect(400); expect(fixture.store.records.size).toBe(0);
  });
  test('idempotency replay is exact; different body conflicts', async () => {
    const key = randomUUID(), first = await post('/cases', { display_label: 'Fixture' }, 'requester', key).expect(201);
    expect((await post('/cases', { display_label: 'Fixture' }, 'requester', key).expect(201)).body).toEqual(first.body);
    expect((await post('/cases', { display_label: 'Changed' }, 'requester', key).expect(409)).body.code).toBe('IDEMPOTENCY_CONFLICT');
  });
  test('foreign case/operation is same generic 404 as absent resources', async () => {
    const id = await fixture.ready(), op = (await fixture.store.read(requester, id)).operations[0];
    for (const path of ['/cases/' + id, '/cases/' + randomUUID(), '/operations/' + op.id])
      expect((await get(path, 'foreign').expect(404)).body.code).toBe('NOT_FOUND');
  });
  test('actual HTTP checklist/access/decision views keep common durable operation and no provisioning', async () => {
    const created = await post('/cases', { display_label: 'Fictional employee' }).expect(201), id = created.body.id;
    shape('Case', created.body);
    for (const code of ['WELCOME_ACK', 'ACCESS_POLICY_ACK']) await post('/cases/' + id + '/checklist/' + code, { evidence_id: fixture.evidenceId, acknowledged: true, expected_revision: 0 }).expect(200);
    const start = await post('/cases/' + id + '/access-requests', { access_profile: 'DOCS_READ_ONLY' }).expect(202);
    expect(start.body.state).toBe('PENDING'); expect(start.body.resource_ref).toEqual({ pack_id: 'onboarding', type: 'case', id });
    shape('Operation', start.body);
    await fixture.worker().processNext(processor); const ref = await fixture.decision(id);
    await post('/cases/' + id + '/decisions', { decision_ref: ref }).expect(403);
    const approval = await post('/cases/' + id + '/decisions', { decision_ref: ref }, 'reviewer').expect(202);
    await fixture.worker().processNext(processor);
    expect((await get('/operations/' + approval.body.id).expect(200)).body.state).toBe('SUCCEEDED');
    const result = (await get('/cases/' + id).expect(200)).body; expect(result.state).toBe('COMPLETED'); expect(result.provisioning_state).toBe('NOT_PROVISIONED');
    shape('Case', result);
    expect(JSON.stringify(result)).not.toMatch(/lease|businessKey|decision_snapshot/);
  });
  test('disabled/current revoked pack denies HTTP without enqueuing work', async () => {
    fixture.current.enabled = false; expect((await post('/cases', { display_label: 'Fixture' }).expect(409)).body.code).toBe('PACK_DISABLED');
    fixture.current.enabled = true; fixture.denied.add(requester.subject); await post('/cases', { display_label: 'Fixture' }).expect(403); expect(fixture.store.records.size).toBe(0);
  });
  test('no public worker/reconciliation/provisioning or mutating detail endpoint exists', async () => {
    for (const path of ['/process', '/reconcile', '/provision', '/cases/' + randomUUID()]) shape('Error', (await post(path, {}).expect(404)).body);
  });
});
