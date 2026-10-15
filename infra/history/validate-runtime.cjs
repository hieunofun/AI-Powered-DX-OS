/* SPDX-License-Identifier: MIT */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { randomUUID, createHash } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { createFixture } = require('./runtime-fixture.cjs');
const root = path.resolve(__dirname, '../..'), started = new Date().toISOString(), checks = [], resources = {}, durations = [], sha = bytes => createHash('sha256').update(bytes).digest('hex');
const { fingerprint } = require(path.join(root, 'apps/api/dist/platform/evidence/file-safety.js'));
const Ajv = require('ajv'), ajv = new Ajv({ allErrors: true }), platform = require(path.join(root, 'packages/contracts/opendx/v1/schemas/platform.schema.json')),
  proposed = require(path.join(root, 'packages/contracts/opendx/proposed/issue57-history.schema.json')); ajv.addSchema(platform); ajv.addSchema(proposed);
const sourceHashes = {}, supportHashes = {};
for (const file of fs.readdirSync(path.join(root, 'apps/api/src/platform/history')).filter(name => name.endsWith('.ts') && !name.endsWith('.spec.ts'))) {
  const name = 'apps/api/src/platform/history/' + file; sourceHashes[name] = sha(fs.readFileSync(path.join(root, name)));
}
for (const name of ['infra/history/runtime-fixture.cjs', 'infra/history/validate-runtime.cjs', 'database/proposed/issue57-cold-history.sql', 'packages/contracts/opendx/proposed/issue57-history.schema.json']) supportHashes[name] = sha(fs.readFileSync(path.join(root, name)));
let f;
async function check(name, work) { try { await work(); checks.push({ name, status: 'PASS' }); console.log('PASS ' + name); }
  catch (error) { checks.push({ name, status: 'FAIL', code: error.code || error.name }); throw error; } }
function shape(name, body, schema = proposed) { const validate = ajv.getSchema(schema.$id + '#/definitions/' + name); assert.equal(validate(body), true, 'DTO mismatch ' + name + ' ' + JSON.stringify(validate.errors)); }
async function get(mode, params = {}, actor = 'reader', expected = 200) {
  const query = new URLSearchParams(params), response = await fetch(f.origin + '/platform/v1/history/' + f.stream + '/' + mode + (query.size ? '?' + query : ''),
    { headers: { Authorization: 'Bearer fixture-' + actor }, signal: AbortSignal.timeout(45000) });
  assert.equal(response.status, expected); const body = await response.json(); shape(expected >= 400 ? 'Error' : mode === 'cases' ? 'CasePage' : 'EventPage', body, expected >= 400 ? platform : proposed); return body;
}
function template(ctx, caseId = randomUUID(), version = '1', classification = 'COMPLETED', elapsed = 60000) {
  const ref = { pack_id: 'openresolve', type: 'case', id: caseId }, payload = { id: caseId, source_version: version, classification, invoice_total: '550000.0000', fixture: 'fictional-case-history-v1' };
  return { sequence: '1', event: { id: randomUUID(), type: 'openresolve.case.history.v1', tenant_id: ctx.tenantId, occurred_at: '2026-01-02T00:00:00Z', correlation_id: randomUUID(), subject_ref: ref,
    schema_id: 'openresolve.case-history.v1', payload_ref: { pack_id: 'openresolve', type: 'case-snapshot', id: randomUUID() } },
    snapshot: { ref, version, sha256: fingerprint(payload), payload }, case_metric: { ref, classification, started_at: '2026-01-01T00:00:00Z',
      ...(classification !== 'ACTIVE' ? { finished_at: new Date(Date.parse('2026-01-01T00:00:00Z') + elapsed).toISOString() } : {}), ...(classification === 'ERROR' ? { error_code: 'UPSTREAM_TIMEOUT' } : {}) },
    evidence: [{ ref: { pack_id: 'platform', type: 'evidence', id: randomUUID() }, version: 'synthetic-reference-1', sha256: 'a'.repeat(64) }],
    retention: { retention_class: 'STANDARD', retain_until: '2099-01-01T00:00:00Z', legal_hold: false, policy_version: 'fixture-retention-1' }, simulated: true };
}
const tenant = () => f.contexts.worker.tenantId;
async function count(table) { return Number((await f.cold.query('SELECT COUNT(*) FROM ' + table + ' WHERE tenant_id=$1', [tenant()])).rows[0].count); }
async function sourceHash() { return fingerprint((await f.hot.query('SELECT data FROM history_fixture_events WHERE tenant_id=$1 ORDER BY sequence', [tenant()])).rows.map(row => row.data)); }
async function project(jobId = 'live', limit = 100) { const begin = performance.now(), result = await f.projector.processPage(f.contexts.worker, f.stream, jobId, limit); durations.push(Math.round(performance.now() - begin)); return result; }
async function main() {
  if (process.argv.includes('--wait-ready')) {
    const { Client } = require('pg'), end = Date.now() + 120000;
    for (;;) { const client = new Client({ host: '127.0.0.1', port: 15457, user: 'history_fixture', password: 'history_fixture_local_only', database: 'history_hot_issue57', connectionTimeoutMillis: 1000 });
      try { await client.connect(); assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, 'history_hot_issue57'); break; }
      catch { if (Date.now() >= end) throw new Error('Isolated history database readiness timed out'); console.log('WAIT isolated PostgreSQL'); }
      finally { await client.end().catch(() => undefined); } await new Promise(resolve => setTimeout(resolve, 2000)); }
  }
  f = await createFixture();
  await check('actual hot and cold database separation with an unprivileged reporting identity', async () => {
    assert.equal(await f.source.databaseName(), 'history_hot_issue57'); assert.equal(await f.store.databaseName(), 'history_cold_issue57');
    const user = (await f.reader.query('SELECT current_user AS name')).rows[0].name; assert.equal(user, 'history_report_fixture');
    const role = (await f.hot.query('SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=$1', [user])).rows[0]; assert.deepEqual(role, { rolsuper: false, rolcreatedb: false, rolcreaterole: false });
  });
  const caseA = randomUUID(), caseB = randomUUID(), caseC = randomUUID(); Object.assign(resources, { caseA, caseB, caseC });
  await check('source commit/native snapshot preparation is explicitly synthetic and immutable', async () => {
    await f.append(f.contexts.worker, template(f.contexts.worker, caseA, '1', 'ACTIVE'));
    await f.append(f.contexts.worker, template(f.contexts.worker, caseA, '2'));
    await f.append(f.contexts.worker, template(f.contexts.worker, caseB, '1', 'ERROR', 120000));
    await f.append(f.contexts.worker, template(f.contexts.worker, caseC, '1', 'ACTIVE'));
    await f.append(f.contexts.foreignWorker, template(f.contexts.foreignWorker));
    await assert.rejects(f.hot.query('DELETE FROM history_fixture_events WHERE tenant_id=$1', [tenant()]), /append-only/);
  });
  const originalSourceHash = await sourceHash();
  await check('actual cold projection commits native snapshots, source/evidence lineage, cursor and immutable run together', async () => {
    const result = await project(); assert.equal(result.inserted, 4); assert.equal(result.checkpoint.state, 'SUCCEEDED');
    assert.equal(await count('platform_history_snapshots'), 4); assert.equal(await count('platform_history_lineage'), 8); assert.equal(await sourceHash(), originalSourceHash);
    const replay = await project(); assert.equal(replay.inserted, 0); assert.equal(await count('platform_history_snapshots'), 4);
  });
  await check('read-only real SQL reports latest case/time/error metrics and canonical hashes, never hot mutations', async () => {
    const cases = await get('cases'); assert.equal(cases.metrics.case_count, 3); assert.deepEqual(cases.metrics.classification_counts, { ACTIVE: 1, COMPLETED: 1, ERROR: 1 });
    assert.equal(cases.metrics.total_duration_ms, '180000'); assert.equal(cases.metrics.p95_duration_ms, 120000); assert.deepEqual(cases.metrics.errors, [{ code: 'UPSTREAM_TIMEOUT', count: 1 }]);
    assert.equal(cases.metrics.data_origin, 'SIMULATED'); assert.equal(cases.metrics.scope, 'AUTHORIZED_VISIBLE_PAGE');
    for (const row of cases.items) assert.equal(fingerprint(row.snapshot.payload), row.snapshot.sha256); assert.equal(await sourceHash(), originalSourceHash);
  });
  let backfillId, firstPage;
  await check('backfill freezes its committed source watermark and replays originals without duplicate rows', async () => {
    backfillId = randomUUID(); const result = await project(backfillId, 2); assert.equal(result.replayed, 2); assert.equal(result.checkpoint.state, 'RUNNING');
    resources.backfillThrough = result.checkpoint.through; firstPage = await get('events', { limit: '2' }); assert(firstPage.next_cursor);
  });
  await check('new live events cannot enter a frozen historical page or an already-started backfill', async () => {
    const caseD = randomUUID(); await f.append(f.contexts.worker, template(f.contexts.worker, caseD, '1', 'COMPLETED', 30000));
    const backfill = await project(backfillId, 2); assert.equal(backfill.checkpoint.through, resources.backfillThrough); assert.equal(backfill.replayed, 2); assert.equal(backfill.checkpoint.state, 'SUCCEEDED');
    assert.equal((await project()).inserted, 1); const second = await get('events', { limit: '2', cursor: firstPage.next_cursor }); assert.equal(second.items.length, 2); assert.equal(second.complete, true);
    assert.equal((await get('events')).items.length, 5); assert(!second.items.some(row => row.case_metric.ref.id === caseD));
  });
  await check('actual write-role exception rolls back cold snapshots/lineage/cursor/run, recreated projector resumes once', async () => {
    await f.append(f.contexts.worker, template(f.contexts.worker)); const before = await count('platform_history_snapshots'), old = await f.store.checkpoint(f.contexts.worker, f.stream, 'live');
    f.flags.failBeforeColdCommit = true; await assert.rejects(project(), /Injected exception after actual/);
    assert.equal(await count('platform_history_snapshots'), before); assert.deepEqual(await f.store.checkpoint(f.contexts.worker, f.stream, 'live'), old);
    assert.equal((await f.createProjector().processPage(f.contexts.worker, f.stream)).inserted, 1); assert.equal(await count('platform_history_snapshots'), before + 1);
  });
  await check('concurrent actual source/cold workers serialize or reject stale cursors without duplicated snapshots', async () => {
    await f.append(f.contexts.worker, template(f.contexts.worker)); const before = await count('platform_history_snapshots');
    const outcomes = await Promise.allSettled([f.createProjector().processPage(f.contexts.worker, f.stream), f.createProjector().processPage(f.contexts.worker, f.stream)]);
    assert(outcomes.some(result => result.status === 'fulfilled')); for (const result of outcomes) if (result.status === 'rejected') assert.equal(result.reason.code, 'REVISION_CONFLICT');
    assert.equal(await count('platform_history_snapshots'), before + 1);
  });
  await check('current ACL excludes historical case payload/lineage and its contribution to metrics', async () => {
    await f.hot.query('UPDATE history_fixture_case_grants SET can_read=false WHERE tenant_id=$1 AND case_id=$2 AND subject=$3', [tenant(), caseC, f.contexts.reader.subject]);
    const result = await get('cases'); assert(!result.items.some(row => row.case_metric.ref.id === caseC)); assert.equal(result.metrics.classification_counts.ACTIVE, 0);
    assert(!JSON.stringify(result).includes(caseC));
  });
  await check('expiry/legal hold retains originals, denies normal reads and requires an explicit current auditor grant', async () => {
    const before = await count('platform_history_snapshots');
    await f.hot.query("UPDATE history_fixture_cases SET retain_until='2020-01-01T00:00:00Z',legal_hold=true WHERE tenant_id=$1 AND id=$2", [tenant(), caseB]);
    const normal = await get('cases'); assert(!normal.items.some(row => row.case_metric.ref.id === caseB)); assert.equal(normal.metrics.classification_counts.ERROR, 0);
    const audit = await get('cases', {}, 'auditor'); assert(audit.items.some(row => row.case_metric.ref.id === caseB)); assert.equal(await count('platform_history_snapshots'), before);
  });
  await check('active foreign tenant uses its own projection while private tenant data and encrypted cursors remain isolated', async () => {
    await f.createProjector().processPage(f.contexts.foreignWorker, f.stream); const own = await get('cases', {}, 'foreign'); assert.equal(own.items.length, 1);
    assert(own.items.every(row => row.tenant_id === f.contexts.foreign.tenantId));
    const first = await get('events', { limit: '1' }); await get('events', { limit: '1', cursor: first.next_cursor }, 'foreign', 400);
    assert(!first.next_cursor.includes(tenant()));
  });
  await check('live membership revocation and actual unavailable authority TCP connection fail closed', async () => {
    await f.hot.query('UPDATE history_fixture_members SET active=false WHERE tenant_id=$1 AND subject=$2', [tenant(), f.contexts.reader.subject]);
    try { await get('cases', {}, 'reader', 403); } finally { await f.hot.query('UPDATE history_fixture_members SET active=true WHERE tenant_id=$1 AND subject=$2', [tenant(), f.contexts.reader.subject]); }
    f.flags.authorityUnavailable = true; try { await get('cases', {}, 'reader', 503); } finally { f.flags.authorityUnavailable = false; }
  });
  await check('actual reporting role cannot INSERT into hot OLTP or cold history even in a read-write SQL transaction', async () => {
    for (const [pool, table] of [[f.reportHotPool, 'history_fixture_events'], [f.reportColdPool, 'platform_history_snapshots']]) {
      const client = await pool.connect(); let code;
      try { await client.query('BEGIN'); await client.query('SET TRANSACTION READ WRITE');
        try { await client.query('INSERT INTO ' + table + ' SELECT * FROM ' + table + ' LIMIT 1'); } catch (error) { code = error.code; }
      } finally { await client.query('ROLLBACK'); client.release(); } assert.equal(code, '42501');
    }
  });
  await check('append-only cold history/lineage/runs and monotonic checkpoints retain source hashes', async () => {
    for (const table of ['platform_history_snapshots', 'platform_history_lineage', 'platform_history_projection_runs']) await assert.rejects(f.cold.query('DELETE FROM ' + table + ' WHERE tenant_id=$1', [tenant()]), /append-only/);
    await assert.rejects(f.cold.query("UPDATE platform_history_projection_jobs SET data=jsonb_set(data,'{after}','\"0\"') WHERE tenant_id=$1 AND job_id='live'", [tenant()]), /immutable\/monotonic/);
    for (const row of (await f.cold.query('SELECT data FROM platform_history_snapshots WHERE tenant_id=$1', [tenant()])).rows) assert.equal(fingerprint(row.data.entry), row.data.nativeHash);
  });
  for (const [name, hash] of Object.entries({ ...sourceHashes, ...supportHashes })) assert.equal(sha(fs.readFileSync(path.join(root, name))), hash, 'Code changed during acceptance');
}
main().catch(error => { if (!checks.some(check => check.status === 'FAIL')) checks.push({ name: 'runtime setup/completion', status: 'FAIL', code: error.code || error.name });
  console.error('FAIL history runtime: ' + (error.code || error.name) + ' ' + String(error.message).slice(0, 300)); process.exitCode = 1;
}).finally(async () => {
  let retainedState;
  if (f) {
    try { const id = tenant(); retainedState = {
      sourceEvents: (await f.hot.query('SELECT data FROM history_fixture_events WHERE tenant_id=$1 ORDER BY sequence', [id])).rows.map(row => row.data),
      coldSnapshots: (await f.cold.query('SELECT capture_sequence::text,data FROM platform_history_snapshots WHERE tenant_id=$1 ORDER BY platform_history_snapshots.capture_sequence', [id])).rows,
      lineage: (await f.cold.query('SELECT snapshot_id,ordinal,edge FROM platform_history_lineage WHERE tenant_id=$1 ORDER BY snapshot_id,ordinal', [id])).rows,
      checkpoints: (await f.cold.query('SELECT data FROM platform_history_projection_jobs WHERE tenant_id=$1', [id])).rows.map(row => row.data),
      runs: (await f.cold.query('SELECT * FROM platform_history_projection_runs WHERE tenant_id=$1 ORDER BY id', [id])).rows };
    } catch (error) { checks.push({ name: 'retain actual isolated history evidence', status: 'FAIL', code: error.code || error.name }); process.exitCode = 1; }
    finally { await f.close(); }
  }
  const report = { started, completed: new Date().toISOString(), gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    worktreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()), sourceHashes, supportHashes, checks, resources, retainedState, projectionDurationsMs: durations,
    environment: { node: process.version, platform: process.platform, services: 'actual PostgreSQL separate hot/cold databases, SELECT-only reporting role, Nest HTTP',
      source: 'explicit SQL-backed synthetic Case/Event/evidence-reference and identity/ACL/retention fixtures; production #43/#50 owning source absent',
      fault: 'injected exception after actual cold snapshot/cursor/run SQL, not process-kill recovery' }, actualProviderRequests: 0,
    limitations: ['No original evidence byte/AV/model or production SSO/Case/Decision/ledger integration claim', 'No hot deletion/cold purge or retention-administration API', 'No production load, process-kill or coordinated restore claim'] };
  const output = path.join(root, 'docs/ai/evidence/issue57-history-runtime-' + started.replaceAll(/[^0-9]/g, '') + '.json'); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
});
