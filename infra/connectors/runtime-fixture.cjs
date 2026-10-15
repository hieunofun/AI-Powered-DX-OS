/* SPDX-License-Identifier: MIT */
'use strict';
// Only isolated acceptance: static server identities + actual SQL membership/resource/source grants.
require('reflect-metadata');
const path = require('node:path'), fs = require('node:fs'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { Module } = require('@nestjs/common'), { NestFactory } = require('@nestjs/core');
const root = path.resolve(__dirname, '../..'), load = name => require(path.join(root, 'apps/api/dist', name));
const { DatabaseService } = load('database/database.service.js'), { MinioStorageService } = load('storage/minio-storage.service.js');
const { EvidenceService } = load('platform/evidence/evidence.service.js'), { PostgresEvidenceStore } = load('platform/evidence/evidence.repository.js');
const { PrivateEvidenceStorage } = load('platform/evidence/evidence-storage.js'), { ClamavScanner } = load('platform/evidence/clamav.scanner.js');
const { EvidenceModule } = load('platform/evidence/evidence.module.js'), { EvidenceErrorFilter } = load('platform/evidence/evidence.controller.js');
const { PostgresLineageStore } = load('platform/lineage/lineage.repository.js'), { LineageService } = load('platform/lineage/lineage.service.js'), { LineageModule } = load('platform/lineage/lineage.module.js');
const { PostgresSourceRegistry } = load('packs/openresolve/connectors/source-registry.js'), { PostgresIngressStore } = load('packs/openresolve/connectors/ingress.repository.js');
const { ConnectorIngressService } = load('packs/openresolve/connectors/ingress.service.js'), { ConnectorIngressModule } = load('packs/openresolve/connectors/ingress.module.js');
const { PostgresConnectorCaseOutbox } = load('packs/openresolve/connectors/connector-case.target.js'), { ConnectorLineageWriter } = load('packs/openresolve/connectors/connector-lineage.writer.js');
const { fail } = load('platform/evidence/evidence.types.js'), { fingerprint } = load('platform/evidence/file-safety.js');
async function createFixture() {
  Object.assign(process.env, { POSTGRES_HOST: '127.0.0.1', POSTGRES_PORT: '15451', POSTGRES_DB: 'connector_issue51', POSTGRES_USER: 'connector_fixture', POSTGRES_PASSWORD: 'connector_fixture_local_only',
    MINIO_ENDPOINT: '127.0.0.1', MINIO_PORT: '19451', MINIO_USE_SSL: 'false', MINIO_BUCKET_INVOICES: 'connector-issue51', MINIO_ACCESS_KEY: 'connector_fixture', MINIO_SECRET_KEY: 'connector_fixture_local_only' });
  const db = new DatabaseService(); let app;
  try {
  assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, 'connector_issue51');
  // Idempotent DDL on this exact isolated database also refreshes candidate trigger definitions on retained fixture volumes.
  for (const file of ['issue41-evidence-intake.sql', 'issue46-evidence-lineage.sql', 'issue51-external-itot-ingress.sql']) await db.query(fs.readFileSync(path.join(root, 'database/proposed', file), 'utf8'));
  const tenant = randomUUID(), otherTenant = randomUUID(), sourceOrder = randomUUID(), sourceSensor = randomUUID(), foreignSource = randomUUID(), poId = randomUUID(), foreignPo = randomUUID();
  const contexts = { order: { tenantId: tenant, subject: 'fixture-order' }, sensor: { tenantId: tenant, subject: 'fixture-sensor' }, worker: { tenantId: tenant, subject: 'fixture-worker' },
    foreign: { tenantId: otherTenant, subject: 'fixture-worker' } };
  await db.query(`CREATE TABLE IF NOT EXISTS connector_fixture_memberships(tenant_id UUID NOT NULL,subject TEXT NOT NULL,kind TEXT NOT NULL,active BOOLEAN NOT NULL,PRIMARY KEY(tenant_id,subject));
    CREATE TABLE IF NOT EXISTS connector_fixture_processor_grants(tenant_id UUID NOT NULL,subject TEXT NOT NULL,source_id UUID NOT NULL,PRIMARY KEY(tenant_id,subject,source_id));
    CREATE TABLE IF NOT EXISTS connector_fixture_orders(tenant_id UUID NOT NULL,id UUID NOT NULL,supplier_ref TEXT NOT NULL,currency TEXT NOT NULL,PRIMARY KEY(tenant_id,id));
    CREATE TABLE IF NOT EXISTS connector_fixture_items(tenant_id UUID NOT NULL,po_id UUID NOT NULL,id UUID NOT NULL,external_item_id TEXT NOT NULL,sku TEXT NOT NULL,
      ordered_quantity NUMERIC(18,4) NOT NULL,unit_price NUMERIC(18,4) NOT NULL,tax_rate NUMERIC(7,4) NOT NULL,received_quantity NUMERIC(18,4) NOT NULL,
      PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,po_id) REFERENCES connector_fixture_orders(tenant_id,id));
    CREATE TABLE IF NOT EXISTS connector_fixture_mappings(tenant_id UUID NOT NULL,source_id UUID NOT NULL,external_order_id TEXT NOT NULL,po_id UUID NOT NULL,
      PRIMARY KEY(tenant_id,source_id,external_order_id),FOREIGN KEY(tenant_id,po_id) REFERENCES connector_fixture_orders(tenant_id,id))`);
  for (const [name, ctx] of Object.entries(contexts)) await db.query('INSERT INTO connector_fixture_memberships VALUES($1,$2,$3,true)', [ctx.tenantId, ctx.subject, ['order', 'sensor', 'foreign'].includes(name) ? 'SOURCE' : 'PROCESSOR']);
  for (const [id, ctx, kind] of [[sourceOrder, contexts.order, 'EXTERNAL_ORDER'], [sourceSensor, contexts.sensor, 'RECEIVING_SENSOR'], [foreignSource, contexts.foreign, 'EXTERNAL_ORDER']]) {
    await db.query('INSERT INTO openresolve_connector_sources VALUES($1,$2,$3,$4,true,true)', [ctx.tenantId, id, ctx.subject, kind]);
    await db.query('INSERT INTO connector_fixture_processor_grants VALUES($1,$2,$3)', [ctx.tenantId, contexts.worker.subject, id]);
  }
  for (const [id, tenantId] of [[poId, tenant], [foreignPo, otherTenant]]) await db.query('INSERT INTO connector_fixture_orders VALUES($1,$2,$3,$4)', [tenantId, id, 'FICTIONAL-SUPPLIER', 'VND']);
  await db.query('INSERT INTO connector_fixture_items VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [tenant, poId, randomUUID(), 'ERP-LINE-1', 'CE285A', '2.0000', '500000.0000', '0.1000', '0.0000']);
  for (const [source, tenantId, po, external] of [[sourceOrder, tenant, poId, 'ERP-DEMO-1'], [sourceSensor, tenant, poId, 'ERP-DEMO-1'], [foreignSource, otherTenant, foreignPo, 'FOREIGN-DEMO-1']]) await db.query('INSERT INTO connector_fixture_mappings VALUES($1,$2,$3,$4)', [tenantId, source, external, po]);
  const authority = { authorize: async (ctx, action, ref) => {
    const member = (await db.query('SELECT kind FROM connector_fixture_memberships WHERE tenant_id=$1 AND subject=$2 AND active', [ctx.tenantId, ctx.subject])).rows[0];
    if (!member) fail('FORBIDDEN', 403);
    if (action === 'context.read') return;
    if (!['connector.ingest', 'connector.read', 'connector.process', 'connector.map', 'evidence.register', 'evidence.upload', 'evidence.scan', 'evidence.read', 'evidence.download', 'operation.read', 'lineage.read', 'resource.read'].includes(action)) fail('FORBIDDEN', 403);
    if (action === 'connector.process' && !ref) {
      if (member.kind !== 'PROCESSOR' || !(await db.query('SELECT 1 FROM connector_fixture_processor_grants WHERE tenant_id=$1 AND subject=$2 LIMIT 1', [ctx.tenantId, ctx.subject])).rows.length) fail('FORBIDDEN', 403); return;
    }
    if (ref?.type === 'connector-source') {
      const source = (await db.query('SELECT principal,active FROM openresolve_connector_sources WHERE tenant_id=$1 AND id=$2', [ctx.tenantId, ref.id])).rows[0]; if (!source) fail('NOT_FOUND', 404);
      const granted = (await db.query('SELECT 1 FROM connector_fixture_processor_grants WHERE tenant_id=$1 AND subject=$2 AND source_id=$3', [ctx.tenantId, ctx.subject, ref.id])).rows.length;
      if (!source.active || action === 'connector.ingest' && (member.kind !== 'SOURCE' || source.principal !== ctx.subject) || action === 'connector.process' && (!granted || member.kind !== 'PROCESSOR') || action === 'connector.read' && source.principal !== ctx.subject && !granted) fail('FORBIDDEN', 403); return;
    }
    if (ref?.type === 'purchase-order') {
      const rows = await db.query(`SELECT 1 FROM connector_fixture_mappings m JOIN openresolve_connector_sources s ON s.tenant_id=m.tenant_id AND s.id=m.source_id
        LEFT JOIN connector_fixture_processor_grants g ON g.tenant_id=m.tenant_id AND g.source_id=m.source_id AND g.subject=$3
        WHERE m.tenant_id=$1 AND m.po_id=$2 AND s.active AND (s.principal=$3 OR g.subject IS NOT NULL) LIMIT 1`, [ctx.tenantId, ref.id, ctx.subject]);
      if (!rows.rows.length) fail('NOT_FOUND', 404); return;
    }
    if (!ref) { if (member.kind !== 'PROCESSOR' || !['evidence.register', 'evidence.scan', 'evidence.read'].includes(action)) fail('FORBIDDEN', 403); return; }
    let evidenceId = ref.id;
    if (ref.type !== 'evidence') {
      const linked = (await db.query(`SELECT evidence_id FROM platform_lineage_links WHERE tenant_id=$1 AND
        ((link->'from_ref'->>'id'=$2 AND link->'from_ref'->>'type'=$3 AND link->'from_ref'->>'pack_id'=$4)
        OR (link->'to_ref'->>'id'=$2 AND link->'to_ref'->>'type'=$3 AND link->'to_ref'->>'pack_id'=$4)) LIMIT 1`, [ctx.tenantId, ref.id, ref.type, ref.pack_id])).rows[0];
      if (!linked) fail('NOT_FOUND', 404); evidenceId = linked.evidence_id;
    }
    const raw = (await db.query('SELECT data FROM platform_evidence_records WHERE tenant_id=$1 AND id=$2', [ctx.tenantId, evidenceId])).rows[0]?.data;
    if (!raw) fail('NOT_FOUND', 404);
    const source = (await db.query('SELECT principal,active FROM openresolve_connector_sources WHERE tenant_id=$1 AND id=$2', [ctx.tenantId, raw.evidence.source.source_id])).rows[0];
    const grant = (await db.query('SELECT 1 FROM connector_fixture_processor_grants WHERE tenant_id=$1 AND subject=$2 AND source_id=$3', [ctx.tenantId, ctx.subject, raw.evidence.source.source_id])).rows.length;
    if (!source?.active || source.principal !== ctx.subject && !grant || raw.evidence.retention_class !== 'STANDARD' || ['evidence.upload', 'evidence.scan'].includes(action) && member.kind !== 'PROCESSOR') fail('FORBIDDEN', 403);
  } };
  const access = { check: (ctx, action, id, policy) => {
    if (policy?.retentionClass === 'RESTRICTED') fail('FORBIDDEN', 403);
    return authority.authorize(ctx, action, id ? { pack_id: 'platform', type: 'evidence', id } : undefined);
  } };
  const flags = { unavailableScanner: false, failAfterCaseInsert: false, failAfterLineage: false };
  const scanner = new ClamavScanner({ host: '127.0.0.1', port: 33151, timeoutMs: 30000, freshnessMs: 86400000, engine: '1.4.6' });
  const unavailable = new ClamavScanner({ host: '127.0.0.1', port: 33152, timeoutMs: 1000, freshnessMs: 86400000, engine: '1.4.6' });
  let ingress;
  const evidence = new EvidenceService(new PostgresEvidenceStore(db), new PrivateEvidenceStorage(new MinioStorageService()), { scan: bytes => (flags.unavailableScanner ? unavailable : scanner).scan(bytes) }, access,
    'connector-fixture-private-cursor-key-v1-at-least32bytes', Date.now, { read: (ctx, id) => ingress.operation(ctx, id) });
  const mapping = { snapshot: async (ctx, source, externalId, client) => {
    const query = client || db;
    const po = (await query.query(`SELECT p.id,p.supplier_ref,p.currency FROM connector_fixture_orders p JOIN connector_fixture_mappings m ON m.tenant_id=p.tenant_id AND m.po_id=p.id
      WHERE m.tenant_id=$1 AND m.source_id=$2 AND m.external_order_id=$3 FOR UPDATE OF p`, [ctx.tenantId, source.id, externalId])).rows[0];
    if (!po) fail('NOT_FOUND', 404); await authority.authorize(ctx, 'connector.map', { pack_id: 'openresolve', type: 'purchase-order', id: po.id });
    const items = (await query.query('SELECT id,external_item_id AS "externalItemId",sku,ordered_quantity::text AS "orderedQuantity",unit_price::text AS "unitPrice",tax_rate::text AS "taxRate",received_quantity::text AS "receivedQuantity" FROM connector_fixture_items WHERE tenant_id=$1 AND po_id=$2 ORDER BY id', [ctx.tenantId, po.id])).rows;
    return { tenantId: ctx.tenantId, purchaseOrderId: po.id, externalOrderId: externalId, supplierRef: po.supplier_ref, currency: po.currency, sourceVersion: fingerprint([po, items]), lines: items };
  } };
  const target = new PostgresConnectorCaseOutbox({ check: async (client, ctx, observation, request) => {
    for (const subject of [ctx.subject, observation.requestedBy]) if (!(await client.query('SELECT 1 FROM connector_fixture_memberships WHERE tenant_id=$1 AND subject=$2 AND active FOR SHARE', [ctx.tenantId, subject])).rows.length) fail('FORBIDDEN', 403);
    const source = (await client.query('SELECT principal,active FROM openresolve_connector_sources WHERE tenant_id=$1 AND id=$2 FOR SHARE', [ctx.tenantId, observation.sourceId])).rows[0];
    if (!source?.active || source.principal !== observation.requestedBy || !(await client.query('SELECT 1 FROM connector_fixture_processor_grants WHERE tenant_id=$1 AND subject=$2 AND source_id=$3 FOR SHARE', [ctx.tenantId, ctx.subject, observation.sourceId])).rows.length) fail('FORBIDDEN', 403);
    const current = await mapping.snapshot({ tenantId: ctx.tenantId, subject: observation.requestedBy }, { id: observation.sourceId }, observation.event.data.external_order_id, client);
    if (current.purchaseOrderId !== request.subject_ref.id || current.sourceVersion !== observation.outcome.sourceVersion) fail('REVISION_CONFLICT', 409);
    for (const id of request.evidence_ids) {
      const value = (await client.query('SELECT data FROM platform_evidence_records WHERE tenant_id=$1 AND id=$2 FOR SHARE', [ctx.tenantId, id])).rows[0]?.data;
      if (!value || value.evidence.quarantine_state !== 'CLEAN' || value.evidence.sha256 !== observation.evidenceSha256 || value.evidence.source.source_id !== observation.sourceId) fail('FILE_NOT_CLEAN', 409);
    }
  } });
  const lineageStore = new PostgresLineageStore(db), writer = new ConnectorLineageWriter(lineageStore), store = new PostgresIngressStore(db), registry = new PostgresSourceRegistry(db, authority);
  const createWorker = () => new ConnectorIngressService(store, registry, authority, evidence, mapping, { enqueue: async (...args) => {
    await target.enqueue(...args); if (flags.failAfterCaseInsert) { flags.failAfterCaseInsert = false; throw new Error('Injected failure after actual connector case-intent SQL'); }
  } }, { capture: async (...args) => { await writer.capture(...args); if (flags.failAfterLineage) { flags.failAfterLineage = false; throw new Error('Injected failure after actual connector lineage SQL'); } } });
  ingress = createWorker();
  const lineage = new LineageService(lineageStore, evidence, { check: (ctx, action, ref) => authority.authorize(ctx, action, ref) }, 'connector-fixture-encrypted-lineage-cursor-secret-v1');
  const resolver = { resolve: async request => {
    const name = request.header('Authorization')?.replace(/^Bearer fixture-/, ''), ctx = contexts[name]; if (!ctx) fail('UNAUTHENTICATED', 401);
    await authority.authorize(ctx, 'context.read'); return ctx;
  } };
  class FixtureModule {};
  Module({ imports: [EvidenceModule.register(evidence, resolver), ConnectorIngressModule.register(ingress, resolver), LineageModule.register(lineage, resolver)] })(FixtureModule);
  app = await NestFactory.create(FixtureModule, { logger: false, rawBody: true }); app.useGlobalFilters(new EvidenceErrorFilter()); await app.listen(0, '127.0.0.1');
  return { db, app, origin: await app.getUrl(), contexts, sources: { order: sourceOrder, sensor: sourceSensor, foreign: foreignSource }, poId, flags, scanner, ingress, store, evidence, createWorker,
    close: async () => { await app.close(); await db.onModuleDestroy(); } };
  } catch (error) { if (app) await app.close(); await db.onModuleDestroy(); throw error; }
}
module.exports = { createFixture };
