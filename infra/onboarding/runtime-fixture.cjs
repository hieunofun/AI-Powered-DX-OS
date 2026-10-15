/* SPDX-License-Identifier: MIT */
'use strict';
// Actual generic core data/identity/workflow/evidence/lineage. SQL-backed #43/#50/#59
// acceptance adapters are explicit fixtures, not independently delivered owner APIs.
require('reflect-metadata');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID, generateKeyPairSync } = require('node:crypto'), { createServer } = require('node:http');
const jwt = require('jsonwebtoken'), { Module } = require('@nestjs/common'), { NestFactory } = require('@nestjs/core');
const root = path.resolve(__dirname, '../..'), load = file => require(path.join(root, 'apps/api/dist', file));
const { DatabaseService } = load('platform/data/database.service.js'), { AuthService } = load('platform/identity/auth.service.js');
const { FlowableTransport, EngineError } = load('platform/workflow/flowable.transport.js');
const { EvidenceService } = load('platform/evidence/evidence.service.js'), { EvidenceModule } = load('platform/evidence/evidence.module.js');
const { PostgresEvidenceStore } = load('platform/evidence/evidence.repository.js'), { PrivateEvidenceStorage } = load('platform/evidence/evidence-storage.js');
const { MinioStorageService } = load('storage/minio-storage.service.js'), { ClamavScanner } = load('platform/evidence/clamav.scanner.js');
const { PostgresLineageStore } = load('platform/lineage/lineage.repository.js');
const { MembershipEvidenceResolver } = load('platform/lineage/verified-evidence-access.js');
const { OnboardingModule } = load('packs/onboarding/onboarding.module.js'), { OnboardingService } = load('packs/onboarding/onboarding.service.js');
const { PostgresOnboardingStore } = load('packs/onboarding/onboarding.repository.js'), { OnboardingWorker } = load('packs/onboarding/onboarding.worker.js');
const { OnboardingLineageWriter } = load('packs/onboarding/onboarding-lineage.writer.js'), { ONBOARDING_MANIFEST } = load('packs/onboarding/onboarding.manifest.js');
const { checksum, fingerprint } = load('platform/evidence/file-safety.js'), { fail } = load('platform/evidence/evidence.types.js');
const Ajv = require('ajv'), schema = require('../../packages/contracts/opendx/proposed/issue60-onboarding.schema.json');
const ajv = new Ajv({ allErrors: true }); ajv.addSchema(schema);
async function createFixture() {
  const fixtureStartedAt = new Date().toISOString();
  Object.assign(process.env, { POSTGRES_HOST: '127.0.0.1', POSTGRES_PORT: '15460', POSTGRES_DB: 'onboarding_issue60', POSTGRES_USER: 'onboarding_fixture', POSTGRES_PASSWORD: 'onboarding_fixture_local_only',
    MINIO_ENDPOINT: '127.0.0.1', MINIO_PORT: '19460', MINIO_USE_SSL: 'false', MINIO_BUCKET_INVOICES: 'onboarding-issue60', MINIO_ACCESS_KEY: 'onboarding_fixture', MINIO_SECRET_KEY: 'onboarding_fixture_local_only',
    FLOWABLE_URL: 'http://127.0.0.1:18060/flowable-rest/service', FLOWABLE_USERNAME: 'onboarding-service', FLOWABLE_PASSWORD: 'onboarding_engine_fixture_local_only', FLOWABLE_TIMEOUT_MS: '10000' });
  const db = new DatabaseService(); let app, jwks;
  try {
    assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, 'onboarding_issue60');
    for (const file of ['issue41-evidence-intake.sql', 'issue46-evidence-lineage.sql', 'issue60-onboarding-pack.sql']) await db.query(fs.readFileSync(path.join(root, 'database/proposed', file), 'utf8'));
    await db.query(`CREATE TABLE IF NOT EXISTS onboarding_fixture_members(tenant_id UUID NOT NULL,subject TEXT NOT NULL,role TEXT NOT NULL,active BOOLEAN NOT NULL,PRIMARY KEY(tenant_id,subject));
      CREATE TABLE IF NOT EXISTS onboarding_fixture_registry(tenant_id UUID PRIMARY KEY,binding JSONB NOT NULL,permissions JSONB NOT NULL);
      CREATE TABLE IF NOT EXISTS onboarding_fixture_denials(tenant_id UUID NOT NULL,subject TEXT NOT NULL,resource_id UUID NOT NULL,PRIMARY KEY(tenant_id,subject,resource_id));
      CREATE TABLE IF NOT EXISTS onboarding_fixture_evidence_grants(tenant_id UUID NOT NULL,subject TEXT NOT NULL,evidence_id UUID NOT NULL,PRIMARY KEY(tenant_id,subject,evidence_id),FOREIGN KEY(tenant_id,evidence_id) REFERENCES platform_evidence_records(tenant_id,id));
      CREATE TABLE IF NOT EXISTS onboarding_fixture_raw_snapshots(tenant_id UUID NOT NULL,evidence_id UUID NOT NULL,data JSONB NOT NULL,PRIMARY KEY(tenant_id,evidence_id),FOREIGN KEY(tenant_id,evidence_id) REFERENCES platform_evidence_records(tenant_id,id));
      CREATE TABLE IF NOT EXISTS onboarding_fixture_decisions(tenant_id UUID NOT NULL,id UUID NOT NULL,case_id UUID NOT NULL,data JSONB NOT NULL,active BOOLEAN NOT NULL,PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,case_id) REFERENCES onboarding_cases(tenant_id,id));
      DROP TRIGGER IF EXISTS onboarding_fixture_raw_immutable ON onboarding_fixture_raw_snapshots;
      CREATE TRIGGER onboarding_fixture_raw_immutable BEFORE UPDATE OR DELETE ON onboarding_fixture_raw_snapshots FOR EACH ROW EXECUTE FUNCTION onboarding_append_only()`);
    const tenant = randomUUID(), foreignTenant = randomUUID();
    const contexts = { requester: { tenantId: tenant, subject: 'onboarding-requester-' + randomUUID() }, reviewer: { tenantId: tenant, subject: 'onboarding-reviewer-' + randomUUID() },
      worker: { tenantId: tenant, subject: 'onboarding-worker-' + randomUUID() }, foreign: { tenantId: foreignTenant, subject: 'onboarding-foreign-' + randomUUID() } };
    for (const [name, ctx] of Object.entries(contexts)) await db.query('INSERT INTO onboarding_fixture_members VALUES($1,$2,$3,true)', [ctx.tenantId, ctx.subject, name === 'foreign' ? 'requester' : name]);
    const member = async (client, ctx) => { const value = (await client.query('SELECT role FROM onboarding_fixture_members WHERE tenant_id=$1 AND subject=$2 AND active FOR SHARE', [ctx.tenantId, ctx.subject])).rows[0]; if (!value) fail('FORBIDDEN', 403); return value; };
    const engineBase = new FlowableTransport(), engineCalls = { start: 0, claim: 0, complete: 0, reads: 0 }, flags = { fault: undefined, failCapture: false, afterComplete: undefined };
    const engine = {};
    for (const name of ['processes', 'process', 'tasks', 'task', 'historicTask', 'identityLinks']) engine[name] = async (...args) => { engineCalls.reads++; return engineBase[name](...args); };
    for (const name of ['start', 'claim', 'complete']) engine[name] = async (...args) => {
      engineCalls[name]++; const value = await engineBase[name](...args);
      if (name === 'complete' && flags.afterComplete) { const work = flags.afterComplete; flags.afterComplete = undefined; await work(); }
      if (flags.fault === name + '-after') { flags.fault = undefined; throw new EngineError(false); } return value;
    };
    const engineApi = async (route, options = {}, raw = false) => {
      const response = await fetch(process.env.FLOWABLE_URL + route, { ...options, headers: { Authorization: 'Basic ' + Buffer.from(process.env.FLOWABLE_USERNAME + ':' + process.env.FLOWABLE_PASSWORD).toString('base64'), ...options.headers }, signal: AbortSignal.timeout(10000) });
      assert.equal(response.ok, true, 'Actual Flowable HTTP failed: ' + response.status); return raw ? response.text() : response.status === 204 ? undefined : response.json();
    };
    const bpmn = fs.readFileSync(path.join(__dirname, 'access-review.bpmn')); assert.equal(checksum(bpmn), ONBOARDING_MANIFEST.workflow_refs[0].sha256);
    let definitions = (await engineApi('/repository/process-definitions?key=onboarding_access_review_v1&latest=true')).data;
    if (!definitions.length) { const form = new FormData(); form.append('file', new Blob([bpmn], { type: 'application/xml' }), 'onboarding-access-review.bpmn20.xml'); await engineApi('/repository/deployments', { method: 'POST', body: form }); definitions = (await engineApi('/repository/process-definitions?key=onboarding_access_review_v1&latest=true')).data; }
    assert.equal(definitions.length, 1); const definition = definitions[0];
    assert.equal(checksum(Buffer.from(await engineApi('/repository/process-definitions/' + encodeURIComponent(definition.id) + '/resourcedata', {}, true))), checksum(bpmn));
    const policy = { id: randomUUID(), version: '1.0.0', sha256: fingerprint({ independent_approval: true, no_provisioning: true }) };
    const binding = { manifest_sha256: fingerprint(ONBOARDING_MANIFEST), core_version: '1.0.0', enabled: true,
      workflow: { ref: ONBOARDING_MANIFEST.workflow_refs[0], definition_id: definition.id, process_key: definition.key, reviewer_group: 'onboarding-reviewer-' + tenant }, policy_ref: policy };
    await db.query('INSERT INTO onboarding_fixture_registry VALUES($1,$2::jsonb,$3::jsonb)', [tenant, JSON.stringify(binding), JSON.stringify(ONBOARDING_MANIFEST.permissions)]);
    const runtime = { require: async (client, ctx, pack, permission, resource) => {
      const m = await member(client, ctx), row = (await client.query('SELECT * FROM onboarding_fixture_registry WHERE tenant_id=$1 FOR SHARE', [ctx.tenantId])).rows[0];
      if (pack !== 'onboarding' || !row || !row.permissions.includes(permission)) fail('FORBIDDEN', 403);
      const roles = { 'onboarding.case.create': ['requester'], 'onboarding.case.read': ['requester', 'reviewer', 'worker'], 'onboarding.checklist.record': ['requester'],
        'onboarding.access.request': ['requester'], 'onboarding.access.decide': ['reviewer'], 'onboarding.workflow.process': ['worker'], 'onboarding.workflow.reconcile': ['worker'] };
      if (!roles[permission]?.includes(m.role)) fail('FORBIDDEN', 403);
      if (resource) {
        const record = (await client.query('SELECT data FROM onboarding_cases WHERE tenant_id=$1 AND id=$2 FOR SHARE', [ctx.tenantId, resource.id])).rows[0]?.data;
        if (!record || resource.pack_id !== 'onboarding' || resource.type !== 'case') fail('NOT_FOUND', 404);
        if (m.role === 'requester' && record.requester !== ctx.subject || (await client.query('SELECT 1 FROM onboarding_fixture_denials WHERE tenant_id=$1 AND subject=$2 AND resource_id=$3 FOR SHARE', [ctx.tenantId, ctx.subject, resource.id])).rows.length) fail('FORBIDDEN', 403);
      }
      return row.binding;
    } };
    const evidenceAccess = async (client, ctx, action, id, policyCheck) => {
      const m = await member(client, ctx); if (policyCheck?.retentionClass === 'RESTRICTED') fail('FORBIDDEN', 403);
      if (!id) { if (!['evidence.register', 'evidence.scan', 'evidence.read'].includes(action) || m.role !== 'worker') fail('FORBIDDEN', 403); return; }
      const record = (await client.query('SELECT data FROM platform_evidence_records WHERE tenant_id=$1 AND id=$2 FOR SHARE', [ctx.tenantId, id])).rows[0]?.data; if (!record) fail('NOT_FOUND', 404);
      if (record.evidence.retention_class !== 'STANDARD') fail('FORBIDDEN', 403);
      if (action === 'evidence.register') { if (m.role !== 'worker' || record.evidence.created_by !== ctx.subject) fail('FORBIDDEN', 403); return record; }
      if (!['evidence.read', 'evidence.download', 'evidence.upload', 'evidence.scan', 'operation.read'].includes(action) || ['evidence.upload', 'evidence.scan'].includes(action) && m.role !== 'worker' ||
        !(await client.query('SELECT 1 FROM onboarding_fixture_evidence_grants WHERE tenant_id=$1 AND subject=$2 AND evidence_id=$3 FOR SHARE', [ctx.tenantId, ctx.subject, id])).rows.length) fail('FORBIDDEN', 403); return record;
    };
    const sources = { inspect: async (client, ctx, id, hash) => {
      const record = await evidenceAccess(client, ctx, 'evidence.download', id);
      if (!record.accepted || record.evidence.quarantine_state !== 'CLEAN' || record.evidence.sha256 !== hash) fail('FILE_NOT_CLEAN', 409);
      const raw = (await client.query('SELECT data FROM onboarding_fixture_raw_snapshots WHERE tenant_id=$1 AND evidence_id=$2 FOR SHARE', [ctx.tenantId, id])).rows[0]?.data;
      if (!raw || raw.sha256 !== hash) fail('CHECKSUM_MISMATCH', 422); return { evidence: record.evidence, rawSnapshot: raw };
    } };
    const decisions = { verify: async (client, ctx, request, ref) => {
      const m = await member(client, ctx), current = (await client.query('SELECT binding FROM onboarding_fixture_registry WHERE tenant_id=$1 FOR SHARE', [ctx.tenantId])).rows[0]?.binding;
      const row = (await client.query('SELECT * FROM onboarding_fixture_decisions WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE', [ctx.tenantId, ref?.id])).rows[0];
      if (!current?.enabled || !row || m.role !== 'reviewer' || row.data.approver !== ctx.subject || request.requested_for === ctx.subject ||
        row.data.subject_sha256 !== fingerprint(request) || fingerprint(row.data.policy_ref) !== fingerprint(current.policy_ref)) fail('FORBIDDEN', 403); return row.data;
    } };
    const scanner = new ClamavScanner({ host: '127.0.0.1', port: 33160, timeoutMs: 30000, freshnessMs: 86400000, engine: '1.4.6' });
    const storage = new MinioStorageService(); await storage.ensureBucket(); let service;
    const evidenceStore = new PostgresEvidenceStore(db), evidence = new EvidenceService(evidenceStore, new PrivateEvidenceStorage(storage), scanner, { check: (ctx, action, id, policyCheck) => db.transaction(client => evidenceAccess(client, ctx, action, id, policyCheck)).then(() => undefined) },
      'onboarding-fixture-private-evidence-cursor-at-least32bytes', Date.now, { read: (ctx, id) => service.operation(ctx, id) });
    const lineage = new PostgresLineageStore(db), sink = new OnboardingLineageWriter(lineage, sources);
    const store = new PostgresOnboardingStore(db, { capture: async (...args) => { await sink.capture(...args); if (flags.failCapture) { flags.failCapture = false; throw new Error('Injected failure after actual shared lineage SQL'); } } });
    service = new OnboardingService(store, runtime, evidence, sources, decisions); const worker = () => new OnboardingWorker(store, service, engine);
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }), jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'onboarding-ephemeral', use: 'sig', alg: 'RS256' };
    jwks = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); }); await new Promise(resolve => jwks.listen(0, '127.0.0.1', resolve));
    const issuer = 'http://127.0.0.1:' + jwks.address().port + '/realms/onboarding-fixture';
    Object.assign(process.env, { KEYCLOAK_ISSUER: issuer, KEYCLOAK_AUDIENCE: 'onboarding-fixture-api', KEYCLOAK_JWKS_URI: issuer + '/protocol/openid-connect/certs' });
    const sign = (alias = 'requester', options = {}, privateKey = keys.privateKey) => jwt.sign({ realm_access: { roles: ['admin'] } }, privateKey, { algorithm: 'RS256', keyid: jwk.kid, subject: contexts[alias].subject, issuer, audience: 'onboarding-fixture-api', expiresIn: '5m', ...options });
    const authority = { resolve: async (subject, selected) => {
      const rows = (await db.query('SELECT tenant_id FROM onboarding_fixture_members WHERE subject=$1 AND active AND ($2::uuid IS NULL OR tenant_id=$2)', [subject, selected || null])).rows;
      if (rows.length !== 1) fail('FORBIDDEN', 403); return { tenantId: rows[0].tenant_id, subject };
    }, authorize: async (ctx, action) => { if (action !== 'context.read') fail('FORBIDDEN', 403); await db.transaction(client => member(client, ctx)); } };
    const resolver = new MembershipEvidenceResolver(new AuthService(), authority);
    class FixtureModule {} Module({ imports: [OnboardingModule.register(service, resolver), EvidenceModule.register(evidence, resolver)] })(FixtureModule);
    app = await NestFactory.create(FixtureModule, { logger: false }); await app.listen(0, '127.0.0.1'); const origin = await app.getUrl();
    const api = async (method, route, body, expected = 200, alias = 'requester', headers = {}, token = sign(alias)) => {
      const res = await fetch(origin + route, { method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
      const value = await res.json(); assert.equal(res.status, expected, method + ' ' + route + ' => ' + value.code);
      if (route.startsWith('/packs/')) {
        if (expected < 400) assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
        const shape = expected >= 400 ? 'Error' : expected === 202 || route.includes('/operations/') ? 'Operation' : 'Case';
        const validate = ajv.getSchema(schema.$id + '#/definitions/' + shape); assert.equal(validate(value), true, JSON.stringify(validate.errors));
      } return value;
    };
    const create = () => api('POST', '/packs/onboarding/v1/cases', { display_label: 'FICTIONAL employee; no personal data' }, 201, 'requester', { 'Idempotency-Key': randomUUID() });
    const register = async () => {
      const bytes = Buffer.from('<?xml version="1.0"?><acknowledgement><subject>FICTIONAL employee</subject><policy>Acknowledged synthetic access policy</policy></acknowledgement>');
      const created = await evidence.register(contexts.worker, { filename: 'FICTIONAL-ack.xml', media_type: 'application/xml', size_bytes: bytes.length, sha256: checksum(bytes), source: { kind: 'USER_UPLOAD' }, retention_class: 'STANDARD' }, randomUUID());
      const e = created.evidence, snapshot = { ref: { pack_id: 'platform', type: 'evidence', id: e.id }, version: 'blob-1', sha256: e.sha256,
        metadata: { media_type: e.media_type, size_bytes: e.size_bytes, source_sha256: e.sha256, retention_class_at_registration: e.retention_class, created_at: e.created_at } };
      await db.query('INSERT INTO onboarding_fixture_raw_snapshots VALUES($1,$2,$3::jsonb)', [tenant, e.id, JSON.stringify(snapshot)]);
      for (const ctx of Object.values(contexts).filter(ctx => ctx.tenantId === tenant)) await db.query('INSERT INTO onboarding_fixture_evidence_grants VALUES($1,$2,$3)', [tenant, ctx.subject, e.id]);
      await evidence.upload(contexts.worker, e.id, { async *[Symbol.asyncIterator]() { yield bytes; } }, 'application/xml', randomUUID()); await evidence.processNextScan(contexts.worker);
      assert.equal((await evidence.detail(contexts.worker, e.id)).quarantine_state, 'CLEAN'); return { evidenceId: e.id, bytes, sha256: e.sha256 };
    };
    const checklist = async (id, evidenceId) => { for (const code of ['WELCOME_ACK', 'ACCESS_POLICY_ACK']) await api('POST', '/packs/onboarding/v1/cases/' + id + '/checklist/' + code, { evidence_id: evidenceId, acknowledged: true, expected_revision: 0 }, 200, 'requester', { 'Idempotency-Key': randomUUID() }); };
    const ready = async evidenceId => { const record = await create(); await checklist(record.id, evidenceId); await api('POST', '/packs/onboarding/v1/cases/' + record.id + '/access-requests', { access_profile: 'DOCS_READ_ONLY' }, 202, 'requester', { 'Idempotency-Key': randomUUID() }); return record.id; };
    const decision = async (id, action = 'APPROVE') => {
      const record = await store.read(contexts.requester, id), ref = { pack_id: 'platform', type: 'decision', id: randomUUID() };
      const content = { action, approver: contexts.reviewer.subject, request_sha256: record.requestHash, policy_ref: policy, source: 'SQL-backed owner decision fixture; no human review claim' };
      const value = { decision_ref: ref, action, approver: contexts.reviewer.subject, subject_ref: { pack_id: 'onboarding', type: 'access-request', id: record.request.id }, subject_sha256: record.requestHash,
        policy_ref: policy, decision_version: '1', approved_at: new Date().toISOString(), decision_snapshot: { ref, version: '1', sha256: fingerprint(content), metadata: content } };
      await db.query('INSERT INTO onboarding_fixture_decisions VALUES($1,$2,$3,$4::jsonb,true)', [tenant, ref.id, id, JSON.stringify(value)]); return ref;
    };
    const deciding = async (evidenceId, action = 'APPROVE') => { const id = await ready(evidenceId); assert.equal((await worker().processNext(contexts.worker)).state, 'SUCCEEDED');
      const ref = await decision(id, action); await api('POST', '/packs/onboarding/v1/cases/' + id + '/decisions', { decision_ref: ref }, 202, 'reviewer', { 'Idempotency-Key': randomUUID() }); return { id, ref }; };
    return { db, tenant, contexts, binding, runtime, sources, service, store, evidence, evidenceStore, storage, scanner, engineBase, engineCalls, flags, worker, api, sign, create, register, checklist, ready, decision, deciding, definition, fixtureStartedAt,
      close: async () => { await app.close(); await new Promise(resolve => jwks.close(resolve)); await db.onModuleDestroy(); } };
  } catch (error) { if (app) await app.close(); if (jwks) await new Promise(resolve => jwks.close(resolve)); await db.onModuleDestroy(); throw error; }
}
module.exports = { createFixture };
