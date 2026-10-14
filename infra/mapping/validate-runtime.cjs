/* SPDX-License-Identifier: MIT */
'use strict';
// Real storage/scanner/database/Gemini mapping. Upstream OCR is an explicitly labelled fixture bootstrap.
require('reflect-metadata');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { randomUUID, createHash } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { Module } = require('@nestjs/common'), { NestFactory } = require('@nestjs/core');
const root = path.resolve(__dirname, '../..'), load = name => require(path.join(root, 'apps/api/dist', name));
const { DatabaseService } = load('database/database.service.js'), { MinioStorageService } = load('storage/minio-storage.service.js');
const { EvidenceService } = load('platform/evidence/evidence.service.js'), { EvidenceModule } = load('platform/evidence/evidence.module.js');
const { PostgresEvidenceStore } = load('platform/evidence/evidence.repository.js'), { PrivateEvidenceStorage } = load('platform/evidence/evidence-storage.js'), { ClamavScanner } = load('platform/evidence/clamav.scanner.js');
const { DraftService } = load('platform/extraction/draft.service.js'), { PostgresDraftStore } = load('platform/extraction/draft.repository.js');
const { InvoiceDraftProfile, invoiceFields } = load('packs/openresolve/extraction/invoice-draft.profile.js'), { InvoiceDraftTarget } = load('packs/openresolve/extraction/invoice-draft.target.js');
const { PostgresReviewedMappingSource } = load('packs/openresolve/mapping/reviewed-mapping.source.js'), { PostgresMappingStore } = load('packs/openresolve/mapping/mapping.repository.js');
const { ReviewedMappingService } = load('packs/openresolve/mapping/mapping.service.js'), { ReviewedMappingEngine } = load('packs/openresolve/mapping/mapping-engine.js');
const { PostgresMappingOutbox } = load('packs/openresolve/mapping/mapping-outbox.target.js'), { ReviewedMappingModule } = load('packs/openresolve/mapping/mapping.module.js');
const { GeminiMappingProvider } = load('packs/openresolve/mapping/gemini-mapping.provider.js'), { geminiConfig } = load('ai/extraction/provider-config.js'), { LocalProviderBudget } = load('ai/extraction/provider-budget.js');
const { checksum, fingerprint } = load('platform/evidence/file-safety.js'), { fail } = load('platform/evidence/evidence.types.js');
const Ajv = require('ajv'), ajv = new Ajv({ allErrors: true });
const base = require(path.join(root, 'packages/contracts/opendx/v1/schemas/platform.schema.json')), schema = require(path.join(root, 'packages/contracts/opendx/proposed/issue25-mapping.schema.json'));
ajv.addSchema(base); ajv.addSchema(schema);
const started = new Date().toISOString(), checks = [], resources = {}, ctx = { tenantId: randomUUID(), subject: 'mapping-runtime-fixture-reviewer' }, foreign = { tenantId: randomUUID(), subject: ctx.subject };
let db, app, origin, mapping, evidence, store, budget, failAfterOutbox = false;
async function check(name, work) { try { await work(); checks.push({ name, status: 'PASS' }); console.log('PASS ' + name); }
  catch (error) { checks.push({ name, status: 'FAIL', code: error.code || error.name }); throw error; } }
function shape(name, value) { const source = ['Operation', 'Error', 'RegistrationResult', 'Evidence', 'EvidencePage'].includes(name) ? base : schema;
  assert.equal(ajv.getSchema(source.$id + '#/definitions/' + name)(value), true, 'Contract mismatch: ' + name); }
async function api(method, route, body, status = 200, identity = 'member', headers = {}) {
  const response = await fetch(origin + route, { method, headers: { Authorization: 'Bearer fixture-' + identity,
    ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  assert.equal(response.status, status, method + ' ' + route); const value = await response.json();
  shape(status >= 400 ? 'Error' : status === 201 ? 'RegistrationResult' : route.endsWith('/confirmations') ? 'Decision' : status === 202 || route.includes('/operations/') ? 'Operation' : 'View', value); return value;
}
const command = () => ({ 'Idempotency-Key': randomUUID() });
const prefix = '/apps/openresolve/v1/';
async function main() {
  if (!process.argv.includes('--live')) throw new Error('Explicit --live required');
  Object.assign(process.env, { POSTGRES_HOST: '127.0.0.1', POSTGRES_PORT: '15425', POSTGRES_DB: 'mapping_issue25', POSTGRES_USER: 'mapping_fixture', POSTGRES_PASSWORD: 'mapping_fixture_local_only',
    MINIO_ENDPOINT: '127.0.0.1', MINIO_PORT: '19425', MINIO_USE_SSL: 'false', MINIO_BUCKET_INVOICES: 'mapping-issue25', MINIO_ACCESS_KEY: 'mapping_fixture', MINIO_SECRET_KEY: 'mapping_fixture_local_only' });
  db = new DatabaseService(); assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, 'mapping_issue25');
  await db.query(`CREATE TABLE IF NOT EXISTS mapping_fixture_memberships(tenant_id UUID NOT NULL,subject TEXT NOT NULL,active BOOLEAN NOT NULL,PRIMARY KEY(tenant_id,subject));
    CREATE TABLE IF NOT EXISTS mapping_fixture_orders(tenant_id UUID NOT NULL,id UUID NOT NULL,seller TEXT NOT NULL,buyer TEXT NOT NULL,currency TEXT NOT NULL,PRIMARY KEY(tenant_id,id));
    CREATE TABLE IF NOT EXISTS mapping_fixture_items(tenant_id UUID NOT NULL,purchase_order_id UUID NOT NULL,id UUID NOT NULL,sku TEXT,description TEXT NOT NULL,PRIMARY KEY(tenant_id,id),
      FOREIGN KEY(tenant_id,purchase_order_id) REFERENCES mapping_fixture_orders(tenant_id,id))`);
  for (const context of [ctx, foreign]) await db.query('INSERT INTO mapping_fixture_memberships VALUES($1,$2,true)', [context.tenantId, context.subject]);
  const access = { check: async (context, action, id) => {
    if (!(await db.query('SELECT 1 FROM mapping_fixture_memberships WHERE tenant_id=$1 AND subject=$2 AND active', [context.tenantId, context.subject])).rows.length) fail('FORBIDDEN', 403);
    if (!new Set(['evidence.register', 'evidence.read', 'evidence.upload', 'evidence.scan', 'evidence.download', 'operation.read', 'extraction.request', 'extraction.read', 'extraction.confirm', 'mapping.request', 'mapping.read', 'mapping.confirm']).has(action)) fail('FORBIDDEN', 403);
    if (id && !(await db.query('SELECT 1 FROM platform_evidence_records WHERE tenant_id=$1 AND id=$2', [context.tenantId, id])).rows.length) fail('NOT_FOUND', 404);
  } };
  const raw = new PostgresEvidenceStore(db), scanner = new ClamavScanner({ host: '127.0.0.1', port: 33125, timeoutMs: 30000, freshnessMs: 86400000, engine: '1.4.6' });
  await check('real scanner exact engine/fresh definitions/complete stream', async () => assert.equal((await scanner.scan(Buffer.from('Fictional reviewed mapping readiness'))).state, 'CLEAN'));
  let drafts;
  evidence = new EvidenceService(raw, new PrivateEvidenceStorage(new MinioStorageService()), scanner, access, 'isolated-reviewed-mapping-cursor-secret-v1', Date.now,
    { read: async (c, id) => await drafts.operation(c, id) || await mapping.operation(c, id) });
  const corpus = path.join(root, 'infra/ocr/fixtures/vn-reviewed-v1'), manifest = require(path.join(corpus, 'manifest.json'));
  const entry = manifest.cases.find(item => item.id === 'dev-digital'), bytes = fs.readFileSync(path.join(corpus, entry.source)); assert.equal(checksum(bytes), entry.sha256);
  // Known labels prepare upstream state only. This is not measured OCR and makes no all-real end-to-end OCR claim.
  const gold = require(path.join(corpus, entry.label)).values, profile = new InvoiceDraftProfile();
  const binding = { verify: async (context, payload) => {
    const order = (await db.query('SELECT seller,buyer,currency FROM mapping_fixture_orders WHERE tenant_id=$1 AND id=$2', [context.tenantId, payload.purchase_order_id])).rows[0];
    if (!order || order.seller !== payload.seller_tax_code || order.buyer !== payload.buyer_tax_code || order.currency !== payload.currency) fail('FORBIDDEN', 403);
  } };
  await db.query('INSERT INTO mapping_fixture_orders VALUES($1,$2,$3,$4,$5)', [ctx.tenantId, gold['/purchase_order_id'], gold['/seller_tax_code'], gold['/buyer_tax_code'], gold['/currency']]);
  const foreignPo = randomUUID(); await db.query('INSERT INTO mapping_fixture_orders VALUES($1,$2,$3,$4,$5)', [foreign.tenantId, foreignPo, 'foreign-synthetic', 'foreign-synthetic', 'VND']);
  const selected = randomUUID(), alternative = randomUUID(), foreignItem = randomUUID(); resources.selectedPoItemId = selected;
  for (const values of [[ctx.tenantId, gold['/purchase_order_id'], selected, 'CE285A', 'Hộp mực laser HP CE285A, alias HP 85A'],
    [ctx.tenantId, gold['/purchase_order_id'], alternative, 'A4-80', 'Giấy in A4 80gsm'], [foreign.tenantId, foreignPo, foreignItem, 'CE285A', 'Fictional foreign catalog item']]) await db.query('INSERT INTO mapping_fixture_items VALUES($1,$2,$3,$4,$5)', values);
  const catalog = { list: async (context, poId) => (await db.query('SELECT id,tenant_id AS "tenantId",purchase_order_id AS "purchaseOrderId",sku,description FROM mapping_fixture_items WHERE tenant_id=$1 AND purchase_order_id=$2 ORDER BY id', [context.tenantId, poId])).rows };
  const source = new PostgresReviewedMappingSource(db, access, binding, catalog);
  const at = process.argv.indexOf('--env-file'); if (at === -1) throw new Error('Ignored server-side --env-file required');
  const credentials = Object.fromEntries(fs.readFileSync(path.resolve(process.argv[at + 1]), 'utf8').split(/\r?\n/).filter(line => /^(GEMINI_API_KEY|GEMINI_MODEL)=/.test(line))
    .map(line => { const end = line.indexOf('='); return [line.slice(0, end), line.slice(end + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
  const config = geminiConfig({ ...credentials, AI_DOCUMENT_POLICY: 'synthetic-only', AI_REQUESTS_PER_MINUTE: '8', AI_REQUESTS_PER_DAY: '8', AI_TOKENS_PER_DAY: '30000' }); budget = new LocalProviderBudget(config);
  const durableTarget = new PostgresMappingOutbox({ check: async (client, context, decision) => {
    if (!(await client.query('SELECT 1 FROM mapping_fixture_memberships WHERE tenant_id=$1 AND subject=$2 AND active FOR SHARE', [context.tenantId, context.subject])).rows.length) fail('FORBIDDEN', 403);
    if (!(await client.query('SELECT 1 FROM mapping_fixture_orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [context.tenantId, decision.purchase_order_id])).rows.length) fail('NOT_FOUND', 404);
    const items = (await client.query('SELECT id,tenant_id AS "tenantId",purchase_order_id AS "purchaseOrderId",sku,description FROM mapping_fixture_items WHERE tenant_id=$1 AND purchase_order_id=$2 ORDER BY id FOR SHARE', [context.tenantId, decision.purchase_order_id])).rows;
    if (!items.some(item => item.id === decision.selected_po_item_id)) fail('NOT_FOUND', 404);
    if (fingerprint(items) !== decision.catalog_revision) fail('REVISION_CONFLICT', 409);
  } });
  store = new PostgresMappingStore(db);
  mapping = new ReviewedMappingService(store, source, evidence, access, new ReviewedMappingEngine(new GeminiMappingProvider(config, undefined, budget)),
    { resolve: async (context, id) => { if ((await raw.read(context, id))?.evidence.sha256 !== entry.sha256) fail('FORBIDDEN', 403); return 'SYNTHETIC'; } },
    { enqueue: async (...args) => { await durableTarget.enqueue(...args); if (failAfterOutbox) { failAfterOutbox = false; throw new Error('Injected failure after actual mapping outbox SQL'); } } });
  const bootstrap = { extract: async (_context, id) => {
    const fields = invoiceFields(1).map(field => ({ path: field.path, kind: field.kind, status: gold[field.path] === null ? 'MISSING' : 'EXTRACTED', ...(gold[field.path] === null ? {} : { value: gold[field.path] }), source_refs: [{ location_status: 'UNKNOWN', evidence_id: id, reason: 'MISSING_SOURCE' }] }));
    const run = { state: 'REVIEW_REQUIRED', evidence_id: id, schema_id: profile.id, fields, extractor: { provider: 'labelled-fixture-bootstrap', model_version: 'not-ocr-measurement', prompt_version: 'none', run_id: randomUUID() }, usage: { input_tokens: 0, reserved_tokens: 0 } };
    return { fields, runs: [run] };
  } };
  drafts = new DraftService(new PostgresDraftStore(db), evidence, bootstrap, [profile], access, new InvoiceDraftTarget(binding));
  const resolver = { resolve: async request => { if (request.header('Authorization') === 'Bearer fixture-member') return ctx;
    if (request.header('Authorization') === 'Bearer fixture-foreign') return foreign; fail('UNAUTHENTICATED', 401); } };
  class FixtureModule {};
  Module({ imports: [EvidenceModule.register(evidence, resolver), ReviewedMappingModule.register(mapping, resolver)] })(FixtureModule);
  app = await NestFactory.create(FixtureModule, { logger: false }); await app.listen(0, '127.0.0.1'); origin = await app.getUrl();
  const registered = await api('POST', '/platform/v1/evidence', { filename: 'synthetic-reviewed-mapping.pdf', media_type: 'application/pdf', size_bytes: bytes.length, sha256: entry.sha256, source: { kind: 'USER_UPLOAD' }, retention_class: 'STANDARD' }, 201, 'member', command());
  resources.evidenceId = registered.evidence.id;
  await api('PUT', registered.upload.href, bytes, 202, 'member', { ...command(), 'Content-Type': 'application/pdf' }); await evidence.processNextScan(ctx);
  const extracted = await drafts.request(ctx, resources.evidenceId, { schema_id: profile.id, mode: 'OCR' }, randomUUID()); await drafts.processNext(ctx);
  const draft = await drafts.detail(ctx, extracted.resource_ref.id);
  const confirmed = await drafts.confirm(ctx, draft.id, { expected_revision: draft.revision, reviewed_field_paths: profile.requiredPaths(draft.fields) }, randomUUID()); resources.confirmationId = confirmed.id;
  await check('actual confirmed immutable facts and tenant/PO-predicated catalog exclude foreign items', async () => {
    const snapshot = await source.snapshot(ctx, confirmed.id, '/lines/0'); assert.ok(snapshot.candidates.length === 2); assert.ok(!snapshot.candidates.some(item => item.id === foreignItem));
    await assert.rejects(source.snapshot(foreign, confirmed.id, '/lines/0'), error => error.code === 'NOT_FOUND');
  });
  const route = prefix + 'verified-invoices/' + confirmed.id + '/item-mapping-suggestions', key = command();
  const operation = await api('POST', route, { line_path: '/lines/0' }, 202, 'member', key); resources.mappingId = operation.resource_ref.id;
  const begin = performance.now(); await mapping.processNext(ctx); resources.mappingMs = Math.round(performance.now() - begin);
  const view = await api('GET', prefix + 'item-mapping-suggestions/' + resources.mappingId); resources.suggestion = view.suggestion;
  const count = async table => Number((await db.query('SELECT COUNT(*) FROM ' + table + ' WHERE tenant_id=$1', [ctx.tenantId])).rows[0].count);
  await check('actual mapping provider/deterministic suggestion cannot dispatch until human review', async () => {
    shape('Suggestion', view.suggestion); assert.equal(view.suggestion.state, 'REVIEW_REQUIRED'); assert.equal(await count('openresolve_mapping_decisions'), 0); assert.equal(await count('openresolve_mapping_outbox'), 0);
    assert.deepEqual(await api('POST', route, { line_path: '/lines/0' }, 202, 'member', key), operation);
  });
  const confirmationRoute = prefix + 'item-mapping-suggestions/' + resources.mappingId + '/confirmations';
  const body = { expected_revision: view.revision, selected_po_item_id: selected, reason: 'Explicit fixture reviewer verified original document and own PO item' };
  await check('foreign IDs and client actor cannot create a mapping decision', async () => {
    await api('GET', prefix + 'item-mapping-suggestions/' + resources.mappingId, undefined, 404, 'foreign');
    await api('POST', confirmationRoute, body, 404, 'foreign', command());
    await api('POST', confirmationRoute, { ...body, selected_po_item_id: foreignItem }, 404, 'member', command());
    await api('POST', confirmationRoute, { ...body, actor_subject: 'injected-admin' }, 400, 'member', command());
  });
  await check('real decision/outbox insert followed by injected error rolls back all reviewed state', async () => {
    failAfterOutbox = true; await api('POST', confirmationRoute, body, 503, 'member', command());
    assert.equal(await count('openresolve_mapping_decisions'), 0); assert.equal(await count('openresolve_mapping_outbox'), 0); assert.equal((await mapping.detail(ctx, resources.mappingId)).revision, view.revision);
  });
  await check('catalog version change blocks a stale human selection in the real database', async () => {
    await db.transaction(async client => { await client.query('SELECT 1 FROM mapping_fixture_orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [ctx.tenantId, body.purchase_order_id || gold['/purchase_order_id']]);
      await client.query('UPDATE mapping_fixture_items SET description=description||$3 WHERE tenant_id=$1 AND id=$2', [ctx.tenantId, alternative, ' changed']); });
    await api('POST', confirmationRoute, body, 409, 'member', command());
    await db.transaction(async client => { await client.query('SELECT 1 FROM mapping_fixture_orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [ctx.tenantId, gold['/purchase_order_id']]);
      await client.query('UPDATE mapping_fixture_items SET description=$3 WHERE tenant_id=$1 AND id=$2', [ctx.tenantId, alternative, 'Giấy in A4 80gsm']); });
  });
  await check('recorded human mapping and replay preserve original suggestion and one PENDING outbox', async () => {
    const key = command(), first = await api('POST', confirmationRoute, body, 202, 'member', key), repeat = await api('POST', confirmationRoute, body, 202, 'member', key);
    assert.deepEqual(repeat, first); assert.equal(first.actor_subject, ctx.subject); assert.equal(first.dispatch_state, 'PENDING');
    assert.equal(await count('openresolve_mapping_decisions'), 1); assert.equal(await count('openresolve_mapping_outbox'), 1);
    assert.deepEqual((await mapping.detail(ctx, resources.mappingId)).suggestion, view.suggestion); resources.decisionId = first.id;
    await assert.rejects(db.query('UPDATE openresolve_mapping_decisions SET data=data WHERE tenant_id=$1', [ctx.tenantId]), /append-only/);
  });
  await check('transactional target independently denies a foreign item despite a valid existing decision ID', async () => {
    const decision = (await mapping.detail(ctx, resources.mappingId)).decision;
    await assert.rejects(db.transaction(client => durableTarget.enqueue(client, ctx, { ...decision, selected_po_item_id: foreignItem })), error => error.code === 'NOT_FOUND');
    assert.equal(await count('openresolve_mapping_outbox'), 1);
  });
  await check('current SQL membership revocation blocks queued worker before any further provider request', async () => {
    await api('POST', route, { line_path: '/lines/0' }, 202, 'member', command()); const attempts = budget.snapshot().request_attempts;
    await db.query('UPDATE mapping_fixture_memberships SET active=false WHERE tenant_id=$1 AND subject=$2', [ctx.tenantId, ctx.subject]);
    await assert.rejects(mapping.processNext(ctx), error => error.code === 'FORBIDDEN');
    assert.equal(budget.snapshot().request_attempts, attempts);
    await db.query('UPDATE mapping_fixture_memberships SET active=true WHERE tenant_id=$1 AND subject=$2', [ctx.tenantId, ctx.subject]);
  });
}
main().catch(error => { console.error('FAIL mapping runtime: ' + (error.code || error.name) + ' ' + String(error.message).slice(0, 300)); process.exitCode = 1; }).finally(async () => {
  if (app) await app.close(); if (db) await db.onModuleDestroy();
  const folder = 'apps/api/src/packs/openresolve/mapping', sourceHashes = Object.fromEntries(fs.readdirSync(path.join(root, folder)).filter(file => file.endsWith('.ts') && !file.endsWith('.spec.ts')).sort()
    .map(file => [folder + '/' + file, createHash('sha256').update(fs.readFileSync(path.join(root, folder, file))).digest('hex')]));
  const report = { started, completed: new Date().toISOString(), gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), worktreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
    sourceHashes, environment: { node: process.version, services: 'real PostgreSQL/MinIO/ClamAV and actual mapping Gemini when deterministic path is unresolved',
      identity: 'static server fixture resolver; actual SQL active membership/tenant/PO checks; not production SSO/#43', upstreamOCR: 'labelled fixture bootstrap only; actual OCR is separately measured by #26', failure: 'injected exception after actual SQL outbox insert', budget: budget?.snapshot() },
    checks, resources, limitations: ['One fictional reviewed source; not OCR or independent mapping quality evaluation', 'Actual provider quality is separately reported by evaluate.cjs', 'PENDING handoff is not executed domain matching or payment', 'Production authority/migration/catalog writer lock integration and peer review remain gates'] };
  const directory = path.join(root, 'docs/ai/evidence'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'issue25-mapping-runtime-' + started.replaceAll(/[^0-9]/g, '') + '.json'), JSON.stringify(report, null, 2) + '\n');
});
