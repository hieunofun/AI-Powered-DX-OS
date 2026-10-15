/* SPDX-License-Identifier: MIT */
'use strict';
// Explicit owner/identity/confirmation fixtures backed by actual SQL, never production #43/#50 adapters.
require('reflect-metadata');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { Module } = require('@nestjs/common'), { NestFactory } = require('@nestjs/core');
const root = path.resolve(__dirname, '../..'), load = file => require(path.join(root, 'apps/api/dist', file));
const { DatabaseService } = load('database/database.service.js'), { MinioStorageService } = load('storage/minio-storage.service.js');
const { EvidenceService } = load('platform/evidence/evidence.service.js'), { PostgresEvidenceStore } = load('platform/evidence/evidence.repository.js');
const { PrivateEvidenceStorage } = load('platform/evidence/evidence-storage.js'), { ClamavScanner } = load('platform/evidence/clamav.scanner.js');
const { EvidenceModule } = load('platform/evidence/evidence.module.js'), { EvidenceErrorFilter } = load('platform/evidence/evidence.controller.js');
const { AiMediationModule } = load('packs/openresolve/mediation/mediation.module.js'), { AiMediationService } = load('packs/openresolve/mediation/mediation.service.js');
const { PostgresMediationStore } = load('packs/openresolve/mediation/mediation.repository.js'), { TOOLS } = load('packs/openresolve/mediation/mediation-validation.js');
const { checksum, fingerprint } = load('platform/evidence/file-safety.js'), { fail } = load('platform/evidence/evidence.types.js');
async function createFixture() {
  Object.assign(process.env, { POSTGRES_HOST: '127.0.0.1', POSTGRES_PORT: '15454', POSTGRES_DB: 'mediation_issue54', POSTGRES_USER: 'mediation_fixture', POSTGRES_PASSWORD: 'mediation_fixture_local_only',
    MINIO_ENDPOINT: '127.0.0.1', MINIO_PORT: '19454', MINIO_USE_SSL: 'false', MINIO_BUCKET_INVOICES: 'mediation-issue54', MINIO_ACCESS_KEY: 'mediation_fixture', MINIO_SECRET_KEY: 'mediation_fixture_local_only' });
  const db = new DatabaseService(); let app;
  try {
    assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, 'mediation_issue54');
    for (const file of ['issue41-evidence-intake.sql', 'issue54-ai-mediation.sql']) await db.query(fs.readFileSync(path.join(root, 'database/proposed', file), 'utf8'));
    await db.query(`CREATE TABLE IF NOT EXISTS mediation_fixture_members(tenant_id UUID NOT NULL,subject TEXT NOT NULL,role TEXT NOT NULL,active BOOLEAN NOT NULL,PRIMARY KEY(tenant_id,subject));
      CREATE TABLE IF NOT EXISTS mediation_fixture_policies(tenant_id UUID NOT NULL,id UUID NOT NULL,version TEXT NOT NULL,enabled BOOLEAN NOT NULL,rules JSONB NOT NULL,PRIMARY KEY(tenant_id,id));
      CREATE TABLE IF NOT EXISTS mediation_fixture_cases(tenant_id UUID NOT NULL,id UUID NOT NULL,revision BIGINT NOT NULL,policy_id UUID NOT NULL,required_codes JSONB NOT NULL,PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,policy_id) REFERENCES mediation_fixture_policies(tenant_id,id));
      CREATE TABLE IF NOT EXISTS mediation_fixture_case_grants(tenant_id UUID NOT NULL,case_id UUID NOT NULL,subject TEXT NOT NULL,PRIMARY KEY(tenant_id,case_id,subject),FOREIGN KEY(tenant_id,case_id) REFERENCES mediation_fixture_cases(tenant_id,id),FOREIGN KEY(tenant_id,subject) REFERENCES mediation_fixture_members(tenant_id,subject));
      CREATE TABLE IF NOT EXISTS mediation_fixture_evidence_grants(tenant_id UUID NOT NULL,evidence_id UUID NOT NULL,subject TEXT NOT NULL,PRIMARY KEY(tenant_id,evidence_id,subject),FOREIGN KEY(tenant_id,evidence_id) REFERENCES platform_evidence_records(tenant_id,id),FOREIGN KEY(tenant_id,subject) REFERENCES mediation_fixture_members(tenant_id,subject));
      CREATE TABLE IF NOT EXISTS mediation_fixture_facts(tenant_id UUID NOT NULL,case_id UUID NOT NULL,id UUID NOT NULL,code TEXT NOT NULL,label TEXT NOT NULL,value TEXT NOT NULL,evidence_id UUID NOT NULL,evidence_hash CHAR(64) NOT NULL,version TEXT NOT NULL,PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,case_id,code),FOREIGN KEY(tenant_id,case_id) REFERENCES mediation_fixture_cases(tenant_id,id),FOREIGN KEY(tenant_id,evidence_id) REFERENCES platform_evidence_records(tenant_id,id));
      CREATE TABLE IF NOT EXISTS mediation_fixture_decisions(tenant_id UUID NOT NULL,id UUID NOT NULL,proposal_id UUID NOT NULL,proposal_hash CHAR(64) NOT NULL,policy_hash CHAR(64) NOT NULL,approver TEXT NOT NULL,version TEXT NOT NULL,state TEXT NOT NULL,approved_at TIMESTAMPTZ NOT NULL,PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,proposal_id) REFERENCES openresolve_ai_proposals(tenant_id,id),FOREIGN KEY(tenant_id,approver) REFERENCES mediation_fixture_members(tenant_id,subject));
      CREATE TABLE IF NOT EXISTS mediation_fixture_actions(tenant_id UUID NOT NULL,proposal_id UUID NOT NULL,case_id UUID NOT NULL,id UUID NOT NULL,data JSONB NOT NULL,sha256 CHAR(64) NOT NULL,PRIMARY KEY(tenant_id,proposal_id),FOREIGN KEY(tenant_id,proposal_id) REFERENCES openresolve_ai_proposals(tenant_id,id),FOREIGN KEY(tenant_id,case_id) REFERENCES mediation_fixture_cases(tenant_id,id));
      DROP TRIGGER IF EXISTS mediation_fixture_actions_immutable ON mediation_fixture_actions;
      CREATE TRIGGER mediation_fixture_actions_immutable BEFORE UPDATE OR DELETE ON mediation_fixture_actions FOR EACH ROW EXECUTE FUNCTION openresolve_ai_append_only()`);
    const tenant = randomUUID(), foreignTenant = randomUUID(), caseId = randomUUID(), policyId = randomUUID(), foreignCase = randomUUID(), foreignPolicy = randomUUID();
    const contexts = { requester: { tenantId: tenant, subject: 'fixture-requester' }, worker: { tenantId: tenant, subject: 'fixture-worker' }, approver: { tenantId: tenant, subject: 'fixture-approver' }, foreign: { tenantId: foreignTenant, subject: 'fixture-requester' } };
    for (const [name, ctx] of Object.entries(contexts)) await db.query('INSERT INTO mediation_fixture_members VALUES($1,$2,$3,true)', [ctx.tenantId, ctx.subject, name === 'worker' ? 'PROCESSOR' : name === 'approver' ? 'APPROVER' : 'REQUESTER']);
    for (const [tenantId, po, id] of [[tenant, policyId, caseId], [foreignTenant, foreignPolicy, foreignCase]]) {
      await db.query('INSERT INTO openresolve_ai_controls(tenant_id,enabled,revision) VALUES($1,true,1)', [tenantId]);
      await db.query('INSERT INTO mediation_fixture_policies VALUES($1,$2,$3,true,$4::jsonb)', [tenantId, po, '1.0.0', JSON.stringify({ allowed: Object.keys(TOOLS), approval: ['R1', 'R2'] })]);
      await db.query('INSERT INTO mediation_fixture_cases VALUES($1,$2,1,$3,$4::jsonb)', [tenantId, id, po, JSON.stringify(['SUPPLIER', 'RECEIPT'])]);
    }
    for (const [name, ctx] of Object.entries(contexts)) await db.query('INSERT INTO mediation_fixture_case_grants VALUES($1,$2,$3)', [ctx.tenantId, name === 'foreign' ? foreignCase : caseId, ctx.subject]);
    const member = async (client, ctx) => {
      const value = (await client.query('SELECT role FROM mediation_fixture_members WHERE tenant_id=$1 AND subject=$2 AND active FOR SHARE', [ctx.tenantId, ctx.subject])).rows[0];
      if (!value) fail('FORBIDDEN', 403); return value;
    };
    const grant = async (client, ctx, id) => {
      if (!(await client.query('SELECT 1 FROM mediation_fixture_case_grants WHERE tenant_id=$1 AND subject=$2 AND case_id=$3 FOR SHARE', [ctx.tenantId, ctx.subject, id])).rows.length) fail('NOT_FOUND', 404);
    };
    const source = { authorize: async (client, ctx, action, id) => {
      const m = await member(client, ctx); if (id) await grant(client, ctx, id);
      const roles = { 'ai.explain': ['REQUESTER', 'PROCESSOR', 'APPROVER'], 'ai.process': ['PROCESSOR'], 'ai.propose': ['REQUESTER'], 'ai.approve': ['APPROVER'], 'ai.execute': ['REQUESTER', 'PROCESSOR'] };
      if (!roles[action]?.includes(m.role)) fail('FORBIDDEN', 403);
    }, load: async (client, ctx, id) => {
      await member(client, ctx); await grant(client, ctx, id);
      const row = (await client.query(`SELECT c.revision::text,c.required_codes,p.id AS policy_id,p.version,p.rules,p.enabled FROM mediation_fixture_cases c JOIN mediation_fixture_policies p ON p.tenant_id=c.tenant_id AND p.id=c.policy_id
        WHERE c.tenant_id=$1 AND c.id=$2 FOR UPDATE OF c FOR SHARE OF p`, [ctx.tenantId, id])).rows[0]; if (!row) fail('NOT_FOUND', 404);
      const rows = (await client.query(`SELECT f.*,e.data FROM mediation_fixture_facts f JOIN platform_evidence_records e ON e.tenant_id=f.tenant_id AND e.id=f.evidence_id
        WHERE f.tenant_id=$1 AND f.case_id=$2 ORDER BY f.code FOR SHARE OF f,e`, [ctx.tenantId, id])).rows;
      for (const f of rows) {
        if (!(await client.query('SELECT 1 FROM mediation_fixture_evidence_grants WHERE tenant_id=$1 AND subject=$2 AND evidence_id=$3 FOR SHARE', [ctx.tenantId, ctx.subject, f.evidence_id])).rows.length) fail('FORBIDDEN', 403);
        if (!f.data.accepted || f.data.evidence.quarantine_state !== 'CLEAN' || f.data.evidence.sha256 !== f.evidence_hash || f.data.evidence.retention_class !== 'STANDARD') fail('FILE_NOT_CLEAN', 409);
      }
      const content = { tenantId: ctx.tenantId, caseRef: { pack_id: 'openresolve', type: 'case', id }, version: row.revision,
        policy: { ref: { pack_id: 'platform', type: 'policy', id: row.policy_id }, version: row.version, sha256: fingerprint({ id: row.policy_id, version: row.version, rules: row.rules }) },
        facts: rows.map(f => ({ id: f.id, code: f.code, label: f.label, value: f.value, evidenceId: f.evidence_id, evidenceHash: f.evidence_hash, factsVersion: f.version })),
        requiredFactCodes: row.required_codes, disclosure: 'SYNTHETIC' };
      return { ...content, hash: fingerprint(content) };
    } };
    const access = { check: async (ctx, action, id, policy) => db.transaction(async client => {
      const m = await member(client, ctx); if (policy?.retentionClass === 'RESTRICTED') fail('FORBIDDEN', 403);
      if (!id) { if (m.role !== 'PROCESSOR' || !['evidence.register', 'evidence.scan', 'evidence.read'].includes(action)) fail('FORBIDDEN', 403); return; }
      if (!['evidence.register', 'evidence.read', 'evidence.download', 'evidence.upload', 'evidence.scan', 'operation.read'].includes(action)) fail('FORBIDDEN', 403);
      const found = (await client.query('SELECT data FROM platform_evidence_records WHERE tenant_id=$1 AND id=$2', [ctx.tenantId, id])).rows[0]; if (!found) fail('NOT_FOUND', 404);
      // EvidenceService reauthorizes the just-created registration before returning its ID.
      // Only its actual current processor/creator can pass; explicit read grants are added next.
      if (action === 'evidence.register') {
        if (m.role !== 'PROCESSOR' || found.data.evidence.created_by !== ctx.subject || found.data.evidence.retention_class !== 'STANDARD') fail('FORBIDDEN', 403); return;
      }
      if (!(await client.query('SELECT 1 FROM mediation_fixture_evidence_grants WHERE tenant_id=$1 AND subject=$2 AND evidence_id=$3', [ctx.tenantId, ctx.subject, id])).rows.length ||
        found.data.evidence.retention_class !== 'STANDARD' || ['evidence.upload', 'evidence.scan'].includes(action) && m.role !== 'PROCESSOR') fail('FORBIDDEN', 403);
    }) };
    const scanner = new ClamavScanner({ host: '127.0.0.1', port: 33154, timeoutMs: 30000, freshnessMs: 86400000, engine: '1.4.6' });
    let service; const evidence = new EvidenceService(new PostgresEvidenceStore(db), new PrivateEvidenceStorage(new MinioStorageService()), scanner, access,
      'mediation-fixture-evidence-cursor-key-v1-at-least32bytes', Date.now, { read: (ctx, id) => service.operation(ctx, id) });
    const flags = { onSelect: undefined, failAfterExecution: false }, calls = { provider: 0, executor: 0 };
    const provider = { select: async (input, _disclosure, recheck) => {
      calls.provider++; await recheck(); if (flags.onSelect) { const work = flags.onSelect; flags.onSelect = undefined; await work(); } await recheck();
      return { fact_aliases: input.facts.map(f => f.alias), suggested_tool: 'NONE', provenance: { provider: 'gemini', model_version: 'gemini-fixture-double', prompt_version: 'labelled-runtime-double-v1', run_id: randomUUID() }, usage: { input_tokens: 1, reserved_tokens: 1 } };
    } };
    const policy = { evaluate: async (client, ctx, snapshot, action) => {
      const row = (await client.query('SELECT id,version,rules,enabled FROM mediation_fixture_policies WHERE tenant_id=$1 AND id=$2 FOR SHARE', [ctx.tenantId, snapshot.policy.ref.id])).rows[0];
      return { effect: row?.enabled && row.rules.allowed.includes(action.tool) ? 'ALLOW' : 'DENY', policyHash: row ? fingerprint({ id: row.id, version: row.version, rules: row.rules }) : '', risk: TOOLS[action.tool], requiresApproval: TOOLS[action.tool] !== 'R0' };
    } };
    const approvals = { verify: async (client, ctx, proposal, ref) => {
      await source.authorize(client, ctx, 'ai.approve', proposal.caseId);
      const row = (await client.query('SELECT * FROM mediation_fixture_decisions WHERE tenant_id=$1 AND id=$2 AND proposal_id=$3 FOR SHARE', [ctx.tenantId, ref.id, proposal.id])).rows[0];
      if (!row || row.state !== 'APPROVED' || row.approver !== ctx.subject || row.approver === proposal.requester) fail('FORBIDDEN', 403);
      return { decisionRef: ref, proposalHash: row.proposal_hash, policyHash: row.policy_hash, approver: row.approver, decisionVersion: row.version, approvedAt: row.approved_at.toISOString(), state: 'APPROVED' };
    } };
    const executor = { executeInTransaction: async (client, ctx, snapshot, proposal) => {
      calls.executor++; await source.authorize(client, ctx, 'ai.execute', proposal.caseId);
      if (proposal.input.tool === 'case.read_summary' || !['case.request_evidence', 'case.add_note'].includes(proposal.input.tool) || snapshot.caseRef.id !== proposal.caseId) fail('FORBIDDEN', 403);
      const at = new Date().toISOString(), id = randomUUID(), payload = { tenant_id: ctx.tenantId, case_id: proposal.caseId, actor: ctx.subject, input: proposal.input, proposal_sha256: proposal.hash, decision_ref: proposal.approval.decisionRef, at }, hash = fingerprint(payload);
      await client.query('INSERT INTO mediation_fixture_actions VALUES($1,$2,$3,$4,$5::jsonb,$6)', [ctx.tenantId, proposal.id, proposal.caseId, id, JSON.stringify(payload), hash]);
      if (flags.failAfterExecution) { flags.failAfterExecution = false; throw new Error('Injected failure after actual fixture action SQL'); }
      return { action_id: proposal.id, resource_ref: { pack_id: 'openresolve', type: 'case-action', id }, sha256: hash, executed_at: at };
    } };
    const store = new PostgresMediationStore(db), createService = () => new AiMediationService(store, source, evidence, provider, policy, approvals, executor); service = createService();
    const resolver = { resolve: async request => {
      const alias = request.header('Authorization')?.replace(/^Bearer fixture-/, ''), ctx = contexts[alias]; if (!ctx) fail('UNAUTHENTICATED', 401);
      await db.transaction(client => member(client, ctx)); return ctx;
    } };
    class FixtureModule {};
    Module({ imports: [AiMediationModule.register(service, resolver), EvidenceModule.register(evidence, resolver)] })(FixtureModule);
    app = await NestFactory.create(FixtureModule, { logger: false }); app.useGlobalFilters(new EvidenceErrorFilter()); await app.listen(0, '127.0.0.1');
    async function register(bytes, filename) {
      const created = await evidence.register(contexts.worker, { filename, media_type: 'application/xml', size_bytes: bytes.length, sha256: checksum(bytes), retention_class: 'STANDARD', source: { kind: 'USER_UPLOAD' } }, randomUUID());
      for (const [alias, ctx] of Object.entries(contexts)) if (alias !== 'foreign') await db.query('INSERT INTO mediation_fixture_evidence_grants VALUES($1,$2,$3)', [tenant, created.evidence.id, ctx.subject]);
      await evidence.upload(contexts.worker, created.evidence.id, { async *[Symbol.asyncIterator]() { yield bytes; } }, 'application/xml', randomUUID()); return created.evidence.id;
    }
    async function prepareEvidence() {
      const cleanId = await register(Buffer.from('<?xml version="1.0"?><fixture><supplier>FICTIONAL Supplier</supplier></fixture>'), 'FICTIONAL-case-evidence.xml');
      await evidence.processNextScan(contexts.worker); assert.equal((await evidence.detail(contexts.worker, cleanId)).quarantine_state, 'CLEAN');
      const hash = (await evidence.detail(contexts.worker, cleanId)).sha256, factId = randomUUID();
      await db.query('INSERT INTO mediation_fixture_facts VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [tenant, caseId, factId, 'SUPPLIER', 'Confirmed fictional supplier', 'FICTIONAL Supplier', cleanId, hash, 'fixture-reviewed-1']);
      const unscannedId = await register(Buffer.from('<?xml version="1.0"?><fixture>Unscanned synthetic source</fixture>'), 'FICTIONAL-unscanned.xml');
      return { cleanId, unscannedId, factId, hash };
    }
    async function decision(proposalId) {
      const proposal = (await db.query('SELECT data FROM openresolve_ai_proposals WHERE tenant_id=$1 AND id=$2', [tenant, proposalId])).rows[0]?.data;
      if (!proposal) fail('NOT_FOUND', 404); const ref = { pack_id: 'platform', type: 'decision', id: randomUUID() };
      await db.query('INSERT INTO mediation_fixture_decisions VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [tenant, ref.id, proposal.id, proposal.hash, proposal.policyHash, contexts.approver.subject, '1', 'APPROVED', new Date().toISOString()]); return ref;
    }
    return { db, app, origin: await app.getUrl(), contexts, caseId, foreignCase, policyId, flags, calls, store, service, scanner, evidence, prepareEvidence, decision, createService,
      close: async () => { await app.close(); await db.onModuleDestroy(); } };
  } catch (error) { if (app) await app.close(); await db.onModuleDestroy(); throw error; }
}
module.exports = { createFixture };
