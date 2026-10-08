// Synthetic document setup; real matching, JWT/RBAC, gateway, Flowable and audit APIs.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');
const fixtures = require('../matching/fixtures.cjs');
const db = new Pool({ host: process.env.POSTGRES_HOST || 'localhost', port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB || 'smartprocure_db', user: process.env.POSTGRES_USER || 'smartprocure_user',
  password: process.env.POSTGRES_PASSWORD || 'postgres_password', connectionTimeoutMillis: 5000 });
const gateway = process.env.GATEWAY_URL || 'http://localhost:9080';
const keycloak = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const tokens = {};
let faultName = null;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function login(role, username) {
  const response = await fetch(keycloak + '/realms/smartprocure/protocol/openid-connect/token', {
    method: 'POST', signal: AbortSignal.timeout(20000), body: new URLSearchParams({
      client_id: process.env.CI_CLIENT_ID || 'smartprocure-ci', grant_type: 'password', username,
      password: process.env.DEMO_PASSWORD || 'DemoPassword123!',
    }),
  });
  assert.equal(response.status, 200, 'Actual Keycloak login for ' + role);
  tokens[role] = (await response.json()).access_token;
}
async function api(method, path, role = 'accountant', body) {
  for (let attempt = 0; attempt < 31; attempt++) {
    const response = await fetch(gateway + '/api' + path, { method, signal: AbortSignal.timeout(90000),
      headers: { Authorization: 'Bearer ' + tokens[role], ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // Only gateway quota rejection is retried; no ambiguous financial command is retried.
    if (response.status === 429 && attempt < 30) { await response.text(); await pause(2000); continue; }
    return { status: response.status, body: await response.json() };
  }
}
async function request(method, path, role = 'accountant', body, expected = 200) {
  const result = await api(method, path, role, body);
  assert.equal(result.status, expected, method + ' ' + path + ': ' + JSON.stringify(result.body));
  return result.body;
}
const match = id => request('POST', '/invoices/' + id + '/match');
const start = id => request('POST', '/invoices/' + id + '/workflow/start');
const complete = (id, role, action = 'APPROVE') => api('POST', '/approval-tasks/' + id + '/complete', role,
  { action, reason: 'Synthetic issue #34 quantity reservation acceptance' });
async function active(caseId, role) {
  const tasks = await request('GET', '/approval-cases/' + caseId + '/tasks');
  const open = tasks.filter(task => ['OPEN', 'CLAIMED'].includes(task.status));
  assert.equal(open.length, 1); assert.equal(open[0].assignedRole, role);
  await request('POST', '/approval-tasks/' + open[0].id + '/claim', role);
  return open[0];
}
async function state(id) { return (await db.query('SELECT status FROM invoices WHERE id=$1', [id])).rows[0].status; }
async function received(order, quantity) {
  const grn = await request('POST', '/goods-receipts', 'warehouse', { purchaseOrderId: order.id,
    items: [{ purchaseOrderItemId: order.items[0].id, receivedQuantity: quantity,
      acceptedQuantity: quantity, rejectedQuantity: '0' }] }, 201);
  await request('POST', '/goods-receipts/' + grn.id + '/receive', 'warehouse');
  return grn.id;
}
async function cancel(id, expected) {
  return request('POST', '/goods-receipts/' + id + '/cancel', 'warehouse', { reason: 'Synthetic reservation probe' }, expected);
}
async function concurrentApprovals(order, work) {
  const barrier = await db.connect();
  let pending = [];
  try {
    await barrier.query('BEGIN');
    await barrier.query('SELECT id FROM purchase_orders WHERE id=$1 FOR UPDATE', [order.id]);
    pending = work.map(fn => fn());
    let waiting = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      waiting = Number((await db.query(`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND query LIKE '%SELECT id,status FROM purchase_orders WHERE id=$1 FOR UPDATE%'`)).rows[0].count);
      if (waiting >= 2) break;
      await pause(50);
    }
    assert.ok(waiting >= 2, 'Both distinct invoices must reach the real PO lock before release');
    await barrier.query('COMMIT');
    return await Promise.all(pending);
  } finally { await barrier.query('ROLLBACK'); barrier.release(); await Promise.allSettled(pending); }
}
async function proof(id) {
  const verified = await request('GET', '/audit/invoices/' + id + '/verify');
  assert.equal(verified.verificationStatus, 'VERIFIED');
  assert.equal(verified.immudbCryptographicProofValid, true);
}
async function recover(id) {
  const args = ['infra/workflow/reconcile-workflows.cjs', '--apply', '--operation', id];
  const output = process.env.QUANTITY_OPERATOR_ON_HOST === 'true'
    ? execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 90000 })
    : execFileSync('docker', ['compose', 'exec', '-T', 'smartprocure-api', 'node', ...args], { encoding: 'utf8', timeout: 90000 });
  assert.ok(output.includes('"mode":"apply"'));
  assert.equal((await db.query('SELECT status FROM workflow_operations WHERE id=$1', [id])).rows[0].status, 'APPLIED');
}
async function clearFault() {
  if (!faultName) return;
  await db.query(`DROP TRIGGER IF EXISTS ${faultName} ON approval_tasks`);
  await db.query(`DROP FUNCTION IF EXISTS ${faultName}()`);
  faultName = null;
}
async function main() {
  await Promise.all([['accountant', 'accountant.demo'], ['buyer', 'buyer.demo'], ['warehouse', 'warehouse.demo'],
    ['finance_manager', 'finance.demo'], ['admin', 'admin.demo']].map(([role, user]) => login(role, user)));
  const supplier = (await db.query('SELECT id,tax_code FROM suppliers ORDER BY created_at LIMIT 1')).rows[0];
  assert.ok(supplier);
  const f = fixtures(db, supplier.id, supplier.tax_code, 'QTY34-' + randomUUID());
  const policy = await request('GET', '/workflow/policy', 'admin');
  assert.equal(policy.financeApprovalThreshold, '100000000.00', 'Run against the documented demo policy; no global policy mutation');

  const approvedOrder = await f.po({ ordered: '10', receipts: [{ status: 'RECEIVED', accepted: '10', rejected: '0' }] });
  const approved = await f.invoice(approvedOrder, { quantity: '10', price: '150' });
  const original = await match(approved);
  assert.equal(original.status, 'REVIEW_REQUIRED');
  const approval = await start(approved), buyer = await active(approval.approvalCaseId, 'buyer');
  assert.equal((await complete(buyer.id, 'buyer', 'APPROVE_WITH_ADJUSTMENT')).status, 200);
  assert.equal(await state(approved), 'READY_FOR_PAYMENT');
  const later = await match(await f.invoice(approvedOrder, { quantity: '10' }));
  assert.equal(later.status, 'REVIEW_REQUIRED'); assert.ok(later.discrepancyCodes.includes('QUANTITY_MISMATCH'));
  assert.equal(later.items[0].details.previousValidInvoicedQuantity, '10');
  const saved = await request('GET', '/invoices/' + approved + '/match-result');
  assert.equal(saved.status, original.status); assert.deepEqual(saved.policySnapshot, original.policySnapshot);
  assert.deepEqual(saved.items, original.items);
  await proof(approved);
  console.log('PASS approved price exception consumes stock; original matching evidence and native audit proof remain intact');

  const raceOrder = await f.po({ ordered: '10', receipts: [] });
  const raceInvoices = await Promise.all([f.invoice(raceOrder, { quantity: '10', price: '150' }), f.invoice(raceOrder, { quantity: '10', price: '150' })]);
  const raceCases = [], raceTasks = [];
  for (const id of raceInvoices) {
    assert.equal((await match(id)).items[0].matchedReceivedQuantity, '0.0000');
    const info = await start(id); raceCases.push(info.approvalCaseId); raceTasks.push(await active(info.approvalCaseId, 'warehouse'));
  }
  const raceReceipt = await received(raceOrder, '10');
  const results = await concurrentApprovals(raceOrder, raceTasks.map(task => () => complete(task.id, 'warehouse')));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const winner = results.findIndex(result => result.status === 200), loser = 1 - winner;
  assert.equal(results[loser].body.errorCode, 'INSUFFICIENT_RECEIVED_QUANTITY');
  assert.equal(await state(raceInvoices[winner]), 'EXCEPTION');
  assert.equal((await cancel(raceReceipt, 409)).errorCode, 'GRN_QUANTITY_RESERVED');
  const next = await match(await f.invoice(raceOrder, { quantity: '10' }));
  assert.equal(next.items[0].details.previousValidInvoicedQuantity, '10');
  const nextBuyer = await active(raceCases[winner], 'buyer');
  assert.equal((await complete(nextBuyer.id, 'buyer')).status, 200);
  assert.equal(await state(raceInvoices[winner]), 'READY_FOR_PAYMENT');
  assert.equal((await complete(raceTasks[loser].id, 'warehouse', 'REQUEST_CREDIT_NOTE')).status, 200);
  console.log('PASS two pending exceptions, later stock and simultaneous approvals: one reservation; intermediate role holds stock and prevents cancellation');

  for (const action of ['REJECT', 'REQUEST_CREDIT_NOTE']) {
    const order = await f.po({ ordered: '10', receipts: [{ status: 'RECEIVED', accepted: '10', rejected: '0' }] });
    const id = await f.invoice(order, { quantity: '10', price: '150' }); await match(id);
    const info = await start(id), task = await active(info.approvalCaseId, 'buyer');
    const blocked = await match(await f.invoice(order, { quantity: '10' }));
    assert.equal(blocked.items[0].details.availableToInvoice, '0');
    assert.equal((await complete(task.id, 'buyer', action)).status, 200);
    const released = await match(await f.invoice(order, { quantity: '10' }));
    assert.equal(released.status, 'PASSED');
    assert.equal(released.items[0].details.previousValidInvoicedQuantity, '0');
    await proof(id);
    console.log('PASS ' + action + ' releases pending allocations without altering sealed history');
  }

  const failedOrder = await f.po({ ordered: '10', receipts: [] });
  const failed = await f.invoice(failedOrder, { quantity: '10', price: '150' }); await match(failed);
  const failedCase = await start(failed), failedTask = await active(failedCase.approvalCaseId, 'warehouse');
  const failedReceipt = await received(failedOrder, '10');
  faultName = 'qty34_fault_' + randomUUID().replace(/-/g, '');
  await db.query(`CREATE FUNCTION ${faultName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id='${failedTask.id}'::uuid AND NEW.status='COMPLETED' THEN RAISE EXCEPTION 'Controlled issue 34 fixture sync failure'; END IF; RETURN NEW; END $$`);
  await db.query(`CREATE TRIGGER ${faultName} BEFORE UPDATE ON approval_tasks FOR EACH ROW EXECUTE FUNCTION ${faultName}()`);
  const failure = await complete(failedTask.id, 'warehouse'); assert.equal(failure.status, 503);
  const failedOp = (await db.query(`SELECT id,status,retry_safe FROM workflow_operations WHERE approval_task_id=$1 AND operation='COMPLETE'`, [failedTask.id])).rows[0];
  assert.equal(failedOp.status, 'FAILED'); assert.equal(failedOp.retry_safe, false);
  assert.equal((await match(await f.invoice(failedOrder, { quantity: '10' }))).items[0].details.availableToInvoice, '0');
  assert.equal((await cancel(failedReceipt, 409)).errorCode, 'GRN_QUANTITY_RESERVED');
  await clearFault(); await recover(failedOp.id);
  const recoveredBuyer = await active(failedCase.approvalCaseId, 'buyer');
  assert.equal((await complete(recoveredBuyer.id, 'buyer')).status, 200);
  await proof(failed);
  console.log('PASS real Flowable completion/local sync failure retains reservation; explicit historic-marker recovery preserves one operation and audit proof');

  const unresolvedOrder = await f.po({ ordered: '10', receipts: [{ status: 'RECEIVED', accepted: '10', rejected: '0' }] });
  const unresolved = await f.invoice(unresolvedOrder, { lines: [{ quantity: '10', sku: 'UNRESOLVED-QTY34' }] });
  await match(unresolved); const unresolvedCase = await start(unresolved), unresolvedTask = await active(unresolvedCase.approvalCaseId, 'buyer');
  const denied = await complete(unresolvedTask.id, 'buyer');
  assert.equal(denied.status, 409); assert.equal(denied.body.errorCode, 'UNRESOLVED_INVOICE_QUANTITY');
  assert.equal((await db.query(`SELECT count(*) FROM workflow_operations WHERE approval_task_id=$1 AND operation='COMPLETE'`, [unresolvedTask.id])).rows[0].count, '0');
  console.log('PASS unresolved PO mapping cannot dispatch approval or create an approving intent');

  const freeOrder = await f.po({ ordered: '10', receipts: [] });
  const freeReceipt = await received(freeOrder, '10'); await cancel(freeReceipt, 200);
  assert.equal((await db.query('SELECT status FROM goods_receipts WHERE id=$1', [freeReceipt])).rows[0].status, 'CANCELLED');
  console.log('PASS receipt without active claims remains cancellable');
  console.log('SUCCESS: 7 real quantity reservation scenarios passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { try { await clearFault(); } finally { await db.end(); } });
