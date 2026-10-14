/* SPDX-License-Identifier: MIT */
'use strict';
// Explicit bounded live evaluation. Never substitutes labels/provider doubles for measured OCR.
require('reflect-metadata');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const root = path.resolve(__dirname, '../..');
const built = name => require(path.join(root, 'apps/api/dist', name));
const { DatabaseService } = built('database/database.service.js');
const { MinioStorageService } = built('storage/minio-storage.service.js');
const { PrivateEvidenceStorage } = built('platform/evidence/evidence-storage.js');
const { PostgresEvidenceStore } = built('platform/evidence/evidence.repository.js');
const { EvidenceService } = built('platform/evidence/evidence.service.js');
const { EvidenceModule } = built('platform/evidence/evidence.module.js');
const { ClamavScanner } = built('platform/evidence/clamav.scanner.js');
const { PostgresDraftStore } = built('platform/extraction/draft.repository.js');
const { DraftService } = built('platform/extraction/draft.service.js');
const { DraftModule } = built('platform/extraction/draft.module.js');
const { InvoiceDraftProfile } = built('packs/openresolve/extraction/invoice-draft.profile.js');
const { InvoiceOcrExtractor } = built('packs/openresolve/extraction/invoice-ocr.extractor.js');
const { InvoiceDraftTarget } = built('packs/openresolve/extraction/invoice-draft.target.js');
const { GeminiExtractionProvider } = built('ai/extraction/gemini-extraction.provider.js');
const { LocalProviderBudget } = built('ai/extraction/provider-budget.js');
const { geminiConfig } = built('ai/extraction/provider-config.js');
const { checksum } = built('platform/evidence/file-safety.js');
const { fail } = built('platform/evidence/evidence.types.js');
const { Exact } = built('invoices/parsers/invoice-xml-validation.js');
const Ajv = require('ajv'), ajv = new Ajv({ allErrors: true });
const platformSchema = require(path.join(root, 'packages/contracts/opendx/v1/schemas/platform.schema.json')); ajv.addSchema(platformSchema);
const corpus = path.join(__dirname, 'fixtures/vn-reviewed-v1');
const manifest = JSON.parse(fs.readFileSync(path.join(corpus, 'manifest.json'), 'utf8'));
const ctx = { tenantId: randomUUID(), subject: 'isolated-ocr-reviewer' }, foreign = { tenantId: randomUUID(), subject: ctx.subject };
const checks = [], cases = [], started = new Date().toISOString();
const config = { POSTGRES_HOST: '127.0.0.1', POSTGRES_PORT: '15426', POSTGRES_DB: 'ocr_issue26', POSTGRES_USER: 'ocr_fixture', POSTGRES_PASSWORD: 'ocr_fixture_local_only',
  MINIO_ENDPOINT: '127.0.0.1', MINIO_PORT: '19426', MINIO_USE_SSL: 'false', MINIO_BUCKET_INVOICES: 'ocr-issue26', MINIO_ACCESS_KEY: 'ocr_fixture', MINIO_SECRET_KEY: 'ocr_fixture_local_only' };
Object.assign(process.env, config);
let db, app, origin, budget, service, rawStore, draftStore, evidence, faultOnce = false;
function corpusPath(relative, directory) {
  const result = path.resolve(corpus, relative), permitted = path.join(corpus, directory) + path.sep;
  if (!result.startsWith(permitted)) throw new Error('Corpus path escapes its approved directory'); return result;
}
function shape(name, value) { assert.equal(ajv.getSchema(platformSchema.$id + '#/definitions/' + name)(value), true, 'Contract mismatch: ' + name); }
async function api(method, route, value, status, identity = 'member', headers = {}) {
  const response = await fetch(origin + route, { method, headers: { Authorization: 'Bearer fixture-' + identity, 'X-Correlation-ID': randomUUID(),
    ...(value && !Buffer.isBuffer(value) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(value ? { body: Buffer.isBuffer(value) ? value : JSON.stringify(value) } : {}), signal: AbortSignal.timeout(60000) });
  assert.equal(response.status, status, method + ' ' + route); const result = await response.json();
  if (status >= 400) shape('Error', result);
  else if (status === 201) shape('RegistrationResult', result);
  else if (status === 202) shape(route.endsWith('/confirmations') ? 'Confirmation' : 'Operation', result);
  else if (route.includes('/extraction-drafts/')) shape('ExtractionDraft', result);
  else if (route.includes('/operations/')) shape('Operation', result);
  return result;
}
async function check(name, work) { await work(); checks.push({ name, status: 'PASS' }); console.log('PASS ' + name); }
function environment() {
  const envIndex = process.argv.indexOf('--env-file');
  const source = envIndex === -1 ? {} : Object.fromEntries(fs.readFileSync(path.resolve(process.argv[envIndex + 1]), 'utf8').split(/\r?\n/)
    .filter(line => /^(GEMINI_API_KEY|GEMINI_MODEL)=/.test(line)).map(line => {
      const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).trim().replace(/^['"]|['"]$/g, '')];
    }));
  // Fixed small evaluation ceilings; no paid-document override or arbitrary .env settings.
  return { GEMINI_API_KEY: source.GEMINI_API_KEY || process.env.GEMINI_API_KEY, GEMINI_MODEL: source.GEMINI_MODEL || process.env.GEMINI_MODEL,
    AI_DOCUMENT_POLICY: 'synthetic-only', AI_REQUESTS_PER_MINUTE: '20', AI_REQUESTS_PER_DAY: '40', AI_TOKENS_PER_DAY: '100000' };
}
async function main() {
  if (!process.argv.includes('--live')) throw new Error('Live evaluation requires explicit --live and server-side credentials');
  assert.equal(manifest.synthetic, true); assert.equal(manifest.version, 'vn-reviewed-v1'); assert.equal(manifest.cases.length, 4);
  const providerConfig = geminiConfig(environment()); budget = new LocalProviderBudget(providerConfig);
  const provider = new GeminiExtractionProvider(providerConfig, undefined, budget);
  db = new DatabaseService();
  const database = await db.query('SELECT current_database() AS name'); assert.equal(database.rows[0].name, 'ocr_issue26');
  await db.query(`CREATE TABLE IF NOT EXISTS ocr_fixture_purchase_orders(tenant_id UUID NOT NULL,id UUID NOT NULL,seller TEXT NOT NULL,buyer TEXT NOT NULL,currency TEXT NOT NULL,PRIMARY KEY(tenant_id,id))`);
  rawStore = new PostgresEvidenceStore(db); draftStore = new PostgresDraftStore(db);
  const scanner = new ClamavScanner({ host: '127.0.0.1', port: 33126, timeoutMs: 30000, freshnessMs: 86400000, engine: '1.4.6' });
  await check('actual scanner engine/fresh definitions/complete stream readiness', async () => {
    const result = await scanner.scan(Buffer.from('Fictional OCR fixture readiness')); assert.equal(result.state, 'CLEAN', result.reason);
  });
  const storage = new PrivateEvidenceStorage(new MinioStorageService()), access = { check: async () => undefined };
  evidence = new EvidenceService(rawStore, storage, scanner, access, 'isolated-ocr-cursor-secret-at-least-32-bytes', Date.now, { read: (context, id) => service.operation(context, id) });
  const profile = new InvoiceDraftProfile();
  const target = new InvoiceDraftTarget({ verify: async (context, payload) => {
    const result = await db.query('SELECT seller,buyer,currency FROM ocr_fixture_purchase_orders WHERE tenant_id=$1 AND id=$2', [context.tenantId, payload.purchase_order_id]);
    const binding = result.rows[0]; if (!binding || binding.seller !== payload.seller_tax_code || binding.buyer !== payload.buyer_tax_code || binding.currency !== payload.currency) fail('FORBIDDEN', 403);
  } });
  const extractor = new InvoiceOcrExtractor(provider, { resolve: async (context, id) => {
    const source = await rawStore.read(context, id); if (!source || !manifest.cases.some(item => item.sha256 === source.evidence.sha256)) fail('FORBIDDEN', 403);
    return 'SYNTHETIC';
  } });
  service = new DraftService(draftStore, evidence, extractor, [profile], access, {
    authorize: (...args) => target.authorize(...args), enqueue: async (...args) => {
      await target.enqueue(...args); if (faultOnce) { faultOnce = false; throw new Error('Acceptance-only failure after actual SQL enqueue'); }
    },
  });
  const resolver = { resolve: async request => {
    if (request.header('Authorization') === 'Bearer fixture-member') return ctx;
    if (request.header('Authorization') === 'Bearer fixture-foreign') return foreign;
    fail('UNAUTHENTICATED', 401);
  } };
  class FixtureModule {};
  Module({ imports: [EvidenceModule.register(evidence, resolver), DraftModule.register(service, resolver)] })(FixtureModule);
  app = await NestFactory.create(FixtureModule, { logger: false }); await app.listen(0, '127.0.0.1'); origin = await app.getUrl();
  for (const entry of manifest.cases) {
    const bytes = fs.readFileSync(corpusPath(entry.source, 'sources')); assert.equal(checksum(bytes), entry.sha256);
    const sample = { id: entry.id, split: entry.split, kind: entry.kind, sha256: entry.sha256, status: 'STARTED' }; cases.push(sample);
    const registered = await api('POST', '/platform/v1/evidence', { filename: path.basename(entry.source), media_type: entry.media_type,
      size_bytes: bytes.length, sha256: entry.sha256, source: { kind: 'USER_UPLOAD' }, retention_class: 'STANDARD' }, 201, 'member', { 'Idempotency-Key': randomUUID() });
    shape('RegistrationResult', registered); sample.evidence_id = registered.evidence.id;
    await api('PUT', registered.upload.href, bytes, 202, 'member', { 'Content-Type': entry.media_type, 'Idempotency-Key': randomUUID() });
    await evidence.processNextScan(ctx); assert.equal((await rawStore.read(ctx, sample.evidence_id)).evidence.quarantine_state, 'CLEAN');
    const operation = await api('POST', '/platform/v1/evidence/' + sample.evidence_id + '/extractions', { schema_id: profile.id, mode: 'OCR' }, 202, 'member', { 'Idempotency-Key': randomUUID() });
    shape('Operation', operation); sample.operation_id = operation.id; sample.draft_id = operation.resource_ref.id;
    const begin = performance.now(); await service.processNext(ctx); sample.extraction_ms = Math.round(performance.now() - begin);
    const record = await draftStore.read(ctx, sample.draft_id); sample.operation_state = record.operation.state;
    sample.provider_runs = record.providerRuns.map(run => ({ extractor: run.extractor, usage: run.usage })); sample.failures = record.failures || [];
    // Ground truth is opened only after actual provider work has completed.
    const gold = JSON.parse(fs.readFileSync(corpusPath(entry.label, 'labels'), 'utf8')).values;
    const fields = new Map((record.draft?.fields || []).map(field => [field.path, field]));
    sample.fields = Object.entries(gold).map(([fieldPath, expected]) => {
      const actual = fields.get(fieldPath); const exact = expected === null ? actual?.status === 'MISSING' : actual?.status === 'EXTRACTED' && actual.value === expected;
      let equivalent = exact;
      if (!exact && actual?.status === 'EXTRACTED' && actual.kind === 'DECIMAL' && expected !== null) {
        try { equivalent = new Exact(actual.value).eq(expected); } catch { equivalent = false; }
      }
      return { path: fieldPath, exact, equivalent, expected_missing: expected === null, observed_status: actual?.status || 'NO_DRAFT',
        observed_value: actual?.value, source_refs: actual?.source_refs };
    });
    sample.exact = sample.fields.filter(field => field.exact).length; sample.equivalent = sample.fields.filter(field => field.equivalent).length; sample.denominator = sample.fields.length;
    if (!record.draft) { sample.status = 'OCR_FAILED'; console.log('OCR_FAILED ' + entry.id + ' ' + record.operation.state); continue; }
    shape('ExtractionDraft', record.draft);
    assert.equal((await db.query('SELECT COUNT(*) FROM platform_verified_draft_outbox WHERE tenant_id=$1 AND draft_id=$2', [ctx.tenantId, sample.draft_id])).rows[0].count, '0');
    await check(entry.id + ' foreign draft/operation/resource IDs remain inaccessible', async () => {
      for (const route of ['/platform/v1/extraction-drafts/' + sample.draft_id, '/platform/v1/operations/' + operation.id, '/platform/v1/evidence/' + sample.evidence_id]) await api('GET', route, undefined, 404, 'foreign');
    });
    // This models an explicit fixture reviewer correcting against the permitted source, not AI accuracy.
    const corrections = [...fields.entries()].flatMap(([fieldPath, field]) => {
      const value = gold[fieldPath]; if (value === null || value === undefined || field.value === value) return [];
      return [{ field_path: fieldPath, ...(field.status === 'EXTRACTED' ? { previous_value: field.value } : {}), new_value: value, reason: 'Fixture reviewer checked the original synthetic document' }];
    });
    let draft = record.draft; sample.fixture_review_corrections = corrections.length;
    if (corrections.length) draft = await api('POST', '/platform/v1/extraction-drafts/' + draft.id + '/corrections', { expected_revision: draft.revision, corrections }, 200, 'member', { 'Idempotency-Key': randomUUID() });
    await db.query('INSERT INTO ocr_fixture_purchase_orders(tenant_id,id,seller,buyer,currency) VALUES($1,$2,$3,$4,$5)',
      [ctx.tenantId, gold['/purchase_order_id'], gold['/seller_tax_code'], gold['/buyer_tax_code'], gold['/currency']]);
    if (entry.id === 'dev-digital') {
      await check('actual persisted invalid-total correction cannot confirm', async () => {
        const total = draft.fields.find(field => field.path === '/total_amount').value;
        draft = await api('POST', '/platform/v1/extraction-drafts/' + draft.id + '/corrections', { expected_revision: draft.revision,
          corrections: [{ field_path: '/total_amount', previous_value: total, new_value: '1', reason: 'Deliberate invalid-total acceptance case' }] }, 200, 'member', { 'Idempotency-Key': randomUUID() });
        const result = await api('POST', '/platform/v1/extraction-drafts/' + draft.id + '/confirmations', { expected_revision: draft.revision, reviewed_field_paths: profile.requiredPaths(draft.fields) }, 422, 'member', { 'Idempotency-Key': randomUUID() });
        assert.equal(result.code, 'DRAFT_INVALID');
        draft = await api('POST', '/platform/v1/extraction-drafts/' + draft.id + '/corrections', { expected_revision: draft.revision,
          corrections: [{ field_path: '/total_amount', previous_value: '1', new_value: total, reason: 'Restore inspected synthetic total' }] }, 200, 'member', { 'Idempotency-Key': randomUUID() });
      });
    }
    const confirmationBody = { expected_revision: draft.revision, reviewed_field_paths: profile.requiredPaths(draft.fields) }, command = randomUUID();
    if (entry.id === 'dev-digital') await check('real SQL outbox insert and reviewed state roll back together on injected finalization error', async () => {
      faultOnce = true; await api('POST', '/platform/v1/extraction-drafts/' + draft.id + '/confirmations', confirmationBody, 503, 'member', { 'Idempotency-Key': command });
      assert.equal((await draftStore.read(ctx, draft.id)).draft.state, 'REVIEW_REQUIRED');
      assert.equal((await db.query('SELECT COUNT(*) FROM platform_verified_draft_outbox WHERE tenant_id=$1 AND draft_id=$2', [ctx.tenantId, draft.id])).rows[0].count, '0');
    });
    await check(entry.id + ' confirmation, real immutable facts/outbox and same-key replay', async () => {
      const confirmation = await api('POST', '/platform/v1/extraction-drafts/' + draft.id + '/confirmations', confirmationBody, 202, 'member', { 'Idempotency-Key': command });
      shape('Confirmation', confirmation); assert.equal(confirmation.operation.state, 'PENDING');
      const replay = await api('POST', '/platform/v1/extraction-drafts/' + draft.id + '/confirmations', confirmationBody, 202, 'member', { 'Idempotency-Key': command }); assert.deepEqual(replay, confirmation);
      const queued = await db.query('SELECT state,payload FROM platform_verified_draft_outbox WHERE tenant_id=$1 AND draft_id=$2', [ctx.tenantId, draft.id]);
      assert.equal(queued.rows.length, 1); assert.equal(queued.rows[0].state, 'PENDING'); assert.equal(queued.rows[0].payload.total_amount, new Exact(gold['/total_amount']).toFixed(2));
      const current = await draftStore.read(ctx, draft.id); assert.deepEqual(current.original, record.original); assert.equal(current.draft.state, 'CONFIRMED');
      await api('GET', '/platform/v1/operations/' + confirmation.operation.id, undefined, 200);
    });
    sample.status = 'PIPELINE_PASSED_AFTER_EXPLICIT_FIXTURE_REVIEW'; console.log('OCR ' + entry.id + ': ' + sample.exact + '/' + sample.denominator + ' exact, ' + sample.equivalent + '/' + sample.denominator + ' equivalent');
  }
  assert.equal(cases.filter(sample => sample.status === 'PIPELINE_PASSED_AFTER_EXPLICIT_FIXTURE_REVIEW').length,
    manifest.cases.length, 'Every planned document must complete the reviewed pipeline');
}
main().catch(error => { console.error('FAIL isolated live OCR: ' + (error.code || error.name) + ' ' + String(error.message).slice(0, 300)); process.exitCode = 1; }).finally(async () => {
  if (app) await app.close(); if (db) await db.onModuleDestroy();
  const sourceHashes = {};
  for (const folder of ['apps/api/src/ai/extraction', 'apps/api/src/platform/evidence', 'apps/api/src/platform/extraction', 'apps/api/src/packs/openresolve/extraction']) {
    for (const file of fs.readdirSync(path.join(root, folder)).filter(file => file.endsWith('.ts') && !file.endsWith('.spec.ts')).sort())
      sourceHashes[folder + '/' + file] = checksum(fs.readFileSync(path.join(root, folder, file)));
  }
  const scores = {};
  for (const split of ['dev', 'held-out']) {
    const selected = cases.filter(sample => sample.split === split);
    scores[split] = { attempted_documents: selected.length, planned_documents: manifest.cases.filter(sample => sample.split === split).length,
      exact: selected.reduce((sum, sample) => sum + (sample.exact || 0), 0), equivalent: selected.reduce((sum, sample) => sum + (sample.equivalent || 0), 0),
      denominator: selected.reduce((sum, sample) => sum + (sample.denominator || 0), 0) };
  }
  const report = { started, completed: new Date().toISOString(), gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    worktreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
    environment: { node: process.version, platform: process.platform, identity: 'static server fixture identities; not production JWT/membership',
      persistence: 'actual isolated PostgreSQL/MinIO/ClamAV', provider: 'actual Gemini, synthetic hash allowlist only', renderer: manifest.renderer,
      downstream: 'actual durable PENDING outbox; no claim of executed matching or payment', budget: budget?.snapshot() },
    sourceHashes, corpusVersion: manifest.version, scores, checks, cases,
    limitations: ['Four fictional documents, two held-out; no production accuracy or confidence-calibration claim', 'Fixture reviewer corrections are excluded from OCR quality',
      'Unknown raster locations remain unknown; only verified unique PDF text gets source spans', 'Production tenant/legacy bridge and pack dispatch remain integration gates',
      'Provider-reported tokens and conservative reservations are not a billing statement'] };
  const directory = path.join(root, 'docs/ai/evidence'); fs.mkdirSync(directory, { recursive: true });
  const stamp = started.replaceAll(/[^0-9]/g, '');
  fs.writeFileSync(path.join(directory, 'issue26-ocr-runtime-' + stamp + '.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(directory, 'issue26-ocr-runtime-latest.json'), JSON.stringify(report, null, 2) + '\n');
});
