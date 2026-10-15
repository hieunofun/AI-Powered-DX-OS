/* SPDX-License-Identifier: MIT */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { createHash, randomUUID } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { createFixture } = require('./runtime-fixture.cjs');
const root = path.resolve(__dirname, '../..'), started = new Date().toISOString(), checks = [], resources = {}, timings = [], sha = bytes => createHash('sha256').update(bytes).digest('hex');
const Ajv = require('ajv'), ajv = new Ajv({ allErrors: true }), platform = require(path.join(root, 'packages/contracts/opendx/v1/schemas/platform.schema.json')),
  proposed = require(path.join(root, 'packages/contracts/opendx/proposed/issue54-mediation.schema.json')); ajv.addSchema(platform); ajv.addSchema(proposed);
const { fingerprint } = require(path.join(root, 'apps/api/dist/platform/evidence/file-safety.js'));
const sourceHashes = {}, supportHashes = {};
for (const folder of ['packs/openresolve/mediation', 'platform/evidence']) for (const file of fs.readdirSync(path.join(root, 'apps/api/src', folder)).filter(name => name.endsWith('.ts') && !name.endsWith('.spec.ts'))) {
  const name = 'apps/api/src/' + folder + '/' + file; sourceHashes[name] = sha(fs.readFileSync(path.join(root, name)));
}
for (const name of ['infra/mediation/runtime-fixture.cjs', 'infra/mediation/validate-runtime.cjs', 'database/proposed/issue41-evidence-intake.sql', 'database/proposed/issue54-ai-mediation.sql', 'packages/contracts/opendx/proposed/issue54-mediation.schema.json']) supportHashes[name] = sha(fs.readFileSync(path.join(root, name)));
let f, prepared;
function shape(name, value, schema = proposed) { const validate = ajv.getSchema(schema.$id + '#/definitions/' + name); assert.equal(validate(value), true, 'DTO mismatch: ' + name + ' ' + JSON.stringify(validate.errors)); }
async function check(name, work) { try { await work(); checks.push({ name, status: 'PASS' }); console.log('PASS ' + name); }
  catch (error) { checks.push({ name, status: 'FAIL', code: error.code || error.name }); throw error; } }
const prefix = '/apps/openresolve/v1/ai';
async function http(method, route, body, expected = 200, actor = 'requester', key = randomUUID()) {
  const response = await fetch(f.origin + route, { method, headers: { Authorization: 'Bearer fixture-' + actor, 'X-Correlation-ID': randomUUID(),
    ...(method === 'POST' ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45000) });
  assert.equal(response.status, expected, method + ' ' + route); const value = await response.json();
  if (expected >= 400) shape('Error', value, platform); else if (expected === 202 || route.includes('/operations/')) shape('Operation', value, platform);
  else if (route.includes('/proposals')) shape('Proposal', value); else if (route.includes('/explanations/')) shape('Explanation', value);
  return value;
}
const post = (route, body, expected, actor, key) => http('POST', prefix + route, body, expected, actor, key), get = (route, actor = 'requester', expected = 200) => http('GET', route, undefined, expected, actor);
const enqueue = () => post('/cases/' + f.caseId + '/explanations', { question: 'What confirmed evidence is available and missing?' }, 202);
async function processOne(id, worker = f.service) {
  const begin = performance.now(), operation = await worker.processNext(f.contexts.worker); timings.push(Math.round(performance.now() - begin));
  assert.equal(operation?.resource_ref.id, id); return get(prefix + '/explanations/' + id);
}
async function proposal(explanationId, tool = 'case.request_evidence') {
  return post('/explanations/' + explanationId + '/proposals', tool === 'case.request_evidence' ? { tool, missing_evidence_codes: ['RECEIPT'] } : { tool, fact_ids: [prepared.factId] }, 201);
}
async function approved(explanationId, tool) {
  const value = await proposal(explanationId, tool), ref = await f.decision(value.id); await post('/proposals/' + value.id + '/approval', { decision_ref: ref }, 200, 'approver'); return { value, ref };
}
const effects = async id => Number((await f.db.query('SELECT COUNT(*) FROM mediation_fixture_actions WHERE tenant_id=$1 AND ($2::uuid IS NULL OR proposal_id=$2)', [f.contexts.requester.tenantId, id || null])).rows[0].count);
async function membership(subject, active) { await f.db.query('UPDATE mediation_fixture_members SET active=$3 WHERE tenant_id=$1 AND subject=$2', [f.contexts.requester.tenantId, subject, active]); }
async function main() {
  if (process.argv.includes('--wait-ready')) {
    const { Client } = require('pg'), end = Date.now() + 120000;
    for (;;) { const client = new Client({ host: '127.0.0.1', port: 15454, database: 'mediation_issue54', user: 'mediation_fixture', password: 'mediation_fixture_local_only', connectionTimeoutMillis: 1000 });
      try { await client.connect(); assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, 'mediation_issue54'); break; }
      catch { if (Date.now() >= end) throw new Error('Isolated mediation database readiness timed out'); console.log('WAIT isolated database'); }
      finally { await client.end().catch(() => undefined); } await new Promise(resolve => setTimeout(resolve, 3000)); }
  }
  f = await createFixture();
  await check('actual exact-engine fresh-definition complete-stream scanner readiness', async () => {
    const end = Date.now() + (process.argv.includes('--wait-ready') ? 300000 : 30000); let verdict;
    do { verdict = await f.scanner.scan(Buffer.from('Explicit fictional mediation readiness')); if (verdict.state === 'CLEAN') return;
      console.log('WAIT actual scanner: ' + (verdict.reason || verdict.state)); await new Promise(resolve => setTimeout(resolve, 5000)); } while (Date.now() < end);
    assert.equal(verdict.state, 'CLEAN');
  });
  await check('actual private evidence bytes are scanned before labelled reviewed case facts, unscanned source stays quarantined', async () => {
    prepared = await f.prepareEvidence(); Object.assign(resources, prepared);
    assert.equal((await f.evidence.detail(f.contexts.worker, prepared.unscannedId)).quarantine_state, 'PENDING_SCAN');
    await get('/platform/v1/evidence/' + prepared.unscannedId + '/content', 'requester', 409);
  });
  let operation;
  await check('durable native request acknowledgement before model double, current CLEAN byte reads and source-bound explanation', async () => {
    const key = randomUUID(), body = { question: 'What evidence is available?' }; operation = await post('/cases/' + f.caseId + '/explanations', body, 202, 'requester', key);
    resources.explanationId = operation.resource_ref.id; assert.equal(f.calls.provider, 0); assert.equal((await f.store.job(f.contexts.requester, resources.explanationId)).operation.state, 'PENDING');
    const detail = await processOne(resources.explanationId); assert.equal(detail.operation.state, 'SUCCEEDED'); assert.equal(detail.result.statements[0].citation.sha256, prepared.hash);
    assert.deepEqual(detail.result.missing_evidence, ['RECEIPT']); assert.equal(await effects(), 0);
    assert.deepEqual(await post('/cases/' + f.caseId + '/explanations', body, 202, 'requester', key), operation);
    await post('/cases/' + f.caseId + '/explanations', { question: 'Changed' }, 409, 'requester', key);
    const stored = await f.store.job(f.contexts.requester, resources.explanationId); assert.equal(stored.result.provenance.model_version, 'gemini-fixture-double');
  });
  await check('actual fixture policy, independent SQL decision and exactly one atomic local action/receipt', async () => {
    const value = await proposal(resources.explanationId); resources.proposalId = value.id; assert.equal(value.risk, 'R1'); assert.equal(value.state, 'AWAITING_APPROVAL');
    await post('/proposals/' + value.id + '/execute', {}, 403); assert.equal(await effects(value.id), 0);
    await post('/proposals/' + value.id + '/approval', { decision_ref: { pack_id: 'platform', type: 'decision', id: randomUUID() } }, 403, 'approver');
    const ref = await f.decision(value.id); await post('/proposals/' + value.id + '/approval', { decision_ref: ref }, 403);
    await post('/proposals/' + value.id + '/approval', { decision_ref: ref }, 200, 'approver');
    const key = randomUUID(), first = await post('/proposals/' + value.id + '/execute', {}, 200, 'requester', key);
    assert.deepEqual(await post('/proposals/' + value.id + '/execute', {}, 200, 'requester', key), first);
    await post('/proposals/' + value.id + '/execute', {}, 200); assert.equal(await effects(value.id), 1);
    const row = (await f.db.query('SELECT data,sha256 FROM mediation_fixture_actions WHERE tenant_id=$1 AND proposal_id=$2', [f.contexts.requester.tenantId, value.id])).rows[0];
    assert.equal(row.sha256, fingerprint(row.data)); assert.equal(first.receipt.sha256, row.sha256);
  });
  await check('R0 reads only, R2 requires approval, unknown/R3/model-client authority and foreign fact IDs are denied', async () => {
    const before = await effects(), read = await proposal(resources.explanationId, 'case.read_summary'); assert.equal(read.risk, 'R0');
    await post('/proposals/' + read.id + '/execute', {}, 200); assert.equal(await effects(), before);
    const note = await proposal(resources.explanationId, 'case.add_note'); assert.equal(note.risk, 'R2'); await post('/proposals/' + note.id + '/execute', {}, 403);
    for (const body of [{ tool: 'payment.transfer', amount: '1000' }, { tool: 'case.add_note', fact_ids: [randomUUID()] }, { tool: 'case.add_note', fact_ids: [prepared.factId], risk: 'R0' },
      { tool: 'case.request_evidence', missing_evidence_codes: ['SUPPLIER'] }]) await post('/explanations/' + resources.explanationId + '/proposals', body, 400);
  });
  await check('active foreign tenant can enqueue its own case, never reads another tenant case/explanation/operation/evidence/proposal', async () => {
    const own = await post('/cases/' + f.foreignCase + '/explanations', { question: 'What is missing?' }, 202, 'foreign'); assert.equal(own.tenant_id, f.contexts.foreign.tenantId);
    await post('/cases/' + f.caseId + '/explanations', { question: 'Why?' }, 404, 'foreign');
    for (const route of [prefix + '/explanations/' + resources.explanationId, prefix + '/proposals/' + resources.proposalId,
      '/platform/v1/operations/' + operation.id, '/platform/v1/evidence/' + prepared.cleanId]) await get(route, 'foreign', 404);
    await post('/proposals/' + resources.proposalId + '/execute', {}, 404, 'foreign');
  });
  await check('revoked original requester cannot be replaced by worker privileges before disclosure', async () => {
    const queued = await enqueue(), before = f.calls.provider; await membership(f.contexts.requester.subject, false);
    try { await f.service.processNext(f.contexts.worker); } finally { await membership(f.contexts.requester.subject, true); }
    assert.equal(f.calls.provider, before); assert.equal((await get(prefix + '/explanations/' + queued.resource_ref.id)).operation.state, 'FAILED');
  });
  await check('revoked processor cannot claim a queued explanation or make model calls', async () => {
    const queued = await enqueue(), before = f.calls.provider; await membership(f.contexts.worker.subject, false);
    try { await assert.rejects(f.service.processNext(f.contexts.worker), error => error.code === 'FORBIDDEN'); } finally { await membership(f.contexts.worker.subject, true); }
    assert.equal(f.calls.provider, before); assert.equal((await f.store.job(f.contexts.requester, queued.resource_ref.id)).attempts, 0); await processOne(queued.resource_ref.id);
  });
  await check('unscanned replacement evidence cannot be disclosed despite valid current case permissions', async () => {
    const queued = await enqueue(), before = f.calls.provider;
    const pending = await f.evidence.detail(f.contexts.worker, prepared.unscannedId);
    await f.db.query('UPDATE mediation_fixture_facts SET evidence_id=$3,evidence_hash=$4 WHERE tenant_id=$1 AND id=$2', [f.contexts.requester.tenantId, prepared.factId, prepared.unscannedId, pending.sha256]);
    try { await f.service.processNext(f.contexts.worker); }
    finally { await f.db.query('UPDATE mediation_fixture_facts SET evidence_id=$3,evidence_hash=$4 WHERE tenant_id=$1 AND id=$2', [f.contexts.requester.tenantId, prepared.factId, prepared.cleanId, prepared.hash]); }
    assert.equal(f.calls.provider, before); assert.equal((await get(prefix + '/explanations/' + queued.resource_ref.id)).operation.state, 'FAILED');
  });
  await check('current revoked decision/approver/policy each block a previously approved action', async () => {
    for (const kind of ['decision', 'approver', 'policy']) {
      const { value, ref } = await approved(resources.explanationId);
      if (kind === 'decision') await f.db.query("UPDATE mediation_fixture_decisions SET state='REVOKED' WHERE tenant_id=$1 AND id=$2", [f.contexts.requester.tenantId, ref.id]);
      if (kind === 'approver') await membership(f.contexts.approver.subject, false);
      if (kind === 'policy') await f.db.query('UPDATE mediation_fixture_policies SET enabled=false WHERE tenant_id=$1 AND id=$2', [f.contexts.requester.tenantId, f.policyId]);
      try { await post('/proposals/' + value.id + '/execute', {}, 403); assert.equal(await effects(value.id), 0); }
      finally { if (kind === 'approver') await membership(f.contexts.approver.subject, true); if (kind === 'policy') await f.db.query('UPDATE mediation_fixture_policies SET enabled=true WHERE tenant_id=$1 AND id=$2', [f.contexts.requester.tenantId, f.policyId]); }
    }
  });
  await check('actual local action insert and AI receipt/history roll back together; recreated service replays the same command', async () => {
    const { value } = await approved(resources.explanationId, 'case.add_note'), key = randomUUID(); f.flags.failAfterExecution = true;
    await post('/proposals/' + value.id + '/execute', {}, 503, 'requester', key); assert.equal(await effects(value.id), 0);
    assert.equal((await get(prefix + '/proposals/' + value.id)).state, 'APPROVED');
    const recovered = await f.createService().execute(f.contexts.requester, value.id, {}, key); shape('Proposal', recovered); assert.equal(recovered.state, 'EXECUTED'); assert.equal(await effects(value.id), 1);
    assert.deepEqual(await post('/proposals/' + value.id + '/execute', {}, 200, 'requester', key), recovered);
  });
  await check('concurrent executions serialize and produce one SQL effect with one stable receipt', async () => {
    const { value } = await approved(resources.explanationId), key = randomUUID();
    const responses = await Promise.all([post('/proposals/' + value.id + '/execute', {}, 200, 'requester', key), post('/proposals/' + value.id + '/execute', {}, 200, 'requester', key)]);
    assert.deepEqual(responses[0], responses[1]); assert.equal(await effects(value.id), 1);
  });
  await check('actual control kill switch interrupts generation and invalidates old approvals across re-enable epochs', async () => {
    const { value } = await approved(resources.explanationId), queued = await enqueue();
    f.flags.onSelect = async () => { await f.db.query('UPDATE openresolve_ai_controls SET enabled=false,revision=revision+1,updated_at=now() WHERE tenant_id=$1', [f.contexts.requester.tenantId]); };
    await f.service.processNext(f.contexts.worker); await post('/proposals/' + value.id + '/execute', {}, 503); assert.equal(await effects(value.id), 0);
    const failed = await get(prefix + '/explanations/' + queued.resource_ref.id); assert.equal(failed.operation.state, 'FAILED'); assert.equal(failed.result, undefined);
    await f.db.query('UPDATE openresolve_ai_controls SET enabled=true,revision=revision+1,updated_at=now() WHERE tenant_id=$1', [f.contexts.requester.tenantId]);
    await post('/proposals/' + value.id + '/execute', {}, 409); assert.equal(await effects(value.id), 0);
  });
  await check('source/proposal/receipt/history/command immutability and retained history hashes', async () => {
    const tenant = f.contexts.requester.tenantId;
    await assert.rejects(f.db.query('DELETE FROM openresolve_ai_history WHERE tenant_id=$1', [tenant]), /append-only/);
    await assert.rejects(f.db.query('DELETE FROM openresolve_ai_commands WHERE tenant_id=$1', [tenant]), /append-only/);
    await assert.rejects(f.db.query("UPDATE openresolve_ai_explanations SET data=jsonb_set(data,'{question}','\"changed\"') WHERE tenant_id=$1", [tenant]), /immutable/);
    await assert.rejects(f.db.query("UPDATE openresolve_ai_proposals SET data=jsonb_set(data,'{risk}','\"R0\"') WHERE tenant_id=$1 AND id=$2", [tenant, resources.proposalId]), /immutable/);
    await assert.rejects(f.db.query('DELETE FROM mediation_fixture_actions WHERE tenant_id=$1', [tenant]), /append-only/);
    for (const row of (await f.db.query('SELECT snapshot,sha256 FROM openresolve_ai_history WHERE tenant_id=$1', [tenant])).rows) assert.equal(fingerprint(row.snapshot), row.sha256);
  });
  for (const [name, hash] of Object.entries({ ...sourceHashes, ...supportHashes })) assert.equal(sha(fs.readFileSync(path.join(root, name))), hash, 'Code changed during runtime');
}
main().catch(error => { if (!checks.some(check => check.status === 'FAIL')) checks.push({ name: 'runtime setup/completion', status: 'FAIL', code: error.code || error.name });
  console.error('FAIL mediation runtime: ' + (error.code || error.name) + ' ' + String(error.message).slice(0, 300)); process.exitCode = 1;
}).finally(async () => {
  let retainedState;
  if (f) {
    try { const tenant = f.contexts.requester.tenantId;
      retainedState = { explanations: (await f.db.query('SELECT data FROM openresolve_ai_explanations WHERE tenant_id=$1 ORDER BY created_at,id', [tenant])).rows.map(row => row.data),
        proposals: (await f.db.query('SELECT data FROM openresolve_ai_proposals WHERE tenant_id=$1 ORDER BY id', [tenant])).rows.map(row => row.data),
        history: (await f.db.query('SELECT snapshot,sha256 FROM openresolve_ai_history WHERE tenant_id=$1 ORDER BY sequence', [tenant])).rows,
        actualFixtureActions: (await f.db.query('SELECT data,sha256 FROM mediation_fixture_actions WHERE tenant_id=$1 ORDER BY proposal_id', [tenant])).rows,
        evidence: (await f.db.query('SELECT data FROM platform_evidence_records WHERE tenant_id=$1 ORDER BY created_at,id', [tenant])).rows.map(row => row.data) };
    } catch (error) { checks.push({ name: 'retain isolated fixture state', status: 'FAIL', code: error.code || error.name }); process.exitCode = 1; }
    finally { await f.close(); }
  }
  const report = { started, completed: new Date().toISOString(), gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    worktreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()), sourceHashes, supportHashes, checks, resources, retainedState,
    environment: { node: process.version, platform: process.platform, services: 'actual isolated PostgreSQL/MinIO/pinned fresh ClamAV/Nest HTTP',
      identity: 'static server identities and actual SQL membership/case/evidence grants, not production SSO',
      model: 'explicit deterministic selection double; actual Gemini evaluation is a separate report',
      policyDecisionExecution: 'actual SQL-backed fixture ports and append-only local case-action rows, not owning #50 production integration', fault: 'injected exception after actual SQL, not process-kill recovery' },
    workerDurationsMs: timings, providerDoubleCalls: f?.calls.provider, actualProviderRequests: 0,
    limitations: ['No production #43/#50 Case/policy/decision adapter, ledger receipt or workflow integration', 'No bank/HTTP/arbitrary code or R3 executor', 'No production load, process-kill or coordinated restore claim'] };
  const output = path.join(root, 'docs/ai/evidence/issue54-mediation-runtime-' + started.replaceAll(/[^0-9]/g, '') + '.json'); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
});
