/* SPDX-License-Identifier: MIT */
'use strict';
// Native PostgreSQL component restore, not complete AT-12 or a production recovery implementation.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto'), { execFileSync } = require('node:child_process'), { Pool } = require('pg');
const { performance } = require('node:perf_hooks'), { createFixture } = require('../history/runtime-fixture.cjs');
const os = require('node:os');
const root = path.resolve(__dirname, '../..'), load = file => require(path.join(root, 'apps/api/dist', file));
const { fingerprint } = load('platform/evidence/file-safety.js');
const sha = value => createHash('sha256').update(value).digest('hex'), startedAt = new Date().toISOString(), run = randomUUID().replaceAll('-', '').slice(0, 12), checks = [], resources = {}, times = {};
const docker = process.platform === 'win32' ? 'docker.exe' : 'docker', compose = ['compose', '-f', path.join(__dirname, 'compose.yaml')];
const command = args => execFileSync(docker, [...compose, ...args], { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1048576, windowsHide: true });
const config = { host: '127.0.0.1', user: 'history_fixture', password: 'history_fixture_local_only', connectionTimeoutMillis: 3000, max: 4 };
let f, control, failure; const pools = [];
const database = pool => ({ query: (sql, args) => pool.query(sql, args), transaction: async work => { const client = await pool.connect(); try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } } });
async function check(name, work) { try { await work(); checks.push({ name, status: 'PASS' }); console.log('PASS ' + name); } catch (error) { checks.push({ name, status: 'FAIL', code: error.code || error.name, message: error.message }); throw error; } }
async function waitReady() {
  const until = Date.now() + 120000;
  for (;;) { const probe = [new Pool({ ...config, port: 15457, database: 'history_hot_issue57' }), new Pool({ ...config, port: 15466, database: 'restore_control_issue66' })];
    try { await Promise.all(probe.map(pool => pool.query('SELECT 1'))); return; } catch { if (Date.now() >= until) throw new Error('Isolated source/restore PostgreSQL readiness timed out'); console.log('WAIT isolated source/restore databases'); }
    finally { await Promise.all(probe.map(pool => pool.end())); } await new Promise(resolve => setTimeout(resolve, 2000));
  }
}
function entry(ctx, id, version = '1') {
  const ref = { pack_id: 'openresolve', type: 'case', id }, payload = { id, version, classification: 'COMPLETED', total: '9007199254740993.00', disclosure: 'SYNTHETIC' };
  return { sequence: '1', event: { id: randomUUID(), type: 'openresolve.case.history.v1', tenant_id: ctx.tenantId, occurred_at: '2026-01-02T00:00:00Z', correlation_id: randomUUID(), subject_ref: ref, schema_id: 'openresolve.case-history.v1', payload_ref: { pack_id: 'openresolve', type: 'case-snapshot', id: randomUUID() } },
    snapshot: { ref, version, sha256: fingerprint(payload), payload }, case_metric: { ref, classification: 'COMPLETED', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:01:00Z' },
    evidence: [{ ref: { pack_id: 'platform', type: 'evidence', id: randomUUID() }, version: 'synthetic-reference-1', sha256: 'a'.repeat(64) }], retention: { retention_class: 'STANDARD', retain_until: '2099-01-01T00:00:00Z', legal_hold: false, policy_version: 'fixture-retention-1' }, simulated: true };
}
async function inventory(db, kind) {
  return db.transaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'); await client.query("SET LOCAL TIME ZONE 'UTC'");
    const names = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row => row.tablename), result = {};
    for (const name of names) {
      assert.match(name, kind === 'hot' ? /^history_fixture_[a-z_]+$/ : /^platform_history_[a-z_]+$/, 'Unknown table cannot be silently omitted');
      // SQL JSON text preserves native BIGINT/decimal values without JS Number coercion.
      const rows = (await client.query('SELECT row_to_json(t)::text AS raw FROM public."' + name + '" t')).rows.map(row => row.raw).sort();
      const digest = createHash('sha256'); for (const row of rows) digest.update(Buffer.byteLength(row) + ':' + row + '\n'); result[name] = { rows: rows.length, sha256: digest.digest('hex') };
    }
    const sequenceNames = (await client.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows.map(row => row.sequencename), sequences = {};
    for (const name of sequenceNames) {
      assert.match(name, kind === 'hot' ? /^history_fixture_[a-z_]+_seq$/ : /^platform_history_[a-z_]+_seq$/);
      sequences[name] = (await client.query('SELECT last_value::text,is_called FROM public."' + name + '"')).rows[0];
    } return { tables: result, sequences };
  });
}
async function main() {
  if (!process.argv.includes('--isolated-rehearsal')) throw new Error('Explicit --isolated-rehearsal required'); if (process.argv.includes('--wait-ready')) await waitReady();
  control = new Pool({ ...config, port: 15466, database: 'restore_control_issue66' }); pools.push(control);
  assert.equal((await control.query('SELECT current_database() AS name')).rows[0].name, 'restore_control_issue66');
  f = await createFixture();
  await check('source/target are explicitly named isolated databases and different containers', async () => {
    assert.equal((await f.hot.query('SELECT current_database() AS name')).rows[0].name, 'history_hot_issue57'); assert.equal((await f.cold.query('SELECT current_database() AS name')).rows[0].name, 'history_cold_issue57');
    const sourceId = command(['ps', '-q', 'postgres']).trim(), restoreId = command(['ps', '-q', 'restore']).trim(); assert.ok(sourceId && restoreId && sourceId !== restoreId);
    resources.containers = { source: sourceId, restore: restoreId }; resources.postgresVersion = { source: (await f.hot.query('SELECT version() AS value')).rows[0].value, restore: (await control.query('SELECT version() AS value')).rows[0].value };
  });
  await check('actual source append and cold projector retain IDs/sequences/lineage beyond JS safe integers', async () => {
    await f.hot.query("SELECT setval(pg_get_serial_sequence('history_fixture_events','sequence'),9007199254740993,false)");
    const id = randomUUID(), first = await f.append(f.contexts.worker, entry(f.contexts.worker, id)); assert.equal(first.sequence, '9007199254740993');
    await f.append(f.contexts.worker, entry(f.contexts.worker, id, '2')); await f.append(f.contexts.worker, entry(f.contexts.worker, randomUUID()));
    const projected = await f.projector.processPage(f.contexts.worker, f.stream, 'live', 100); assert.equal(projected.inserted, 3);
    resources.projected = projected; resources.tenant = f.contexts.worker.tenantId;
  });
  // One controlled writer, every job awaited, HTTP host closed before either native snapshot.
  await f.app.close(); resources.quiescence = 'Isolated single-writer fixture stopped after awaited projection; no production quiescence claim';
  const directory = path.resolve(root, 'tmp', 'issue66-' + run); assert.ok(directory.startsWith(path.resolve(root, 'tmp') + path.sep)); fs.mkdirSync(directory, { recursive: true });
  resources.dumps = []; const restored = {};
  await check('native pg_dump/pg_restore into new empty databases preserve every hot/cold row hash', async () => {
    for (const [kind, sourceName, sourceDb] of [['hot', 'history_hot_issue57', f.hot], ['cold', 'history_cold_issue57', f.cold]]) {
      const targetName = 'restore_' + kind + '_issue66_' + run; assert.match(targetName, /^restore_(?:hot|cold)_issue66_[a-f0-9]{12}$/);
      assert.equal((await control.query('SELECT 1 FROM pg_database WHERE datname=$1', [targetName])).rows.length, 0, 'Never overwrite an existing restore');
      await control.query('CREATE DATABASE "' + targetName + '" OWNER history_fixture');
      const pool = new Pool({ ...config, port: 15466, database: targetName }); pools.push(pool); const target = database(pool); restored[kind] = { database: target, pool, name: targetName };
      assert.equal((await pool.query("SELECT count(*)::text AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n, '0');
      const before = await inventory(sourceDb, kind), containerFile = '/tmp/issue66-' + run + '-' + kind + '.dump', localFile = path.join(directory, kind + '.dump');
      let begin = performance.now(); command(['exec', '-T', 'postgres', 'pg_dump', '-U', 'history_fixture', '-d', sourceName, '--format=custom', '--serializable-deferrable', '--file=' + containerFile]); times[kind + 'DumpMs'] = Math.round(performance.now() - begin);
      command(['cp', 'postgres:' + containerFile, localFile]); assert.ok(fs.statSync(localFile).size < 67108864); command(['cp', localFile, 'restore:' + containerFile]);
      begin = performance.now(); command(['exec', '-T', 'restore', 'pg_restore', '-U', 'history_fixture', '-d', targetName, '--single-transaction', '--exit-on-error', '--no-owner', '--no-acl', containerFile]); times[kind + 'RestoreMs'] = Math.round(performance.now() - begin);
      const after = await inventory(target, kind); assert.deepEqual(after, before); assert.deepEqual(await inventory(sourceDb, kind), before, 'Backup mutated source');
      resources.dumps.push({ kind, sourceDatabase: sourceName, targetDatabase: targetName, path: path.relative(root, localFile), bytes: fs.statSync(localFile).size, sha256: sha(fs.readFileSync(localFile)), inventory: after });
    }
  });
  await check('restored native source sequence, snapshots and append-only guards remain valid', async () => {
    const sequences = (await restored.hot.pool.query('SELECT sequence::text AS value FROM history_fixture_events ORDER BY sequence')).rows.map(row => row.value); assert.deepEqual(sequences, ['9007199254740993', '9007199254740994', '9007199254740995']);
    for (const row of (await restored.cold.pool.query('SELECT data FROM platform_history_snapshots')).rows) { assert.equal(fingerprint(row.data.entry.snapshot.payload), row.data.entry.snapshot.sha256); }
    await assert.rejects(restored.hot.pool.query('DELETE FROM history_fixture_events'), /append-only/); await assert.rejects(restored.cold.pool.query('DELETE FROM platform_history_snapshots'), /append-only/);
    resources.restoredSequences = sequences;
  });
  await check('restored fixture reports use an actual SELECT-only role, not read-only transaction flags', async () => {
    await control.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='restore_report_issue66') THEN CREATE ROLE restore_report_issue66 LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD 'restore_report_fixture_local_only'; END IF; END $$");
    const role = (await control.query("SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname='restore_report_issue66'")).rows[0]; assert.deepEqual(role, { rolsuper: false, rolcreatedb: false, rolcreaterole: false });
    for (const kind of ['hot', 'cold']) {
      const target = restored[kind]; await target.pool.query('GRANT CONNECT ON DATABASE "' + target.name + '" TO restore_report_issue66; GRANT USAGE ON SCHEMA public TO restore_report_issue66; GRANT SELECT ON ALL TABLES IN SCHEMA public TO restore_report_issue66');
      const pool = new Pool({ ...config, port: 15466, database: target.name, user: 'restore_report_issue66', password: 'restore_report_fixture_local_only' }); pools.push(pool);
      const table = kind === 'hot' ? 'history_fixture_events' : 'platform_history_snapshots'; assert.equal((await pool.query('SELECT count(*)::text AS n FROM ' + table)).rows[0].n, '3');
      const client = await pool.connect(); try { await client.query('BEGIN READ WRITE'); await assert.rejects(client.query('INSERT INTO ' + table + ' SELECT * FROM ' + table + ' WHERE false'), error => error.code === '42501'); await client.query('ROLLBACK'); } finally { client.release(); }
    }
    resources.roleRestoration = 'Fixture SELECT-only role explicitly reconstructed after --no-acl; not a complete original-role/ACL restore claim';
  });
  await check('record actual tiny-fixture read latency and memory with workload denominators', async () => {
    const samples = []; for (let index = 0; index < 20; index++) { const at = performance.now(); await restored.cold.pool.query('SELECT source_sequence::text,native_hash FROM platform_history_snapshots ORDER BY source_sequence'); samples.push(performance.now() - at); }
    const sorted = [...samples].sort((a, b) => a - b); resources.workload = { samples: samples.length, concurrency: 1, snapshots: 3, query: 'Full source-sequence/hash scan on restored cold DB', unit: 'ms', p95NearestRankMs: sorted[Math.ceil(sorted.length * 0.95) - 1], samplesMs: samples,
      nodeMemory: process.memoryUsage(), limitations: 'Tiny synthetic hot/cold fixture; not application HTTP p95 or production sizing' };
  });
}
main().catch(error => { failure = { code: error.code || error.name, message: error.message }; console.error('FAIL ' + failure.message); process.exitCode = 1; }).finally(async () => {
  const files = ['infra/acceptance/compose.yaml', 'infra/acceptance/restore-rehearsal.cjs', 'infra/history/runtime-fixture.cjs', 'database/proposed/issue57-cold-history.sql'];
  const sourceHashes = Object.fromEntries(files.map(file => [file, sha(fs.readFileSync(path.join(root, file)))]));
  const report = { issue: 66, profile: 'COMPONENT_RESTORE_REHEARSAL', acceptanceStatus: 'PARTIAL', startedAt, finishedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), environment: { node: process.version, platform: process.platform, architecture: process.arch, cpuThreads: os.cpus().length, hostMemoryBytes: os.totalmem(), kernel: os.release() },
    checks, resources, times, sourceHashes, actualAiCalls: 0, limitations: ['Synthetic owning source/identity/evidence-reference ports, not production #43/#50 authority', 'No original object bytes, native Flowable/ImmuDB/trust backup or verification; complete AT-12 blocked on #65',
      'New empty target databases only; no production restore, volume deletion, live-worker quiescence or destructive rollback', 'Fresh source fixture plus forward schema initialization is not a legacy upgrade proof', 'No full AT-01..12 or release qualification claim'], ...(failure ? { failure } : {}) };
  const directory = path.join(root, 'docs/acceptance/evidence'); fs.mkdirSync(directory, { recursive: true }); const target = path.join(directory, 'issue66-restore-rehearsal-' + new Date().toISOString().replace(/\D/g, '') + '.json'); fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log('Retained ' + path.relative(root, target));
  if (f) await f.close(); await Promise.all(pools.map(pool => pool.end()));
});
