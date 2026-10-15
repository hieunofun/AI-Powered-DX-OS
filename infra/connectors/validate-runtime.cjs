/* SPDX-License-Identifier: MIT */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { createFixture } = require('./runtime-fixture.cjs'), { sendOrder } = require('./simulate-external-orders.cjs'), { sendReading } = require('./simulate-receiving-sensors.cjs');
const root = path.resolve(__dirname, '../..'), started = new Date().toISOString(), checks = [], resources = {}, timings = [];
const Ajv = require('ajv'), ajv = new Ajv({ allErrors: true });
const platform = require(path.join(root, 'packages/contracts/opendx/v1/schemas/platform.schema.json'));
const domain = require(path.join(root, 'packages/contracts/opendx/v1/schemas/openresolve.schema.json')); ajv.addSchema(platform); ajv.addSchema(domain);
const proposed = require(path.join(root, 'packages/contracts/opendx/proposed/issue51-connectors.schema.json')); ajv.addSchema(proposed);
let fixture;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceHashes = {};
for (const folder of ['packs/openresolve/connectors', 'platform/evidence', 'platform/lineage']) for (const file of fs.readdirSync(path.join(root, 'apps/api/src', folder)).filter(file => file.endsWith('.ts') && !file.endsWith('.spec.ts')).sort())
  sourceHashes['apps/api/src/' + folder + '/' + file] = sha(fs.readFileSync(path.join(root, 'apps/api/src', folder, file)));
const supportHashes = Object.fromEntries(['database/proposed/issue41-evidence-intake.sql', 'database/proposed/issue46-evidence-lineage.sql', 'database/proposed/issue51-external-itot-ingress.sql',
  'infra/connectors/runtime-fixture.cjs', 'infra/connectors/validate-runtime.cjs', 'infra/connectors/simulator-client.cjs', 'infra/connectors/simulate-external-orders.cjs', 'infra/connectors/simulate-receiving-sensors.cjs',
  'packages/contracts/opendx/proposed/issue51-connectors.schema.json'].map(file => [file, sha(fs.readFileSync(path.join(root, file)))]));
function shape(name, value, schema = platform) { assert.equal(ajv.getSchema(schema.$id + '#/definitions/' + name)(value), true, 'Contract mismatch: ' + name); }
async function check(name, work) { try { await work(); checks.push({ name, status: 'PASS' }); console.log('PASS ' + name); }
  catch (error) { checks.push({ name, status: 'FAIL', code: error.code || error.name }); throw error; } }
const native = value => Buffer.from(JSON.stringify(value));
const order = (id = randomUUID()) => ({ source_event_id: id, schema_id: 'openresolve.external-order.v1', observed_at: new Date().toISOString(),
  data: { external_order_id: 'ERP-DEMO-1', source_revision: 1, supplier_ref: 'FICTIONAL-SUPPLIER', currency: 'VND',
    lines: [{ external_item_id: 'ERP-LINE-1', sku: 'CE285A', description: 'SIMULATED cartridge order', ordered_quantity: '2', unit_price: '500000', tax_rate: '0.1' }] } });
const reading = (sequence = 1, quantity = '1') => ({ source_event_id: randomUUID(), schema_id: 'openresolve.receiving-sensor.v1', observed_at: new Date().toISOString(),
  data: { external_order_id: 'ERP-DEMO-1', external_item_id: 'ERP-LINE-1', device_id: 'SIMULATED-counter-1', sequence, received_quantity: quantity, quality: 'ACCEPTED', is_final: true } });
const route = (family, source) => '/apps/openresolve/v1/connectors/' + family + '/' + source + '/events';
async function http(method, route, bytes, status = 200, identity = 'worker', headers = {}) {
  const response = await fetch(fixture.origin + route, { method, headers: { Authorization: 'Bearer fixture-' + identity, 'X-Correlation-ID': randomUUID(),
    ...(bytes ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}), ...headers }, ...(bytes ? { body: bytes } : {}), signal: AbortSignal.timeout(45000) });
  assert.equal(response.status, status, method + ' ' + route);
  if (response.headers.get('Content-Type')?.startsWith('application/octet-stream')) return Buffer.from(await response.arrayBuffer());
  const value = await response.json();
  if (status >= 400) shape('Error', value); else if (status === 202 || route.includes('/operations/')) shape('Operation', value); else if (route.includes('/lineage')) shape('EvidenceLineage', value);
  else if (route.includes('/observations/')) shape('Observation', value, proposed);
  return value;
}
const detail = id => http('GET', '/apps/openresolve/v1/connectors/observations/' + id);
async function processOne(expectedId, worker = fixture.ingress) {
  const begin = performance.now(); const operation = await worker.processNext(fixture.contexts.worker); timings.push(Math.round(performance.now() - begin));
  assert.equal(operation?.resource_ref.id, expectedId, 'Worker processed unexpected fixture queue entry'); return detail(expectedId);
}
const count = async table => Number((await fixture.db.query('SELECT COUNT(*) FROM ' + table + ' WHERE tenant_id=$1', [fixture.contexts.worker.tenantId])).rows[0].count);
async function makeDue(id) {
  const record = await fixture.store.read(fixture.contexts.worker, id); if (!record.nextAttemptAt) return;
  const wait = Math.max(0, Date.parse(record.nextAttemptAt) - Date.now()) + 20; if (wait > 10000) throw new Error('Unexpected fixture backoff');
  await new Promise(resolve => setTimeout(resolve, wait));
}
async function main() {
  if (process.argv.includes('--wait-ready')) {
    const { Client } = require('pg'), end = Date.now() + 120000;
    for (;;) {
      const client = new Client({ host: '127.0.0.1', port: 15451, database: 'connector_issue51', user: 'connector_fixture', password: 'connector_fixture_local_only', connectionTimeoutMillis: 1000 });
      try {
        await client.connect(); const value = await client.query('SELECT current_database() AS name');
        assert.equal(value.rows[0].name, 'connector_issue51'); break;
      } catch { if (Date.now() >= end) throw new Error('Isolated connector database readiness timed out'); console.log('WAIT isolated connector database readiness'); }
      finally { await client.end().catch(() => undefined); }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  fixture = await createFixture();
  await check('actual exact-engine/fresh-definition complete ClamAV stream readiness', async () => {
    const end = Date.now() + (process.argv.includes('--wait-ready') ? 300000 : 30000);
    let verdict;
    do {
      verdict = await fixture.scanner.scan(Buffer.from('Fictional connector readiness'));
      if (verdict.state === 'CLEAN') return;
      if (Date.now() < end) { console.log('WAIT actual scanner readiness: ' + (verdict.reason || verdict.state)); await new Promise(resolve => setTimeout(resolve, 5000)); }
    } while (Date.now() < end);
    assert.equal(verdict.state, 'CLEAN', 'Scanner never reached the exact engine/freshness/complete-stream gate');
  });
  const inputOrder = order(), rawOrder = native(inputOrder), correlation = randomUUID(), orderKey = randomUUID();
  let orderOp;
  await check('independent order-system HTTP simulator durably stores native raw bytes before 202', async () => {
    const sent = await sendOrder({ baseUrl: fixture.origin, sourceId: fixture.sources.order, token: 'fixture-order', bytes: rawOrder, idempotencyKey: orderKey, correlationId: correlation });
    orderOp = sent.operation; shape('Operation', orderOp); resources.orderObservationId = orderOp.resource_ref.id;
    assert.equal(orderOp.state, 'PENDING'); assert.equal(await count('openresolve_connector_case_outbox'), 0);
    const record = await fixture.store.read(fixture.contexts.worker, resources.orderObservationId);
    assert.equal(record.simulated, true); assert.equal(record.correlationId, correlation); assert.deepEqual(await fixture.store.bytes(fixture.contexts.worker, record), rawOrder);
  });
  await check('same command and reencoded canonical event retain original acknowledgement and every raw receipt', async () => {
    const first = await http('POST', route('external-orders', fixture.sources.order), rawOrder, 202, 'order', { 'Idempotency-Key': orderKey }); assert.deepEqual(first, orderOp);
    const encoded = Buffer.from(JSON.stringify(inputOrder, null, 2)), duplicate = await http('POST', route('external-orders', fixture.sources.order), encoded, 202, 'order'); assert.deepEqual(duplicate, orderOp);
    assert.equal(await count('openresolve_source_observations'), 1); assert.equal(await count('openresolve_source_receipts'), 2);
    const receipt = (await fixture.db.query('SELECT raw_bytes FROM openresolve_source_receipts WHERE tenant_id=$1 AND raw_hash=$2', [fixture.contexts.worker.tenantId, sha(encoded)])).rows[0]; assert.deepEqual(receipt.raw_bytes, encoded);
  });
  await check('order witness is actually scanned and authorized lineage freezes native/master hashes', async () => {
    const current = await processOne(resources.orderObservationId); assert.equal(current.operation.state, 'SUCCEEDED'); assert.equal(current.outcome.case_dispatch, 'NONE');
    const graph = await http('GET', '/platform/v1/evidence/' + current.evidence_id + '/lineage'); assert.equal(graph.links.length, 2);
    const witness = await http('GET', '/platform/v1/evidence/' + current.evidence_id + '/content');
    const payload = />([^<]+)<\/source_event>/.exec(witness.toString())[1]; assert.deepEqual(Buffer.from(payload, 'base64'), rawOrder); resources.orderEvidenceId = current.evidence_id;
    const replay = await http('POST', route('external-orders', fixture.sources.order), rawOrder, 202, 'order', { 'Idempotency-Key': orderKey }); assert.deepEqual(replay, orderOp);
  });
  let sensorOp;
  await check('independent receiving/counter HTTP simulator creates a durable observation without inventory writes', async () => {
    const sent = await sendReading({ baseUrl: fixture.origin, sourceId: fixture.sources.sensor, token: 'fixture-sensor', bytes: native(reading()) });
    sensorOp = sent.operation; shape('Operation', sensorOp); resources.sensorObservationId = sensorOp.resource_ref.id;
    assert.equal((await fixture.db.query('SELECT received_quantity::text AS quantity FROM connector_fixture_items WHERE tenant_id=$1 AND po_id=$2', [fixture.contexts.worker.tenantId, fixture.poId])).rows[0].quantity, '0.0000');
  });
  await check('short cumulative count produces an authorized shared CaseRequest and EventEnvelope, only PENDING intent', async () => {
    const current = await processOne(resources.sensorObservationId); assert.equal(current.operation.state, 'SUCCEEDED'); assert.equal(current.outcome.reason, 'SHORT_DELIVERY');
    const row = (await fixture.db.query('SELECT case_request,event_envelope,state FROM openresolve_connector_case_outbox WHERE tenant_id=$1 AND observation_id=$2', [fixture.contexts.worker.tenantId, resources.sensorObservationId])).rows[0];
    shape('CaseRequest', row.case_request, domain); shape('EventEnvelope', row.event_envelope); assert.equal(row.state, 'PENDING');
    assert.deepEqual(row.case_request.evidence_ids, [current.evidence_id]); assert.equal(await count('openresolve_connector_case_outbox'), 1);
    resources.pendingCaseRequest = row.case_request;
  });
  await check('different payload under the same source event ID preserves both originals and proposes SOURCE_CONFLICT', async () => {
    const changed = structuredClone(inputOrder); changed.data.lines[0].unit_price = '500001';
    const operation = await http('POST', route('external-orders', fixture.sources.order), native(changed), 202, 'order'); resources.conflictObservationId = operation.resource_ref.id;
    const conflict = await processOne(resources.conflictObservationId); assert.equal(conflict.original_observation_id, resources.orderObservationId); assert.equal(conflict.outcome.reason, 'SOURCE_CONFLICT');
    assert.deepEqual(await fixture.store.bytes(fixture.contexts.worker, await fixture.store.read(fixture.contexts.worker, resources.orderObservationId)), rawOrder);
  });
  await check('new cumulative count is not added twice; prior inventory/PO facts remain unchanged', async () => {
    const operation = await http('POST', route('receiving-sensors', fixture.sources.sensor), native(reading(2, '2')), 202, 'sensor');
    const current = await processOne(operation.resource_ref.id); assert.equal(current.outcome.case_dispatch, 'NONE'); assert.equal(await count('openresolve_connector_case_outbox'), 2);
    assert.equal((await fixture.db.query('SELECT received_quantity::text AS quantity FROM connector_fixture_items WHERE tenant_id=$1 AND po_id=$2', [fixture.contexts.worker.tenantId, fixture.poId])).rows[0].quantity, '0.0000');
  });
  await check('wrong source principal, source family, client tenant and malformed source payload cannot bypass admission', async () => {
    await http('POST', route('external-orders', fixture.sources.order), rawOrder, 403, 'sensor');
    await http('POST', route('receiving-sensors', fixture.sources.order), native(reading()), 404, 'order');
    await http('POST', route('external-orders', fixture.sources.order), native({ ...order(), tenant_id: fixture.contexts.foreign.tenantId }), 400, 'order');
    await http('POST', route('external-orders', fixture.sources.order), Buffer.from('{broken'), 400, 'order');
    await http('POST', route('external-orders', fixture.sources.order), Buffer.from(JSON.stringify(order()) + ' '.repeat(65537)), 413, 'order');
  });
  await check('a valid foreign tenant source can enqueue its own event, but cannot read our source/operations/witness/lineage', async () => {
    const value = order(); value.data.external_order_id = 'FOREIGN-DEMO-1';
    const own = await http('POST', route('external-orders', fixture.sources.foreign), native(value), 202, 'foreign');
    assert.equal(own.tenant_id, fixture.contexts.foreign.tenantId);
    for (const url of ['/apps/openresolve/v1/connectors/observations/' + resources.orderObservationId, '/platform/v1/operations/' + orderOp.id,
      '/platform/v1/evidence/' + resources.orderEvidenceId + '/content', '/platform/v1/evidence/' + resources.orderEvidenceId + '/lineage']) await http('GET', url, undefined, 404, 'foreign');
    await http('POST', route('external-orders', fixture.sources.order), rawOrder, 404, 'foreign');
  });
  await check('actual case-intent/lineage SQL rollback after an injected finalization error, recreated worker retries without duplicates', async () => {
    const packet = reading(3, '2'); packet.data.quality = 'DAMAGED'; const before = await count('openresolve_connector_case_outbox');
    const operation = await http('POST', route('receiving-sensors', fixture.sources.sensor), native(packet), 202, 'sensor');
    fixture.flags.failAfterLineage = true; const pending = await processOne(operation.resource_ref.id); assert.equal(pending.operation.state, 'PENDING'); assert.equal(pending.outcome, undefined);
    assert.equal(await count('openresolve_connector_case_outbox'), before);
    assert.equal((await fixture.db.query('SELECT COUNT(*) FROM platform_lineage_links WHERE tenant_id=$1 AND evidence_id=$2', [fixture.contexts.worker.tenantId, pending.evidence_id])).rows[0].count, '0');
    await makeDue(operation.resource_ref.id); const recovered = await processOne(operation.resource_ref.id, fixture.createWorker());
    assert.equal(recovered.operation.state, 'SUCCEEDED'); assert.equal(recovered.evidence_id, pending.evidence_id); assert.equal(await count('openresolve_connector_case_outbox'), before + 1);
    assert.equal((await fixture.store.read(fixture.contexts.worker, operation.resource_ref.id)).failures.length, 1);
  });
  await check('native receipts, original payload metadata and anchors cannot be overwritten/deleted', async () => {
    const tenant = fixture.contexts.worker.tenantId;
    await assert.rejects(fixture.db.query('DELETE FROM openresolve_source_receipts WHERE tenant_id=$1', [tenant]), /append-only/);
    await assert.rejects(fixture.db.query('UPDATE openresolve_source_event_anchors SET observation_id=observation_id WHERE tenant_id=$1', [tenant]), /append-only/);
    await assert.rejects(fixture.db.query("UPDATE openresolve_source_observations SET data=jsonb_set(data,'{event,source_event_id}','\"rewritten\"') WHERE tenant_id=$1", [tenant]), /immutable/);
  });
  for (const [file, expected] of Object.entries(sourceHashes)) assert.equal(sha(fs.readFileSync(path.join(root, file))), expected, 'Implementation changed during runtime: ' + file);
  for (const [file, expected] of Object.entries(supportHashes)) assert.equal(sha(fs.readFileSync(path.join(root, file))), expected, 'Support file changed during runtime: ' + file);
}
main().catch(error => { console.error('FAIL connector runtime: ' + (error.code || error.name) + ' ' + String(error.message).slice(0, 300)); process.exitCode = 1; }).finally(async () => {
  let retainedState;
  if (fixture) {
    try {
      const tenants = [fixture.contexts.worker.tenantId, fixture.contexts.foreign.tenantId];
      retainedState = {
        receipts: (await fixture.db.query("SELECT tenant_id,source_id,source_event_id,raw_hash,observation_id,received_at,encode(raw_bytes,'base64') AS raw_base64 FROM openresolve_source_receipts WHERE tenant_id=ANY($1::uuid[]) ORDER BY received_at", [tenants])).rows,
        observations: (await fixture.db.query('SELECT data FROM openresolve_source_observations WHERE tenant_id=ANY($1::uuid[]) ORDER BY received_at,id', [tenants])).rows.map(row => row.data),
        evidence: (await fixture.db.query('SELECT data FROM platform_evidence_records WHERE tenant_id=ANY($1::uuid[]) ORDER BY created_at,id', [tenants])).rows.map(row => row.data),
        intents: (await fixture.db.query('SELECT observation_id,request_hash,case_request,event_envelope,state FROM openresolve_connector_case_outbox WHERE tenant_id=ANY($1::uuid[])', [tenants])).rows,
        lineage: (await fixture.db.query('SELECT link FROM platform_lineage_links WHERE tenant_id=ANY($1::uuid[]) ORDER BY platform_lineage_links.sequence', [tenants])).rows.map(row => row.link),
      };
      for (const receipt of retainedState.receipts) assert.equal(sha(Buffer.from(receipt.raw_base64, 'base64')), receipt.raw_hash, 'Retained receipt export hash mismatch');
    } catch (error) { checks.push({ name: 'retain exact isolated fixture evidence', status: 'FAIL', code: error.code || error.name }); process.exitCode = 1; }
    finally { await fixture.close(); }
  }
  const report = { started, completed: new Date().toISOString(), gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    worktreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()), sourceHashes, supportHashes,
    environment: { node: process.version, platform: process.platform, services: 'actual isolated PostgreSQL/MinIO/ClamAV and two independent loopback HTTP simulator clients',
      identity: 'static server identity resolver; real SQL memberships/processor/source/PO grants, not production SSO',
      caseIntegration: 'actual transactional PENDING case-intent outbox; owning #53 Case processor absent', fault: 'injected exception after real SQL lineage writes, not process-kill recovery' },
    checks, resources, retainedState, workerDurationsMs: timings,
    limitations: ['Explicitly simulated external order and cumulative receiving counter; no production ERP/PLC/digital twin', 'No PO/GRN/payment mutations or autonomous approvals',
      'No completed Case/Decision/Export or production #43 integration is asserted', 'No process-kill/restore or production latency claim'] };
  const directory = path.join(root, 'docs/ai/evidence'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'issue51-ingress-runtime-' + started.replaceAll(/[^0-9]/g, '') + '.json'), JSON.stringify(report, null, 2) + '\n');
});
