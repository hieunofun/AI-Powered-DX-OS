/* SPDX-License-Identifier: MIT */
'use strict';
// Explicit isolated acceptance run; never loads .env or production identity/AI keys.
require('reflect-metadata');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { Client } = require('minio');
const PDFDocument = require('pdfkit');
const root = path.resolve(__dirname, '../..');
const built = name => require(path.join(root, 'apps/api/dist', name));
const { DatabaseService } = built('database/database.service.js');
const { MinioStorageService } = built('storage/minio-storage.service.js');
const { PostgresEvidenceStore } = built('platform/evidence/evidence.repository.js');
const { PrivateEvidenceStorage } = built('platform/evidence/evidence-storage.js');
const { EvidenceService } = built('platform/evidence/evidence.service.js');
const { EvidenceModule } = built('platform/evidence/evidence.module.js');
const { ClamavScanner } = built('platform/evidence/clamav.scanner.js');
const { checksum } = built('platform/evidence/file-safety.js');
const { fail } = built('platform/evidence/evidence.types.js');
const Ajv = require('ajv'); const ajv = new Ajv({ allErrors: true });
const schema = require(path.join(root, 'packages/contracts/opendx/v1/schemas/platform.schema.json')); ajv.addSchema(schema);
const checks = [], resources = [], started = new Date().toISOString();
const ctx = { tenantId: randomUUID(), subject: 'isolated-server-fixture-member' };
const foreign = { tenantId: randomUUID(), subject: ctx.subject };
let db, app, service, store, storage, scanner, origin, shift = 0;
const config = { POSTGRES_HOST: '127.0.0.1', POSTGRES_PORT: '15441', POSTGRES_DB: 'evidence_issue41',
  POSTGRES_USER: 'evidence_fixture', POSTGRES_PASSWORD: 'evidence_fixture_local_only',
  MINIO_ENDPOINT: '127.0.0.1', MINIO_PORT: '19441', MINIO_USE_SSL: 'false', MINIO_BUCKET_INVOICES: 'evidence-issue41',
  MINIO_ACCESS_KEY: 'evidence_fixture', MINIO_SECRET_KEY: 'evidence_fixture_local_only' };
Object.assign(process.env, config);
const cursorSecret = 'isolated-evidence-fixture-cursor-secret-v1';
const now = () => Date.now() + shift;
const access = { check: async () => undefined }; // Only this harness; production must supply current ACL/membership.
const metadata = (bytes, media_type = 'application/pdf', filename = 'fixture.pdf') => ({ filename, media_type,
  size_bytes: bytes.length, sha256: checksum(bytes), source: { kind: 'USER_UPLOAD' }, retention_class: 'STANDARD' });
async function* stream(bytes) { yield bytes; }
async function check(id, work) {
  try { const detail = await work(); checks.push({ id, status: 'PASS', ...(detail ? { detail } : {}) }); console.log('PASS ' + id); }
  catch (error) { checks.push({ id, status: 'FAIL', code: error.code || error.name }); throw error; }
}
function conforms(name, value) { assert.equal(ajv.getSchema(schema.$id + '#/definitions/' + name)(value), true, name + ' schema mismatch'); }
async function http(method, route, body, status, token = 'fixture-member', headers = {}) {
  const response = await fetch(origin + route, { method, headers: { Authorization: 'Bearer ' + token,
    'X-Correlation-ID': randomUUID(), ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45000) });
  assert.equal(response.status, status, method + ' ' + route);
  assert.match(response.headers.get('X-Correlation-ID'), /^[a-f0-9-]{36}$/);
  if (response.headers.get('Content-Type')?.startsWith('application/octet-stream')) return { response, bytes: Buffer.from(await response.arrayBuffer()) };
  const json = await response.json(); if (status >= 400) conforms('Error', json); return json;
}
async function register(bytes, media = 'application/pdf', filename, command = randomUUID()) {
  const result = await http('POST', '/platform/v1/evidence', metadata(bytes, media, filename), 201, 'fixture-member', { 'Idempotency-Key': command });
  conforms('RegistrationResult', result); resources.push({ id: result.evidence.id, sha256: checksum(bytes), media }); return result;
}
async function upload(registration, bytes, media = 'application/pdf', command = randomUUID()) {
  const result = await http('PUT', registration.upload.href, bytes, 202, 'fixture-member', { 'Content-Type': media, 'Idempotency-Key': command });
  conforms('Operation', result); return result;
}
async function pdf(encrypted = false, attachment) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ ...(encrypted ? { userPassword: 'fixture-lock', ownerPassword: 'fixture-owner-lock', permissions: { copying: false } } : {}) });
    const chunks = []; document.on('data', chunk => chunks.push(chunk)); document.on('error', reject); document.on('end', () => resolve(Buffer.concat(chunks)));
    document.text('FICTIONAL EVIDENCE / Issue 41 / No customer data');
    if (attachment) document.file(attachment, { name: 'harmless-av-fixture.txt' });
    document.end();
  });
}
async function main() {
  db = new DatabaseService(); store = new PostgresEvidenceStore(db);
  storage = new PrivateEvidenceStorage(new MinioStorageService());
  scanner = new ClamavScanner({ host: '127.0.0.1', port: 33141, timeoutMs: 30000, freshnessMs: 86400000, engine: '1.4.6' });
  await check('scanner readiness exact engine/fresh definitions/complete INSTREAM', async () => {
    const result = await scanner.scan(Buffer.from('FICTIONAL isolated readiness check'));
    assert.equal(result.state, 'CLEAN', 'Scanner readiness: ' + result.reason);
    return { engine: result.engine, definitions: result.definitions, definitionsAt: result.definitionsAt };
  });
  service = new EvidenceService(store, storage, scanner, access, cursorSecret, now);
  class FixtureModule {};
  Module({ imports: [EvidenceModule.register(service, { resolve: async req => {
    const token = req.header('Authorization');
    if (token === 'Bearer fixture-member') return ctx;
    if (token === 'Bearer fixture-foreign') return foreign;
    if (token === 'Bearer fixture-no-tenant') return { ...ctx, tenantId: '' };
    fail('UNAUTHENTICATED', 401);
  } })] })(FixtureModule);
  app = await NestFactory.create(FixtureModule, { logger: false }); await app.listen(0, '127.0.0.1'); origin = await app.getUrl();
  const bytes = await pdf(); let registered, operation;
  await check('EI-01/02/03 registration and server identity HTTP', async () => {
    registered = await register(bytes); assert.equal(registered.evidence.tenant_id, ctx.tenantId);
    assert.equal(registered.evidence.quarantine_state, 'PENDING_UPLOAD');
    assert(Math.abs(Date.parse(registered.upload.expires_at) - Date.parse(registered.evidence.created_at) - 900000) < 10);
    await http('POST', '/platform/v1/evidence', { ...metadata(bytes), tenant_id: foreign.tenantId }, 400, 'fixture-member', { 'Idempotency-Key': randomUUID() });
    await http('GET', '/platform/v1/evidence', undefined, 401, 'expired-fixture');
    await http('GET', '/platform/v1/evidence', undefined, 400, 'fixture-no-tenant');
  });
  await check('EI-04 tenant-predicated HTTP/DB resources and operations', async () => {
    await http('GET', '/platform/v1/evidence/' + registered.evidence.id, undefined, 404, 'fixture-foreign');
    await http('GET', '/platform/v1/evidence/' + randomUUID(), undefined, 404, 'fixture-foreign');
    operation = await upload(registered, bytes); assert.equal(operation.state, 'PENDING');
    await http('GET', '/platform/v1/operations/' + operation.id, undefined, 404, 'fixture-foreign');
  });
  await check('EI-07/18 blocked bytes, bad SHA and readback SHA before acknowledgement', async () => {
    await http('GET', registered.upload.href, undefined, 409);
    const wrong = await register(bytes);
    const result = await http('PUT', wrong.upload.href, Buffer.concat([bytes, Buffer.from('wrong')]), 422, 'fixture-member', { 'Content-Type': 'application/pdf', 'Idempotency-Key': randomUUID() });
    assert.equal(result.code, 'CHECKSUM_MISMATCH');
    const row = await store.read(ctx, registered.evidence.id); assert.equal(row.accepted, true);
    const stored = await storage.read(ctx, row.objectKey); const chunks = []; for await (const chunk of stored) chunks.push(chunk);
    assert.equal(checksum(Buffer.concat(chunks)), registered.evidence.sha256);
  });
  await check('EI-08/09 real concurrent PostgreSQL idempotency and upload replay', async () => {
    const command = randomUUID(); const results = await Promise.all(Array.from({ length: 10 }, () => register(bytes, 'application/pdf', 'race.pdf', command)));
    assert.equal(new Set(results.map(row => row.evidence.id)).size, 1);
    const query = await db.query('SELECT COUNT(*) FROM platform_evidence_commands WHERE tenant_id=$1 AND evidence_id=$2', [ctx.tenantId, results[0].evidence.id]);
    assert.equal(query.rows[0].count, '1');
    await http('POST', '/platform/v1/evidence', metadata(bytes, 'application/pdf', 'different.pdf'), 409, 'fixture-member', { 'Idempotency-Key': command });
    const uploadKey = randomUUID(), first = await upload(results[0], bytes, 'application/pdf', uploadKey);
    const second = await upload(results[0], bytes, 'application/pdf', uploadKey); assert.equal(first.id, second.id);
    assert.equal((await store.read(ctx, results[0].evidence.id)).uploadAttempts, 1);
    const conflict = await http('PUT', results[0].upload.href, Buffer.concat([bytes, Buffer.from('changed-payload')]), 409, 'fixture-member', { 'Content-Type': 'application/pdf', 'Idempotency-Key': uploadKey });
    assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT');
  });
  await check('EI-10/27 real clean scan, provenance, attachment and private object', async () => {
    // Drain both accepted clean documents, using persisted candidate discovery.
    while (await service.processNextScan(ctx)) {}
    const row = await store.read(ctx, registered.evidence.id); assert.equal(row.evidence.quarantine_state, 'CLEAN');
    assert.equal(row.history[0].engine, '1.4.6'); assert(row.history[0].definitions); assert(row.history[0].definitionsAt);
    const download = await http('GET', registered.upload.href, undefined, 200);
    assert.equal(checksum(download.bytes), row.evidence.sha256); assert.equal(download.response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.match(download.response.headers.get('Content-Disposition'), /^attachment;/);
    const anonymous = await fetch('http://127.0.0.1:19441/evidence-issue41/' + row.objectKey, { signal: AbortSignal.timeout(10000) }); assert.equal(anonymous.status, 403);
    return { engine: row.history[0].engine, definitions: row.history[0].definitions, definitionsAt: row.history[0].definitionsAt };
  });
  await check('EI-11/12 embedded harmless EICAR with misleading filename remains blocked', async () => {
    // Official harmless AV test string, decoded only in memory; never a repository file or report body.
    const pattern = Buffer.from('WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=', 'base64');
    const direct = await scanner.scan(pattern); assert.equal(direct.state, 'INFECTED');
    const embedded = await pdf(false, pattern);
    const item = await register(embedded, 'application/pdf', 'renamed.jpg'); await upload(item, embedded, 'application/pdf');
    await service.processNextScan(ctx); const row = await store.read(ctx, item.evidence.id); assert.equal(row.evidence.quarantine_state, 'INFECTED');
    await http('GET', item.upload.href, undefined, 409);
    await assert.rejects(service.withCleanBytes(ctx, item.evidence.id, 'extraction.request', async () => { throw new Error('Consumer must not run'); }), error => error.code === 'FILE_NOT_CLEAN');
    return { signature: row.history[0].reason };
  });
  await check('EI-15 actual encrypted PDF and decompression limit', async () => {
    const encrypted = await scanner.scan(await pdf(true)); assert.equal(encrypted.state, 'SCAN_FAILED');
    const bomb = gzipSync(Buffer.alloc(21 * 1048576, 65)); const limited = await scanner.scan(bomb); assert.equal(limited.state, 'SCAN_FAILED');
    assert.match(encrypted.reason, /^Heuristics\.Encrypted/); assert.match(limited.reason, /^Heuristics\.Limits\.Exceeded/);
    return { encrypted: encrypted.reason, decompression: limited.reason };
  });
  await check('EI-17 XML safety through HTTP before scan dispatch', async () => {
    for (const text of ['<!DOCTYPE a [<!ENTITY x SYSTEM "file:///secret">]><a>&x;</a>', '<a><b></a>', '<a>'.repeat(65) + '</a>'.repeat(65)]) {
      const xml = Buffer.from(text), item = await register(xml, 'application/xml');
      const result = await http('PUT', item.upload.href, xml, 422, 'fixture-member', { 'Content-Type': 'application/xml', 'Idempotency-Key': randomUUID() });
      assert.equal(result.code, 'DRAFT_INVALID'); assert.equal((await store.read(ctx, item.evidence.id)).accepted, false);
    }
  });
  await check('EI-20 real MinIO corruption with unchanged hash metadata revokes CLEAN', async () => {
    const row = await store.read(ctx, registered.evidence.id);
    const minio = new Client({ endPoint: '127.0.0.1', port: 19441, useSSL: false, accessKey: config.MINIO_ACCESS_KEY, secretKey: config.MINIO_SECRET_KEY });
    const changed = Buffer.concat([bytes, Buffer.from('corruption-fixture')]);
    await minio.putObject(config.MINIO_BUCKET_INVOICES, row.objectKey, changed, changed.length, { 'Content-Type': 'application/pdf', sha256: row.evidence.sha256 });
    const result = await http('GET', registered.upload.href, undefined, 422); assert.equal(result.code, 'CHECKSUM_MISMATCH');
    const revoked = await store.read(ctx, row.evidence.id); assert.equal(revoked.evidence.quarantine_state, 'SCAN_FAILED'); assert.equal(revoked.operation.state, 'RECONCILIATION_REQUIRED');
  });
  await check('EI-22 fault-injected finalization with real persisted intent/object and stable retry', async () => {
    const item = await register(bytes), command = randomUUID(); let fault = false;
    const faultStore = { commandHash: store.commandHash.bind(store), read: store.read.bind(store), operation: store.operation.bind(store), page: store.page.bind(store), candidate: store.candidate.bind(store),
      change: (...args) => { if (!args[2] && !fault) { fault = true; return Promise.reject(new Error('Acceptance-only commit fault')); } return store.change(...args); } };
    const faulty = new EvidenceService(faultStore, storage, scanner, access, cursorSecret, now);
    await assert.rejects(faulty.upload(ctx, item.evidence.id, stream(bytes), 'application/pdf', command), error => error.code === 'RECONCILIATION_REQUIRED');
    const before = await store.read(ctx, item.evidence.id); assert.equal(before.accepted, false); assert.equal(before.operation.state, 'RECONCILIATION_REQUIRED');
    const after = await service.upload(ctx, item.evidence.id, stream(bytes), 'application/pdf', command); assert.equal(after.id, before.operation.id);
    const recovered = await store.read(ctx, item.evidence.id); assert.equal(recovered.uploadAttempts, 2); assert.notEqual(recovered.objectKey, before.objectKey);
    const old = await storage.read(ctx, before.objectKey); const chunks = []; for await (const part of old) chunks.push(part); assert.equal(checksum(Buffer.concat(chunks)), checksum(bytes));
    while (await service.processNextScan(ctx)) {}
  });
  await check('EI-13/24/25 unavailable real scanner, persisted due times, recreated workers exhaust at three', async () => {
    const item = await register(bytes); await upload(item, bytes);
    const absent = new ClamavScanner({ host: '127.0.0.1', port: 33142, timeoutMs: 50, freshnessMs: 86400000, engine: '1.4.6' });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const restarted = new EvidenceService(new PostgresEvidenceStore(db), storage, absent, access, cursorSecret, now);
      const result = await restarted.processNextScan(ctx); assert.equal(result.state, attempt === 3 ? 'FAILED' : 'PENDING');
      assert.equal((await store.read(ctx, item.evidence.id)).scanAttempts, attempt);
      assert.equal(await restarted.processNextScan(ctx), undefined); shift += 10000;
    }
    const row = await store.read(ctx, item.evidence.id); assert.equal(row.history.length, 3); assert.equal(row.evidence.quarantine_state, 'SCAN_FAILED');
    await http('GET', item.upload.href, undefined, 409); shift = 0;
  });
  await check('EI-26 cursor binding and private storage context', async () => {
    const page = await http('GET', '/platform/v1/evidence?limit=1', undefined, 200); conforms('EvidencePage', page); assert(page.next_cursor);
    await http('GET', '/platform/v1/evidence?limit=1&cursor=' + page.next_cursor, undefined, 400, 'fixture-foreign');
    const row = await store.read(ctx, registered.evidence.id);
    await assert.rejects(storage.read(foreign, row.objectKey), error => error.code === 'FORBIDDEN');
  });
  console.log('PASS ' + checks.length + ' isolated runtime groups; production JWT/tenant bridge and release acceptance remain separate.');
}
main().catch(error => { console.error('FAIL isolated evidence runtime: ' + (error.code || error.name) + ' ' + (error.message || '').slice(0, 500)); process.exitCode = 1; }).finally(async () => {
  if (app) await app.close(); if (db) await db.onModuleDestroy();
  const files = fs.readdirSync(path.join(root, 'apps/api/src/platform/evidence')).filter(file => !file.endsWith('.spec.ts')).sort();
  const sourceHashes = Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, 'apps/api/src/platform/evidence', file))).digest('hex')]));
  const report = { started, completed: new Date().toISOString(), command: 'node infra/evidence/validate-runtime.cjs',
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    worktreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()), sourceHashes,
    environment: { node: process.version, platform: process.platform, scannerImage: 'clamav/clamav:1.4.6@sha256:b5b910ce43d595bf8a2fe401e34db56434602b2c755b7c2b07f00c917d04d469',
      identity: 'static server-side test identities; not production JWT/membership', persistence: 'real isolated PostgreSQL/MinIO/clamd', aiCalls: 0 }, checks, resources,
    pendingReleaseGates: ['PR #68 peer acceptance', '#43 verified tenant/JWT/ACL integration', 'A-owned numbered migration and shared composition review',
      'EI-16 daemon hang supervisor recovery', 'EI-19 real membership revocation', 'EI-29 coordinated snapshot restore', 'EI-30 full legacy real-stack regression'] };
  const directory = path.join(root, 'docs/ai/evidence'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'issue41-runtime.json'), JSON.stringify(report, null, 2) + '\n');
});
