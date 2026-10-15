/* SPDX-License-Identifier: MIT */
'use strict';
// Real isolated services and RS256/JWKS verification. Membership/PO tables are labelled acceptance fixtures.
require('reflect-metadata');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID, generateKeyPairSync, createHash } = require('node:crypto');
const { createServer } = require('node:http'), { execFileSync } = require('node:child_process');
const jwt = require('jsonwebtoken'), { Module } = require('@nestjs/common'), { NestFactory } = require('@nestjs/core');
const root = path.resolve(__dirname, '../..'), load = name => require(path.join(root, 'apps/api/dist', name));
const { DatabaseService } = load('database/database.service.js'), { AuthService } = load('auth/auth.service.js');
const { EvidenceService } = load('platform/evidence/evidence.service.js'), { EvidenceModule } = load('platform/evidence/evidence.module.js');
const { PostgresEvidenceStore } = load('platform/evidence/evidence.repository.js'), { PrivateEvidenceStorage } = load('platform/evidence/evidence-storage.js');
const { MinioStorageService } = load('storage/minio-storage.service.js'), { ClamavScanner } = load('platform/evidence/clamav.scanner.js');
const { DraftService } = load('platform/extraction/draft.service.js'), { DraftModule } = load('platform/extraction/draft.module.js');
const { PostgresDraftStore } = load('platform/extraction/draft.repository.js'), { InvoiceDraftProfile } = load('packs/openresolve/extraction/invoice-draft.profile.js');
const { InvoiceOcrExtractor } = load('packs/openresolve/extraction/invoice-ocr.extractor.js'), { InvoiceDraftTarget } = load('packs/openresolve/extraction/invoice-draft.target.js');
const { PostgresLineageStore } = load('platform/lineage/lineage.repository.js'), { DraftLineageWriter } = load('platform/lineage/draft-lineage.writer.js');
const { LineageService } = load('platform/lineage/lineage.service.js'), { LineageModule } = load('platform/lineage/lineage.module.js');
const { MembershipEvidenceResolver, MembershipEvidenceAccess } = load('platform/lineage/verified-evidence-access.js');
const { GeminiExtractionProvider } = load('ai/extraction/gemini-extraction.provider.js'), { geminiConfig } = load('ai/extraction/provider-config.js');
const { LocalProviderBudget } = load('ai/extraction/provider-budget.js'), { fail } = load('platform/evidence/evidence.types.js');
const { checksum } = load('platform/evidence/file-safety.js');
const Ajv = require('ajv'), schema = require(path.join(root, 'packages/contracts/opendx/v1/schemas/platform.schema.json'));
const ajv = new Ajv({ allErrors: true }); ajv.addSchema(schema);
const ctx = { tenantId: randomUUID(), subject: 'lineage-reviewer-' + randomUUID() }, other = { tenantId: randomUUID(), subject: 'foreign-reviewer-' + randomUUID() };
const checks = [], started = new Date().toISOString(), resources = {};
let db, app, jwks, origin, issuer, evidence, drafts, raw, lineageStore, budget, fault = false, providerCalls = 0;
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sign = (subject = ctx.subject, options = {}, signingKey = keys.privateKey) => jwt.sign({ realm_access: { roles: ['admin'] } }, signingKey,
  { algorithm: 'RS256', keyid: 'ephemeral-lineage-fixture', subject, issuer, audience: 'lineage-fixture-api', expiresIn: '5m', ...options });
function shape(name, value) { assert.equal(ajv.getSchema(schema.$id + '#/definitions/' + name)(value), true, 'Contract mismatch: ' + name); }
async function check(name, work) { try { await work(); checks.push({ name, status: 'PASS' }); console.log('PASS ' + name); }
  catch (error) { checks.push({ name, status: 'FAIL', code: error.code || error.name }); throw error; } }
async function api(method, route, body, status = 200, token = sign(), headers = {}) {
  const response = await fetch(origin + route, { method, headers: { Authorization: 'Bearer ' + token,
    ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  assert.equal(response.status, status, method + ' ' + route);
  if (response.headers.get('Content-Type')?.startsWith('application/octet-stream')) return Buffer.from(await response.arrayBuffer());
  const value = await response.json();
  shape(status >= 400 ? 'Error' : status === 201 ? 'RegistrationResult' : status === 202 ? route.endsWith('/confirmations') ? 'Confirmation' : 'Operation' :
    route.includes('/lineage') ? 'EvidenceLineage' : route.includes('/extraction-drafts/') ? 'ExtractionDraft' : route.includes('/operations/') ? 'Operation' : route.includes('?') || route.endsWith('/evidence') ? 'EvidencePage' : 'Evidence', value);
  return value;
}
async function main() {
  if (!process.argv.includes('--live')) throw new Error('Explicit --live is required for the bounded synthetic Gemini evaluation');
  Object.assign(process.env, { POSTGRES_HOST: '127.0.0.1', POSTGRES_PORT: '15446', POSTGRES_DB: 'lineage_issue46', POSTGRES_USER: 'lineage_fixture', POSTGRES_PASSWORD: 'lineage_fixture_local_only',
    MINIO_ENDPOINT: '127.0.0.1', MINIO_PORT: '19446', MINIO_USE_SSL: 'false', MINIO_BUCKET_INVOICES: 'lineage-issue46', MINIO_ACCESS_KEY: 'lineage_fixture', MINIO_SECRET_KEY: 'lineage_fixture_local_only' });
  db = new DatabaseService(); assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, 'lineage_issue46');
  await db.query(`CREATE TABLE IF NOT EXISTS lineage_fixture_memberships(tenant_id UUID NOT NULL,subject TEXT NOT NULL,active BOOLEAN NOT NULL,PRIMARY KEY(tenant_id,subject));
    CREATE TABLE IF NOT EXISTS lineage_fixture_denials(tenant_id UUID NOT NULL,subject TEXT NOT NULL,resource_id UUID NOT NULL,PRIMARY KEY(tenant_id,subject,resource_id));
    CREATE TABLE IF NOT EXISTS lineage_fixture_orders(tenant_id UUID NOT NULL,id UUID NOT NULL,seller TEXT NOT NULL,buyer TEXT NOT NULL,currency TEXT NOT NULL,PRIMARY KEY(tenant_id,id))`);
  for (const context of [ctx, other]) await db.query('INSERT INTO lineage_fixture_memberships VALUES($1,$2,true)', [context.tenantId, context.subject]);
  const publicJwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'ephemeral-lineage-fixture', use: 'sig', alg: 'RS256' };
  jwks = createServer((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ keys: [publicJwk] })); });
  await new Promise(resolve => jwks.listen(0, '127.0.0.1', resolve)); issuer = 'http://127.0.0.1:' + jwks.address().port + '/realms/lineage-fixture';
  Object.assign(process.env, { KEYCLOAK_ISSUER: issuer, KEYCLOAK_AUDIENCE: 'lineage-fixture-api', KEYCLOAK_JWKS_URI: issuer + '/protocol/openid-connect/certs' });
  const allowed = new Set(['context.read', 'evidence.register', 'evidence.read', 'evidence.upload', 'evidence.download', 'evidence.scan',
    'extraction.request', 'extraction.read', 'extraction.correct', 'extraction.confirm', 'operation.read', 'lineage.read', 'resource.read', 'lineage.record']);
  const authority = {
    resolve: async (subject, selected) => {
      const rows = (await db.query('SELECT tenant_id FROM lineage_fixture_memberships WHERE subject=$1 AND active AND ($2::uuid IS NULL OR tenant_id=$2)', [subject, selected || null])).rows;
      if (rows.length !== 1) fail('FORBIDDEN', 403); return { tenantId: rows[0].tenant_id, subject };
    },
    authorize: async (context, action, ref, policy) => {
      const member = await db.query('SELECT 1 FROM lineage_fixture_memberships WHERE tenant_id=$1 AND subject=$2 AND active', [context.tenantId, context.subject]);
      if (!member.rows.length || !allowed.has(action) || policy?.retentionClass === 'RESTRICTED') fail('FORBIDDEN', 403);
      if (!ref) return;
      let evidenceId = ref.id;
      if (ref.pack_id !== 'platform' || ref.type !== 'evidence') {
        const link = await db.query(`SELECT evidence_id FROM platform_lineage_links WHERE tenant_id=$1 AND
          ((link->'from_ref'->>'id'=$2 AND link->'from_ref'->>'pack_id'=$3 AND link->'from_ref'->>'type'=$4)
          OR (link->'to_ref'->>'id'=$2 AND link->'to_ref'->>'pack_id'=$3 AND link->'to_ref'->>'type'=$4)) LIMIT 1`, [context.tenantId, ref.id, ref.pack_id, ref.type]);
        if (!link.rows.length) fail('NOT_FOUND', 404); evidenceId = link.rows[0].evidence_id;
      }
      const resource = await db.query('SELECT data FROM platform_evidence_records WHERE tenant_id=$1 AND id=$2', [context.tenantId, evidenceId]);
      if (!resource.rows.length) fail('NOT_FOUND', 404);
      const denial = await db.query('SELECT 1 FROM lineage_fixture_denials WHERE tenant_id=$1 AND subject=$2 AND resource_id IN ($3,$4)', [context.tenantId, context.subject, ref.id, evidenceId]);
      if (denial.rows.length || resource.rows[0].data.evidence.created_by !== context.subject || resource.rows[0].data.evidence.retention_class === 'RESTRICTED') fail('FORBIDDEN', 403);
    },
  };
  const access = new MembershipEvidenceAccess(authority), resolver = new MembershipEvidenceResolver(new AuthService(), authority);
  const scanner = new ClamavScanner({ host: '127.0.0.1', port: 33146, timeoutMs: 30000, freshnessMs: 86400000, engine: '1.4.6' });
  await check('exact real ClamAV engine/fresh loaded definitions/complete stream', async () => assert.equal((await scanner.scan(Buffer.from('Fictional lineage readiness'))).state, 'CLEAN'));
  raw = new PostgresEvidenceStore(db); lineageStore = new PostgresLineageStore(db);
  evidence = new EvidenceService(raw, new PrivateEvidenceStorage(new MinioStorageService()), scanner, access, 'isolated-lineage-evidence-cursor-secret-v1', Date.now, { read: (c, id) => drafts.operation(c, id) });
  const sink = new DraftLineageWriter(lineageStore);
  const store = new PostgresDraftStore(db, { capture: async (...args) => { await sink.capture(...args); if (fault) { fault = false; throw new Error('Injected failure after real lineage SQL'); } } });
  const corpus = path.join(root, 'infra/ocr/fixtures/vn-reviewed-v1'), manifest = require(path.join(corpus, 'manifest.json'));
  const entry = manifest.cases.find(item => item.id === 'dev-digital'), bytes = fs.readFileSync(path.join(corpus, entry.source)); assert.equal(checksum(bytes), entry.sha256);
  const envAt = process.argv.indexOf('--env-file');
  if (envAt === -1) throw new Error('Ignored server-side --env-file required');
  const source = Object.fromEntries(fs.readFileSync(path.resolve(process.argv[envAt + 1]), 'utf8').split(/\r?\n/).filter(line => /^(GEMINI_API_KEY|GEMINI_MODEL)=/.test(line))
    .map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
  const providerConfig = geminiConfig({ ...source, AI_DOCUMENT_POLICY: 'synthetic-only', AI_REQUESTS_PER_MINUTE: '8', AI_REQUESTS_PER_DAY: '8', AI_TOKENS_PER_DAY: '30000' });
  budget = new LocalProviderBudget(providerConfig); const provider = new GeminiExtractionProvider(providerConfig, undefined, budget), profile = new InvoiceDraftProfile();
  const extractor = new InvoiceOcrExtractor({ extract: async input => { providerCalls++; return provider.extract(input); } }, { resolve: async (c, id) => {
    const record = await raw.read(c, id); if (!record || record.evidence.sha256 !== entry.sha256) fail('FORBIDDEN', 403); return 'SYNTHETIC';
  } });
  const target = new InvoiceDraftTarget({ verify: async (c, payload) => {
    const order = (await db.query('SELECT seller,buyer,currency FROM lineage_fixture_orders WHERE tenant_id=$1 AND id=$2', [c.tenantId, payload.purchase_order_id])).rows[0];
    if (!order || order.seller !== payload.seller_tax_code || order.buyer !== payload.buyer_tax_code || order.currency !== payload.currency) fail('FORBIDDEN', 403);
  } });
  drafts = new DraftService(store, evidence, extractor, [profile], access, target);
  const lineage = new LineageService(lineageStore, evidence, access, 'isolated-lineage-link-cursor-secret-v1');
  class FixtureModule {};
  Module({ imports: [EvidenceModule.register(evidence, resolver), DraftModule.register(drafts, resolver), LineageModule.register(lineage, resolver)] })(FixtureModule);
  app = await NestFactory.create(FixtureModule, { logger: false }); await app.listen(0, '127.0.0.1'); origin = await app.getUrl();
  await check('real RS256/JWKS rejects forged, expired and wrong-audience tokens', async () => {
    const forged = generateKeyPairSync('rsa', { modulusLength: 2048 });
    for (const token of [sign(ctx.subject, {}, forged.privateKey), sign(ctx.subject, { expiresIn: -1 }), sign(ctx.subject, { audience: 'other-audience' })]) await api('GET', '/platform/v1/evidence', undefined, 401, token);
  });
  await check('verified admin role and tenant selector cannot bypass current membership', async () => {
    await api('GET', '/platform/v1/evidence', undefined, 403, sign(), { 'X-Tenant-ID': other.tenantId });
  });
  const registered = await api('POST', '/platform/v1/evidence', { filename: 'Fictional Hóa đơn 46.pdf', media_type: entry.media_type, size_bytes: bytes.length,
    sha256: entry.sha256, source: { kind: 'USER_UPLOAD' }, retention_class: 'STANDARD' }, 201, sign(), { 'Idempotency-Key': randomUUID() });
  resources.evidenceId = registered.evidence.id;
  await api('PUT', registered.upload.href, bytes, 202, sign(), { 'Content-Type': entry.media_type, 'Idempotency-Key': randomUUID() }); await evidence.processNextScan(ctx);
  assert.deepEqual(await api('GET', '/platform/v1/evidence/' + resources.evidenceId + '/content'), bytes);
  const operation = await api('POST', '/platform/v1/evidence/' + resources.evidenceId + '/extractions', { schema_id: profile.id, mode: 'OCR' }, 202, sign(), { 'Idempotency-Key': randomUUID() }); resources.draftId = operation.resource_ref.id;
  await check('revoked SQL membership prevents worker/provider dispatch and preserves durable intent', async () => {
    await db.query('UPDATE lineage_fixture_memberships SET active=false WHERE tenant_id=$1 AND subject=$2', [ctx.tenantId, ctx.subject]);
    await api('GET', '/platform/v1/evidence/' + resources.evidenceId, undefined, 403);
    await assert.rejects(drafts.processNext(ctx), error => error.code === 'FORBIDDEN'); assert.equal(providerCalls, 0);
    await db.query('UPDATE lineage_fixture_memberships SET active=true WHERE tenant_id=$1 AND subject=$2', [ctx.tenantId, ctx.subject]);
  });
  const begin = performance.now(); await drafts.processNext(ctx); resources.extractionMs = Math.round(performance.now() - begin);
  let draft = await api('GET', '/platform/v1/extraction-drafts/' + resources.draftId); assert.equal(draft.state, 'REVIEW_REQUIRED');
  const gold = require(path.join(corpus, entry.label)).values;
  const corrections = draft.fields.filter(f => gold[f.path] !== null && gold[f.path] !== undefined && gold[f.path] !== f.value).map(f => ({ field_path: f.path,
    ...(f.status === 'EXTRACTED' ? { previous_value: f.value } : {}), new_value: gold[f.path], reason: 'Explicit fixture review against synthetic original' }));
  if (corrections.length) draft = await api('POST', '/platform/v1/extraction-drafts/' + draft.id + '/corrections', { expected_revision: draft.revision, corrections }, 200, sign(), { 'Idempotency-Key': randomUUID() });
  await check('actual raw/run/draft lineage with typed tenant-scoped links', async () => {
    const result = await api('GET', '/platform/v1/evidence/' + resources.evidenceId + '/lineage?limit=100');
    assert.ok(result.links.length >= 4); assert.ok(result.links.every(link => link.tenant_id === ctx.tenantId));
  });
  const number = draft.fields.find(f => f.path === '/invoice_number').value;
  draft = await api('POST', '/platform/v1/extraction-drafts/' + draft.id + '/corrections', { expected_revision: draft.revision,
    corrections: [{ field_path: '/invoice_number', previous_value: number, new_value: number + '-REVIEW', reason: 'Explicit correction history acceptance' }] }, 200, sign(), { 'Idempotency-Key': randomUUID() });
  await db.query('INSERT INTO lineage_fixture_orders VALUES($1,$2,$3,$4,$5)', [ctx.tenantId, gold['/purchase_order_id'], gold['/seller_tax_code'], gold['/buyer_tax_code'], gold['/currency']]);
  const body = { expected_revision: draft.revision, reviewed_field_paths: profile.requiredPaths(draft.fields) }, command = randomUUID();
  const count = async () => Number((await db.query('SELECT COUNT(*) FROM platform_lineage_links WHERE tenant_id=$1 AND evidence_id=$2', [ctx.tenantId, resources.evidenceId])).rows[0].count);
  await check('actual SQL lineage/outbox/confirmation rollback together after injected sink failure', async () => {
    const before = await count(); fault = true;
    await api('POST', '/platform/v1/extraction-drafts/' + draft.id + '/confirmations', body, 503, sign(), { 'Idempotency-Key': command });
    assert.equal(await count(), before); assert.equal((await store.read(ctx, draft.id)).draft.state, 'REVIEW_REQUIRED');
    assert.equal((await db.query('SELECT COUNT(*) FROM platform_verified_draft_outbox WHERE tenant_id=$1', [ctx.tenantId])).rows[0].count, '0');
  });
  await check('confirmed immutable snapshots and same-key retry produce no duplicate edges/outbox', async () => {
    const first = await api('POST', '/platform/v1/extraction-drafts/' + draft.id + '/confirmations', body, 202, sign(), { 'Idempotency-Key': command }), before = await count();
    const replay = await api('POST', '/platform/v1/extraction-drafts/' + draft.id + '/confirmations', body, 202, sign(), { 'Idempotency-Key': command });
    assert.deepEqual(replay, first); assert.equal(await count(), before); assert.equal(first.operation.state, 'PENDING');
    resources.confirmationId = first.id;
  });
  await check('foreign JWT tenant cannot list/search/download/read drafts/operations/lineage', async () => {
    const token = sign(other.subject);
    for (const route of ['/platform/v1/evidence/' + resources.evidenceId, '/platform/v1/evidence/' + resources.evidenceId + '/content',
      '/platform/v1/evidence/' + resources.evidenceId + '/lineage', '/platform/v1/extraction-drafts/' + draft.id, '/platform/v1/operations/' + operation.id]) await api('GET', route, undefined, 404, token);
    assert.deepEqual((await api('GET', '/platform/v1/evidence?q=46', undefined, 200, token)).items, []);
  });
  await check('real filename/retention filtering and current resource ACL', async () => {
    assert.equal((await api('GET', '/platform/v1/evidence?q=46&retention_class=STANDARD')).items.length, 1);
    assert.equal((await api('GET', '/platform/v1/evidence?q=%25')).items.length, 0);
    const graph = await api('GET', '/platform/v1/evidence/' + resources.evidenceId + '/lineage?limit=100');
    const hidden = graph.links.find(link => link.from_ref.type === 'extraction-run').from_ref.id;
    await db.query('INSERT INTO lineage_fixture_denials VALUES($1,$2,$3)', [ctx.tenantId, ctx.subject, hidden]);
    const reduced = await api('GET', '/platform/v1/evidence/' + resources.evidenceId + '/lineage?limit=100'); assert.ok(!JSON.stringify(reduced).includes(hidden));
  });
  await check('lineage cursor pagination and SQL append-only history enforcement', async () => {
    const expected = (await api('GET', '/platform/v1/evidence/' + resources.evidenceId + '/lineage?limit=100')).links.map(link => link.id).sort();
    const rawPage = await lineageStore.page(ctx, resources.evidenceId, '0', await lineageStore.watermark(ctx, resources.evidenceId), 100);
    assert.deepEqual(rawPage.map(row => row.sequence), rawPage.map(row => row.sequence).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1));
    let route = '/platform/v1/evidence/' + resources.evidenceId + '/lineage?limit=2', seen = new Set();
    for (let pages = 0; route && pages < 100; pages++) {
      const page = await api('GET', route); for (const link of page.links) { assert.ok(!seen.has(link.id)); seen.add(link.id); }
      route = page.next_cursor ? '/platform/v1/evidence/' + resources.evidenceId + '/lineage?limit=2&cursor=' + encodeURIComponent(page.next_cursor) : undefined;
    }
    assert.equal(route, undefined); assert.deepEqual([...seen].sort(), expected); assert.ok(seen.size >= 4);
    await assert.rejects(db.query('UPDATE platform_lineage_links SET sha256=sha256 WHERE tenant_id=$1', [ctx.tenantId]), /append-only/);
    await assert.rejects(db.query('DELETE FROM platform_lineage_snapshots WHERE tenant_id=$1', [ctx.tenantId]), /append-only/);
  });
  await check('concurrent real SQL replay deduplicates and a conflicting immutable snapshot rolls back new nodes', async () => {
    const saved = (await db.query(`SELECT l.link,f.data AS source,t.data AS target FROM platform_lineage_links l
      JOIN platform_lineage_snapshots f ON f.tenant_id=l.tenant_id AND f.resource_key=l.from_key
      JOIN platform_lineage_snapshots t ON t.tenant_id=l.tenant_id AND t.resource_key=l.to_key
      WHERE l.tenant_id=$1 AND l.evidence_id=$2 ORDER BY l.sequence LIMIT 1`, [ctx.tenantId, resources.evidenceId])).rows[0];
    const edge = { from: saved.source, to: saved.target, relation: saved.link.relation, createdAt: saved.link.created_at }, before = await count();
    await Promise.all([1, 2].map(() => db.transaction(client => lineageStore.append(client, ctx, resources.evidenceId, [edge]))));
    assert.equal(await count(), before);
    const nodes = async () => (await db.query('SELECT COUNT(*) FROM platform_lineage_snapshots WHERE tenant_id=$1', [ctx.tenantId])).rows[0].count;
    const nodeCount = await nodes(), invalid = structuredClone(edge);
    invalid.from.ref.id = randomUUID(); invalid.to.metadata.size_bytes = 1;
    await assert.rejects(db.transaction(client => lineageStore.append(client, ctx, resources.evidenceId, [invalid])), error => error.code === 'REVISION_CONFLICT');
    assert.equal(await nodes(), nodeCount); assert.equal(await count(), before);
  });
  resources.providerCalls = providerCalls; resources.providerRuns = (await store.read(ctx, draft.id)).providerRuns.map(run => ({ extractor: run.extractor, usage: run.usage }));
}
main().catch(error => { console.error('FAIL lineage runtime: ' + (error.code || error.name) + ' ' + String(error.message).slice(0, 300)); process.exitCode = 1; }).finally(async () => {
  if (app) await app.close(); if (jwks) await new Promise(resolve => jwks.close(resolve)); if (db) await db.onModuleDestroy();
  const sourceHashes = {};
  for (const folder of ['platform/lineage', 'platform/evidence', 'platform/extraction', 'packs/openresolve/extraction']) for (const file of fs.readdirSync(path.join(root, 'apps/api/src', folder)).filter(file => file.endsWith('.ts') && !file.endsWith('.spec.ts')).sort())
    sourceHashes['apps/api/src/' + folder + '/' + file] = createHash('sha256').update(fs.readFileSync(path.join(root, 'apps/api/src', folder, file))).digest('hex');
  const report = { started, completed: new Date().toISOString(), gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    worktreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()), sourceHashes,
    environment: { node: process.version, platform: process.platform, services: 'real PostgreSQL/MinIO/ClamAV/Gemini', identity: 'real existing AuthService RS256 verification against ephemeral local JWKS; labelled SQL membership/ACL/PO fixtures; not production Keycloak/#43 migration',
      failure: 'injected exception after actual lineage SQL, actual transaction rollback', budget: budget?.snapshot() }, checks, resources,
    limitations: ['One repeated synthetic dev PDF; not independent quality evaluation', 'No production tenant/backfill/legacy bridge or executed match/decision adapter', 'No process-kill or coordinated restore claim', 'PENDING outbox is not matched/approved/paid'] };
  const directory = path.join(root, 'docs/ai/evidence'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'issue46-lineage-runtime-' + started.replaceAll(/[^0-9]/g, '') + '.json'), JSON.stringify(report, null, 2) + '\n');
});
