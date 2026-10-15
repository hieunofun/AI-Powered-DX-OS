/* SPDX-License-Identifier: MIT */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID, generateKeyPairSync, createHash } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { Pool } = require('pg');
const root = path.resolve(__dirname, '../..'), startedAt = new Date().toISOString(), checks = [], resources = {}, timings = {};
const { createFixture } = require('./runtime-fixture.cjs');
const load = file => require(path.join(root, 'apps/api/dist', file));
const { checksum, fingerprint } = load('platform/evidence/file-safety.js');
const { ONBOARDING_MANIFEST } = load('packs/onboarding/onboarding.manifest.js');
let f, failed;
async function check(name, work) { const at = Date.now(); try { await work(); checks.push({ name, status: 'PASS', elapsedMs: Date.now() - at }); console.log('PASS ' + name); }
  catch (error) { checks.push({ name, status: 'FAIL', code: error.code || error.name, message: error.message }); throw error; } }
async function waitReady() {
  const { ClamavScanner } = load('platform/evidence/clamav.scanner.js');
  const scanner = new ClamavScanner({ host: '127.0.0.1', port: 33160, timeoutMs: 10000, freshnessMs: 86400000, engine: '1.4.6' });
  const pool = new Pool({ host: '127.0.0.1', port: 15460, database: 'onboarding_issue60', user: 'onboarding_fixture', password: 'onboarding_fixture_local_only', connectionTimeoutMillis: 3000 });
  try { const until = Date.now() + 600000; while (Date.now() < until) {
    try {
      await pool.query('SELECT 1');
      assert.equal((await fetch('http://127.0.0.1:19460/minio/health/ready', { signal: AbortSignal.timeout(3000) })).ok, true);
      assert.equal((await fetch('http://127.0.0.1:18060/flowable-rest/service/management/engine', { headers: { Authorization: 'Basic ' + Buffer.from('onboarding-service:onboarding_engine_fixture_local_only').toString('base64') }, signal: AbortSignal.timeout(3000) })).ok, true);
      assert.equal((await scanner.scan(Buffer.from('Synthetic scanner readiness'))).state, 'CLEAN'); return;
    } catch { console.log('Waiting for isolated PG/MinIO/fresh ClamAV/Flowable'); await new Promise(resolve => setTimeout(resolve, 3000)); }
  } throw new Error('Isolated services did not become ready within ten minutes'); } finally { await pool.end(); }
}
async function main() {
  if (process.argv.includes('--wait-ready')) await waitReady();
  await check('pinned generic core/checker unchanged; declared manifest and BPMN match', async () => {
    resources.coreProof = JSON.parse(execFileSync(process.execPath, ['infra/onboarding/verify-core.cjs'], { cwd: root, encoding: 'utf8' }));
    const Ajv = require('ajv'), schema = require(path.join(root, 'packages/contracts/opendx/v1/schemas/platform.schema.json')), ajv = new Ajv({ allErrors: true }); ajv.addSchema(schema);
    const validate = ajv.getSchema(schema.$id + '#/definitions/PackManifest'); assert.equal(validate(ONBOARDING_MANIFEST), true, JSON.stringify(validate.errors));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8')), ONBOARDING_MANIFEST);
    const bpmn = fs.readFileSync(path.join(__dirname, 'access-review.bpmn')); assert.equal(checksum(bpmn), ONBOARDING_MANIFEST.workflow_refs[0].sha256);
    assert.doesNotMatch(bpmn.toString(), /serviceTask|scriptTask|sendTask|http:.*task/i);
  });
  f = await createFixture(); resources.deployedDefinition = f.definition; const { db, tenant, contexts: ctx } = f, base = '/packs/onboarding/v1/cases/';
  const read = id => f.store.read(ctx.requester, id);
  const counts = async () => { const value = {}; for (const table of ['onboarding_cases', 'onboarding_history', 'onboarding_commands', 'onboarding_snapshots', 'onboarding_event_outbox', 'platform_lineage_snapshots', 'platform_lineage_links']) value[table] = (await db.query('SELECT count(*)::text AS n FROM ' + table + ' WHERE tenant_id=$1', [tenant])).rows[0].n; return value; };
  let source, completedId;
  await check('real private MinIO bytes, exact fresh ClamAV scan and immutable registered source', async () => {
    source = await f.register(); resources.evidence = { id: source.evidenceId, sha256: source.sha256 };
    const record = await f.evidenceStore.read(ctx.worker, source.evidenceId); resources.scannerHistory = record.history;
    await f.evidence.withCleanBytes(ctx.requester, source.evidenceId, 'evidence.download', async (bytes, recheck) => { assert.equal(checksum(bytes), source.sha256); await recheck(); });
    const response = await fetch('http://127.0.0.1:19460/' + f.storage.bucket + '/' + record.objectKey, { signal: AbortSignal.timeout(10000) }); assert.notEqual(response.status, 200);
    await assert.rejects(db.query('UPDATE onboarding_fixture_raw_snapshots SET data=data WHERE tenant_id=$1 AND evidence_id=$2', [tenant, source.evidenceId]));
  });
  await check('actual RS256/JWKS rejects expired/forged token and current membership revocation', async () => {
    const route = '/packs/onboarding/v1/cases';
    await f.api('POST', route, { display_label: 'Expired' }, 401, 'requester', {}, f.sign('requester', { expiresIn: -1 }));
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }); await f.api('POST', route, { display_label: 'Forged' }, 401, 'requester', {}, f.sign('requester', {}, other.privateKey));
    const token = f.sign(); await db.query('UPDATE onboarding_fixture_members SET active=false WHERE tenant_id=$1 AND subject=$2', [tenant, ctx.requester.subject]);
    await f.api('POST', route, { display_label: 'Revoked' }, 403, 'requester', {}, token);
    await db.query('UPDATE onboarding_fixture_members SET active=true WHERE tenant_id=$1 AND subject=$2', [tenant, ctx.requester.subject]);
  });
  await check('HTTP rejects client identity/provisioning/scopes and unknown mutation routes', async () => {
    const before = await counts();
    for (const extra of [{ tenant_id: ctx.foreign.tenantId }, { requester: ctx.reviewer.subject }, { provisioning_state: 'PROVISIONED' }]) await f.api('POST', '/packs/onboarding/v1/cases', { display_label: 'Invalid', ...extra }, 400, 'requester', { 'Idempotency-Key': randomUUID() });
    for (const route of ['/process', '/reconcile', '/provision']) await f.api('POST', '/packs/onboarding/v1' + route, {}, 404);
    assert.deepEqual(await counts(), before);
  });
  await check('actual HTTP checklist/access request/independent SQL decision/Flowable approved end', async () => {
    const at = Date.now(), result = await f.deciding(source.evidenceId); completedId = result.id;
    const before = await read(result.id); assert.equal(before.provisioningState, 'NOT_PROVISIONED'); assert.equal((await f.worker().processNext(ctx.worker)).state, 'SUCCEEDED');
    const view = await f.api('GET', base + result.id); assert.equal(view.state, 'COMPLETED'); assert.equal(view.provisioning_state, 'NOT_PROVISIONED');
    const record = await read(result.id), task = await f.engineBase.historicTask(record.workflow.taskId), process = await f.engineBase.process(record.workflow.processId);
    assert.ok(process.endTime && task.endTime); assert.equal(task.assignee, ctx.reviewer.subject);
    assert.deepEqual(task.variables.filter(v => v.name === 'applicationOperationId').map(v => ({ value: v.value, scope: v.scope })), [{ value: record.intent.operationId, scope: 'local' }]);
    assert.equal((await f.engineBase.processes(record.workflow.businessKey)).length, 1); assert.doesNotMatch(JSON.stringify(view), /lease|businessKey|decision_snapshot/);
    timings.firstCaseElapsedMs = Date.now() - at; timings.fixtureIntegrationElapsedMs = Date.now() - Date.parse(f.fixtureStartedAt); resources.completed = { caseId: record.id, requestId: record.request.id, decisionRef: result.ref, processId: process.id, taskId: task.id, endedAt: process.endTime };
  });
  await check('actual rejected decision reaches rejected end without external provisioning', async () => {
    const { id } = await f.deciding(source.evidenceId, 'REJECT'); assert.equal((await f.worker().processNext(ctx.worker)).state, 'SUCCEEDED');
    const record = await read(id); assert.equal(record.state, 'REJECTED'); assert.equal(record.provisioningState, 'NOT_PROVISIONED');
  });
  await check('tenant predicates/current resource denial protect actual case and operation routes', async () => {
    const record = await read(completedId); await f.api('GET', base + completedId, undefined, 404, 'foreign');
    await f.api('GET', '/packs/onboarding/v1/operations/' + record.intent.operationId, undefined, 404, 'foreign');
    await db.query('INSERT INTO onboarding_fixture_denials VALUES($1,$2,$3)', [tenant, ctx.requester.subject, completedId]); await f.api('GET', base + completedId, undefined, 403);
    await db.query('DELETE FROM onboarding_fixture_denials WHERE tenant_id=$1 AND subject=$2 AND resource_id=$3', [tenant, ctx.requester.subject, completedId]);
  });
  await check('concurrent real PG command idempotency returns exact response with one intent', async () => {
    const key = randomUUID(), body = { display_label: 'FICTIONAL concurrent replay' }, before = await counts();
    const values = await Promise.all([1, 2].map(() => f.api('POST', '/packs/onboarding/v1/cases', body, 201, 'requester', { 'Idempotency-Key': key })));
    assert.deepEqual(values[0], values[1]); await f.api('POST', '/packs/onboarding/v1/cases', { display_label: 'Changed' }, 409, 'requester', { 'Idempotency-Key': key });
    const after = await counts(); assert.equal(BigInt(after.onboarding_cases) - BigInt(before.onboarding_cases), 1n); assert.equal(BigInt(after.onboarding_event_outbox) - BigInt(before.onboarding_event_outbox), 1n);
  });
  await check('actual shared lineage/history/event/command writes roll back atomically on injected failure', async () => {
    const record = await f.create(), before = await counts(), route = base + record.id + '/checklist/WELCOME_ACK', body = { evidence_id: source.evidenceId, acknowledged: true, expected_revision: 0 }, key = randomUUID();
    f.flags.failCapture = true; await f.api('POST', route, body, 503, 'requester', { 'Idempotency-Key': key }); assert.deepEqual(await counts(), before); assert.equal((await read(record.id)).checklist.length, 0);
    await f.api('POST', route, body, 200, 'requester', { 'Idempotency-Key': key }); assert.equal((await read(record.id)).checklist.length, 1);
  });
  await check('disabled/incompatible/hash-conflicting/undeclared pack bindings fail closed', async () => {
    const before = { ...f.engineCalls }, route = '/packs/onboarding/v1/cases';
    for (const change of [{ enabled: false }, { core_version: '2.0.0' }, { manifest_sha256: 'f'.repeat(64) }]) {
      await db.query('UPDATE onboarding_fixture_registry SET binding=$2::jsonb WHERE tenant_id=$1', [tenant, JSON.stringify({ ...f.binding, ...change })]);
      await f.api('POST', route, { display_label: 'Disabled or broken' }, 409, 'requester', { 'Idempotency-Key': randomUUID() });
    }
    await db.query('UPDATE onboarding_fixture_registry SET binding=$2::jsonb,permissions=$3::jsonb WHERE tenant_id=$1', [tenant, JSON.stringify(f.binding), JSON.stringify([])]);
    await f.api('POST', route, { display_label: 'Undeclared' }, 403, 'requester', { 'Idempotency-Key': randomUUID() });
    await db.query('UPDATE onboarding_fixture_registry SET permissions=$2::jsonb WHERE tenant_id=$1', [tenant, JSON.stringify(ONBOARDING_MANIFEST.permissions)]); assert.deepEqual(f.engineCalls, before);
  });
  await check('source requester/file authority and owner decision are rechecked before actual engine writes', async () => {
    const { id, ref } = await f.deciding(source.evidenceId), before = f.engineCalls.complete;
    await db.query('UPDATE onboarding_fixture_decisions SET active=false WHERE tenant_id=$1 AND id=$2', [tenant, ref.id]);
    await f.worker().processNext(ctx.worker); assert.equal(f.engineCalls.complete, before); assert.equal((await read(id)).state, 'RECONCILIATION_REQUIRED');
    await db.query('UPDATE onboarding_fixture_decisions SET active=true WHERE tenant_id=$1 AND id=$2', [tenant, ref.id]);
    await db.query('DELETE FROM onboarding_fixture_evidence_grants WHERE tenant_id=$1 AND subject=$2 AND evidence_id=$3', [tenant, ctx.requester.subject, source.evidenceId]);
    await f.worker().reconcile(ctx.worker, id); assert.equal(f.engineCalls.complete, before); assert.equal((await read(id)).state, 'RECONCILIATION_REQUIRED');
    await db.query('INSERT INTO onboarding_fixture_evidence_grants VALUES($1,$2,$3)', [tenant, ctx.requester.subject, source.evidenceId]);
  });
  await check('timeout after real start recovers with recreated read-only worker and one native process', async () => {
    const id = await f.ready(source.evidenceId), starts = f.engineCalls.start; f.flags.fault = 'start-after';
    assert.equal((await f.worker().processNext(ctx.worker)).state, 'RECONCILIATION_REQUIRED'); const before = { ...f.engineCalls };
    assert.equal((await f.worker().reconcile(ctx.worker, id)).state, 'SUCCEEDED'); assert.equal(f.engineCalls.start, starts + 1); assert.equal(f.engineCalls.claim, before.claim); assert.equal(f.engineCalls.complete, before.complete);
    assert.equal((await f.engineBase.processes((await read(id)).workflow.businessKey)).length, 1);
  });
  await check('timeout after real claim reconciles through reads before one verified completion', async () => {
    const { id } = await f.deciding(source.evidenceId), claims = f.engineCalls.claim, completions = f.engineCalls.complete; f.flags.fault = 'claim-after';
    await f.worker().processNext(ctx.worker); await f.worker().reconcile(ctx.worker, id); assert.equal(f.engineCalls.claim, claims + 1); assert.equal(f.engineCalls.complete, completions);
    assert.equal((await f.worker().processNext(ctx.worker)).state, 'SUCCEEDED'); assert.equal(f.engineCalls.complete, completions + 1); assert.equal((await read(id)).state, 'COMPLETED');
  });
  await check('timeout after real complete recovers exact local marker with no second write', async () => {
    const { id } = await f.deciding(source.evidenceId); f.flags.fault = 'complete-after'; await f.worker().processNext(ctx.worker); const before = { ...f.engineCalls };
    assert.equal((await read(id)).state, 'RECONCILIATION_REQUIRED'); assert.equal((await f.worker().reconcile(ctx.worker, id)).state, 'SUCCEEDED');
    for (const name of ['start', 'claim', 'complete']) assert.equal(f.engineCalls[name], before[name]); assert.equal((await read(id)).state, 'COMPLETED');
  });
  await check('current decision revocation after actual completion withholds final state until restored', async () => {
    const { id, ref } = await f.deciding(source.evidenceId); f.flags.afterComplete = () => db.query('UPDATE onboarding_fixture_decisions SET active=false WHERE tenant_id=$1 AND id=$2', [tenant, ref.id]);
    await f.worker().processNext(ctx.worker); assert.equal((await read(id)).state, 'RECONCILIATION_REQUIRED'); const completions = f.engineCalls.complete;
    await db.query('UPDATE onboarding_fixture_decisions SET active=true WHERE tenant_id=$1 AND id=$2', [tenant, ref.id]); await f.worker().reconcile(ctx.worker, id);
    assert.equal((await read(id)).state, 'COMPLETED'); assert.equal(f.engineCalls.complete, completions);
  });
  await check('native history/lineage/source hashes preserved; outbox stays pending; all provisioning absent', async () => {
    for (const row of (await db.query('SELECT record,sha256 FROM onboarding_history WHERE tenant_id=$1', [tenant])).rows) assert.equal(fingerprint(row.record), row.sha256);
    assert.equal((await db.query("SELECT count(*)::text AS n FROM onboarding_cases WHERE tenant_id=$1 AND data->>'provisioningState'<>'NOT_PROVISIONED'", [tenant])).rows[0].n, '0');
    assert.equal((await db.query("SELECT count(*)::text AS n FROM onboarding_event_outbox WHERE tenant_id=$1 AND state<>'PENDING'", [tenant])).rows[0].n, '0');
    assert.ok(BigInt((await db.query('SELECT count(*)::text AS n FROM platform_lineage_links WHERE tenant_id=$1', [tenant])).rows[0].n) > 0n);
    resources.counts = await counts(); resources.engineCalls = { ...f.engineCalls };
    await assert.rejects(db.query('DELETE FROM onboarding_history WHERE tenant_id=$1', [tenant]));
    await assert.rejects(db.query("UPDATE onboarding_cases SET data=jsonb_set(data,'{provisioningState}','\"PROVISIONED\"') WHERE tenant_id=$1 AND id=$2", [tenant, completedId]));
  });
}
main().catch(error => { failed = { code: error.code || error.name, message: error.message }; console.error('FAIL ' + failed.message); process.exitCode = 1; }).finally(async () => {
  const sourceHashes = {}; const files = execFileSync('git', ['ls-files', 'apps/api/src/packs/onboarding', 'apps/api/src/platform', 'infra/onboarding', 'database/proposed/issue60-onboarding-pack.sql'], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
  for (const file of files) sourceHashes[file] = createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
  const baseline = require('./core-baseline.json'), report = { issue: 60, startedAt, finishedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    environment: { node: process.version, platform: process.platform, postgres: '16-alpine isolated', minio: 'existing source-built pinned MinIO', clamav: '1.4.6 pinned/fresh <=24h', flowable: '8.0.0 pinned official image/history full', identity: 'actual generic AuthService RS256/JWKS, ephemeral local issuer' },
    fixtures: ['SQL-backed current tenant membership/roles and resource denials (#43)', 'SQL-backed registered compatible manifest/declared permissions (#59)', 'SQL-backed independent owner decision (#50); scripted distinct actors, no human peer review'],
    limitations: ['Production owner #43/#50/#59 adapters and integration time remain unverified', 'Pending events have no owning SDK dispatcher proof', 'No external accounts/grants/tokens provisioned', 'Tiny synthetic fixture timings are not production performance'],
    timings: { ...timings, packImplementationWallElapsedMs: Date.now() - Date.parse(baseline.packImplementationStartedAt), actualOwningSdkIntegrationElapsedMs: null }, checks, resources, sourceHashes, ...(failed ? { failure: failed } : {}) };
  const directory = path.join(root, 'docs/ai/evidence'); fs.mkdirSync(directory, { recursive: true }); const file = path.join(directory, 'issue60-onboarding-runtime-' + new Date().toISOString().replace(/\D/g, '') + '.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log('Retained ' + path.relative(root, file)); if (f) await f.close();
});
