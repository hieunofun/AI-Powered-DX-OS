/* SPDX-License-Identifier: MIT */
'use strict';
// Actual separate PostgreSQL databases and SELECT-only role; explicit synthetic owning source/identity/ACL ports.
require('reflect-metadata');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto'), { Pool } = require('pg');
const { Module } = require('@nestjs/common'), { NestFactory } = require('@nestjs/core');
const root = path.resolve(__dirname, '../..'), load = file => require(path.join(root, 'apps/api/dist', file));
const { HistoryProjector } = load('platform/history/history-projector.js'), { HistoryQueryService } = load('platform/history/history-query.service.js');
const { PostgresColdHistoryStore } = load('platform/history/history.repository.js'), { HistoryModule } = load('platform/history/history.module.js');
const { EvidenceErrorFilter } = load('platform/evidence/evidence.controller.js'), { validateEntry } = load('platform/history/history-validation.js');
const { fingerprint } = load('platform/evidence/file-safety.js'), { fail } = load('platform/evidence/evidence.types.js');
const connection = { host: '127.0.0.1', port: 15457, user: 'history_fixture', password: 'history_fixture_local_only', connectionTimeoutMillis: 5000, max: 10 };
function database(pool) { return { query: (sql, args) => pool.query(sql, args), transaction: async work => {
  const client = await pool.connect(); try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
} }; }
async function createFixture() {
  const hotPool = new Pool({ ...connection, database: 'history_hot_issue57' }), hot = database(hotPool), pools = [hotPool]; let app;
  try {
    assert.equal((await hot.query('SELECT current_database() AS name')).rows[0].name, 'history_hot_issue57');
    if (!(await hot.query("SELECT 1 FROM pg_database WHERE datname='history_cold_issue57'")).rows.length) await hot.query('CREATE DATABASE history_cold_issue57 OWNER history_fixture');
    await hot.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='history_report_fixture') THEN CREATE ROLE history_report_fixture LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD 'history_report_fixture_local_only'; END IF; END $$");
    const coldPool = new Pool({ ...connection, database: 'history_cold_issue57' }), cold = database(coldPool); pools.push(coldPool);
    assert.equal((await cold.query('SELECT current_database() AS name')).rows[0].name, 'history_cold_issue57');
    await cold.query(fs.readFileSync(path.join(root, 'database/proposed/issue57-cold-history.sql'), 'utf8'));
    await hot.query(`CREATE TABLE IF NOT EXISTS history_fixture_members(tenant_id UUID NOT NULL,subject TEXT NOT NULL,role TEXT NOT NULL,active BOOLEAN NOT NULL,PRIMARY KEY(tenant_id,subject));
      CREATE TABLE IF NOT EXISTS history_fixture_streams(tenant_id UUID NOT NULL,name TEXT NOT NULL,epoch UUID NOT NULL,PRIMARY KEY(tenant_id,name));
      CREATE TABLE IF NOT EXISTS history_fixture_stream_grants(tenant_id UUID NOT NULL,stream TEXT NOT NULL,subject TEXT NOT NULL,PRIMARY KEY(tenant_id,stream,subject),FOREIGN KEY(tenant_id,stream) REFERENCES history_fixture_streams(tenant_id,name),FOREIGN KEY(tenant_id,subject) REFERENCES history_fixture_members(tenant_id,subject));
      CREATE TABLE IF NOT EXISTS history_fixture_cases(tenant_id UUID NOT NULL,id UUID NOT NULL,retention_class TEXT NOT NULL,retain_until TIMESTAMPTZ NOT NULL,legal_hold BOOLEAN NOT NULL,policy_version TEXT NOT NULL,PRIMARY KEY(tenant_id,id));
      CREATE TABLE IF NOT EXISTS history_fixture_case_grants(tenant_id UUID NOT NULL,case_id UUID NOT NULL,subject TEXT NOT NULL,can_read BOOLEAN NOT NULL,allow_restricted BOOLEAN NOT NULL,allow_expired BOOLEAN NOT NULL,PRIMARY KEY(tenant_id,case_id,subject),FOREIGN KEY(tenant_id,case_id) REFERENCES history_fixture_cases(tenant_id,id),FOREIGN KEY(tenant_id,subject) REFERENCES history_fixture_members(tenant_id,subject));
      CREATE TABLE IF NOT EXISTS history_fixture_events(sequence BIGSERIAL PRIMARY KEY,tenant_id UUID NOT NULL,stream TEXT NOT NULL,event_id UUID NOT NULL,data JSONB NOT NULL,UNIQUE(tenant_id,stream,event_id),FOREIGN KEY(tenant_id,stream) REFERENCES history_fixture_streams(tenant_id,name),CHECK(data->'event'->>'tenant_id'=tenant_id::text AND data->>'sequence'=sequence::text));
      CREATE OR REPLACE FUNCTION history_fixture_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Source events/epochs are append-only'; END $$;
      DROP TRIGGER IF EXISTS history_fixture_events_immutable ON history_fixture_events;
      CREATE TRIGGER history_fixture_events_immutable BEFORE UPDATE OR DELETE ON history_fixture_events FOR EACH ROW EXECUTE FUNCTION history_fixture_append_only();
      DROP TRIGGER IF EXISTS history_fixture_streams_immutable ON history_fixture_streams;
      CREATE TRIGGER history_fixture_streams_immutable BEFORE UPDATE OR DELETE ON history_fixture_streams FOR EACH ROW EXECUTE FUNCTION history_fixture_append_only();
      GRANT CONNECT ON DATABASE history_hot_issue57 TO history_report_fixture;
      GRANT USAGE ON SCHEMA public TO history_report_fixture;
      GRANT SELECT ON history_fixture_members,history_fixture_streams,history_fixture_stream_grants,history_fixture_cases,history_fixture_case_grants,history_fixture_events TO history_report_fixture`);
    await cold.query('GRANT CONNECT ON DATABASE history_cold_issue57 TO history_report_fixture; GRANT USAGE ON SCHEMA public TO history_report_fixture; GRANT SELECT ON platform_history_snapshots,platform_history_lineage TO history_report_fixture');
    const reportConfig = { ...connection, user: 'history_report_fixture', password: 'history_report_fixture_local_only' }, reportColdPool = new Pool({ ...reportConfig, database: 'history_cold_issue57' }), reportHotPool = new Pool({ ...reportConfig, database: 'history_hot_issue57' }); pools.push(reportColdPool, reportHotPool);
    const unavailablePool = new Pool({ ...reportConfig, port: 15458, database: 'history_hot_issue57', connectionTimeoutMillis: 1000, max: 1 }); pools.push(unavailablePool);
    const flags = { failBeforeColdCommit: false, authorityUnavailable: false };
    const reader = database(reportColdPool), authorityDb = database(reportHotPool), authorityRead = { query: (sql, args) => flags.authorityUnavailable ? unavailablePool.query(sql, args) : authorityDb.query(sql, args) };
    const tenant = randomUUID(), foreignTenant = randomUUID(), stream = 'case.history';
    const contexts = { worker: { tenantId: tenant, subject: 'fixture-archive' }, reader: { tenantId: tenant, subject: 'fixture-reader' }, auditor: { tenantId: tenant, subject: 'fixture-auditor' },
      foreign: { tenantId: foreignTenant, subject: 'fixture-reader' }, foreignWorker: { tenantId: foreignTenant, subject: 'fixture-archive' } };
    for (const tenantId of [tenant, foreignTenant]) await hot.query('INSERT INTO history_fixture_streams VALUES($1,$2,$3)', [tenantId, stream, randomUUID()]);
    for (const [alias, ctx] of Object.entries(contexts)) {
      await hot.query('INSERT INTO history_fixture_members VALUES($1,$2,$3,true)', [ctx.tenantId, ctx.subject, alias === 'worker' || alias === 'foreignWorker' ? 'ARCHIVE' : alias === 'auditor' ? 'AUDITOR' : 'READER']);
      await hot.query('INSERT INTO history_fixture_stream_grants VALUES($1,$2,$3)', [ctx.tenantId, stream, ctx.subject]);
    }
    async function membership(query, ctx, requested, lock = false) {
      const row = (await query.query('SELECT role FROM history_fixture_members WHERE tenant_id=$1 AND subject=$2 AND active' + (lock ? ' FOR SHARE' : ''), [ctx.tenantId, ctx.subject])).rows[0];
      if (!row) fail('FORBIDDEN', 403);
      if (!(await query.query('SELECT 1 FROM history_fixture_stream_grants WHERE tenant_id=$1 AND stream=$2 AND subject=$3' + (lock ? ' FOR SHARE' : ''), [ctx.tenantId, requested, ctx.subject])).rows.length) fail('NOT_FOUND', 404);
      return row;
    }
    const access = { check: async (ctx, action, requested) => {
      const row = await membership(authorityRead, ctx, requested);
      if (!['history.project', 'history.read', 'history.report'].includes(action) || action === 'history.project' && row.role !== 'ARCHIVE') fail('FORBIDDEN', 403);
    }, inspect: async (ctx, requested, entry) => {
      const m = await membership(authorityRead, ctx, requested);
      const row = (await authorityRead.query(`SELECT c.*,g.can_read,g.allow_restricted,g.allow_expired FROM history_fixture_cases c LEFT JOIN history_fixture_case_grants g ON g.tenant_id=c.tenant_id AND g.case_id=c.id AND g.subject=$3 WHERE c.tenant_id=$1 AND c.id=$2`, [ctx.tenantId, entry.case_metric.ref.id, ctx.subject])).rows[0];
      if (!row) fail('NOT_FOUND', 404);
      return { allowed: row.can_read === true && (row.retention_class !== 'RESTRICTED' || row.allow_restricted === true), allowExpired: m.role === 'AUDITOR' && row.allow_expired === true,
        currentRetention: { retention_class: row.retention_class, retain_until: row.retain_until.toISOString(), legal_hold: row.legal_hold, policy_version: row.policy_version } };
    } };
    const lockStream = (client, ctx) => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [fingerprint(['history-source', ctx.tenantId, stream])]);
    const source = { databaseName: async () => (await hot.query('SELECT current_database() AS name')).rows[0].name,
      watermark: async (ctx, requested) => hot.transaction(async client => {
        if ((await membership(client, ctx, requested, true)).role !== 'ARCHIVE') fail('FORBIDDEN', 403); await lockStream(client, ctx);
        return { epoch: (await client.query('SELECT epoch FROM history_fixture_streams WHERE tenant_id=$1 AND name=$2', [ctx.tenantId, requested])).rows[0].epoch,
          through: (await client.query('SELECT COALESCE(MAX(sequence),0)::text AS value FROM history_fixture_events WHERE tenant_id=$1 AND stream=$2', [ctx.tenantId, requested])).rows[0].value };
      }), withCommittedPage: async (ctx, requested, epoch, after, through, limit, use) => hot.transaction(async client => {
        if ((await membership(client, ctx, requested, true)).role !== 'ARCHIVE') fail('FORBIDDEN', 403);
        const actual = (await client.query('SELECT epoch FROM history_fixture_streams WHERE tenant_id=$1 AND name=$2 FOR SHARE', [ctx.tenantId, requested])).rows[0]?.epoch; if (actual !== epoch) fail('REVISION_CONFLICT', 409);
        const rows = (await client.query('SELECT data FROM history_fixture_events WHERE tenant_id=$1 AND stream=$2 AND sequence>$3::bigint AND sequence<=$4::bigint ORDER BY sequence LIMIT $5 FOR SHARE', [ctx.tenantId, requested, after, through, limit + 1])).rows.map(row => row.data);
        const selected = rows.slice(0, limit); return use({ epoch, through, scannedThrough: rows.length > limit ? selected[selected.length - 1].sequence : through, entries: selected });
      }) };
    const baseStore = new PostgresColdHistoryStore(cold, reader);
    const store = Object.create(baseStore); store.apply = (ctx, checkpoint, after, page, guard) => baseStore.apply(ctx, checkpoint, after, page, async client => {
      await guard(client); const persisted = flags.failBeforeColdCommit ? (await client.query('SELECT data FROM platform_history_projection_jobs WHERE tenant_id=$1 AND stream=$2 AND job_id=$3', [ctx.tenantId, checkpoint.stream, checkpoint.jobId])).rows[0]?.data : undefined;
      if (flags.failBeforeColdCommit && page.scannedThrough !== after && persisted?.after === page.scannedThrough) {
        flags.failBeforeColdCommit = false; throw new Error('Injected exception after actual cold rows/checkpoint SQL');
      }
    });
    const createProjector = () => new HistoryProjector(store, source, access), projector = createProjector(), queryService = new HistoryQueryService(baseStore, access, 'history-fixture-encrypted-private-cursor-key-v1-at-least32bytes');
    const resolver = { resolve: async req => { const alias = req.header('Authorization')?.replace(/^Bearer fixture-/, ''), ctx = contexts[alias]; if (!ctx) fail('UNAUTHENTICATED', 401); await membership(authorityDb, ctx, stream); return ctx; } };
    class FixtureModule {};
    Module({ imports: [HistoryModule.register(queryService, resolver)] })(FixtureModule);
    app = await NestFactory.create(FixtureModule, { logger: false }); app.useGlobalFilters(new EvidenceErrorFilter()); await app.listen(0, '127.0.0.1');
    async function append(ctx, template) {
      return hot.transaction(async client => {
        await lockStream(client, ctx); const entry = structuredClone(template); entry.sequence = (await client.query("SELECT nextval(pg_get_serial_sequence('history_fixture_events','sequence'))::text AS value")).rows[0].value; validateEntry(ctx, entry);
        await client.query('INSERT INTO history_fixture_events(sequence,tenant_id,stream,event_id,data) VALUES($1,$2,$3,$4,$5::jsonb)', [entry.sequence, ctx.tenantId, stream, entry.event.id, JSON.stringify(entry)]);
        const r = entry.retention; await client.query('INSERT INTO history_fixture_cases VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [ctx.tenantId, entry.case_metric.ref.id, r.retention_class, r.retain_until, r.legal_hold, r.policy_version]);
        for (const [alias, person] of Object.entries(contexts)) if (person.tenantId === ctx.tenantId) await client.query('INSERT INTO history_fixture_case_grants VALUES($1,$2,$3,true,$4,$4) ON CONFLICT DO NOTHING', [ctx.tenantId, entry.case_metric.ref.id, person.subject, alias === 'auditor']);
        return entry;
      });
    }
    return { hot, cold, reader, authorityDb, reportColdPool, reportHotPool, contexts, stream, flags, store: baseStore, projector, createProjector, queryService, source, access, append,
      app, origin: await app.getUrl(), close: async () => { await app.close(); await Promise.all(pools.map(pool => pool.end())); } };
  } catch (error) { if (app) await app.close(); await Promise.all(pools.map(pool => pool.end())); throw error; }
}
module.exports = { createFixture };
