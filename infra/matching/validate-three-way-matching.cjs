// Acceptance requires real PostgreSQL, Keycloak JWT verification and APISIX routing.
// Fixture SQL is deliberately independent of the already-tested upstream upload/PO/GRN APIs.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const Decimal = require('decimal.js');
const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP });
const createFixtures = require('./fixtures.cjs');
const gatewayUrl = process.env.GATEWAY_URL || 'http://localhost:9080';
const keycloakUrl = process.env.KEYCLOAK_URL || 'http://localhost:8080';
const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost', port: process.env.POSTGRES_PORT || '5432',
  user: process.env.POSTGRES_USER || 'smartprocure_user', password: process.env.POSTGRES_PASSWORD || 'postgres_password',
  database: process.env.POSTGRES_DB || 'smartprocure_db', connectionTimeoutMillis: 5000,
});
const actors = {};
async function login(role, username) {
  const response = await fetch(keycloakUrl + '/realms/' + (process.env.KEYCLOAK_REALM || 'smartprocure') + '/protocol/openid-connect/token', {
    method: 'POST', signal: AbortSignal.timeout(20000), body: new URLSearchParams({
      client_id: process.env.CI_CLIENT_ID || 'smartprocure-ci', grant_type: 'password',
      username, password: process.env.DEMO_PASSWORD || 'DemoPassword123!',
    }),
  });
  assert.equal(response.status, 200, 'real Keycloak login for ' + role);
  const token = (await response.json()).access_token;
  assert.ok(token);
  const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
  actors[role] = { token, sub }; // never printed
}
async function api(method, path, role = 'accountant', body) {
  // Preserve the gateway's quota. Only explicit 429 responses are retried; no technical/business retry.
  for (let attempt = 0; attempt <= 30; attempt++) {
    const response = await fetch(gatewayUrl + '/api' + path, {
      method, signal: AbortSignal.timeout(70000),
      headers: { ...(role ? { Authorization: 'Bearer ' + actors[role].token } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (response.status === 429 && attempt < 30) {
      console.log('Gateway quota reached; bounded retry of explicit 429 only.');
      await new Promise(resolve => setTimeout(resolve, 2000));
      continue;
    }
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch {
      if (response.status < 400) throw new Error('Successful gateway response was not structured JSON');
      data = { gatewayRejected: true }; // APISIX can reject anonymous requests before NestJS with a text/HTML body.
    }
    return { status: response.status, body: data };
  }
}
async function request(method, path, role, body, status = 200) {
  const response = await api(method, path, role, body);
  assert.equal(response.status, status, method + ' ' + path + ': ' + JSON.stringify(response.body));
  return response.body;
}
const match = id => request('POST', '/invoices/' + id + '/match', 'accountant');
async function assertResult(invoiceId, result, expectedStatus, codes = []) {
  assert.equal(result.status, expectedStatus);
  assert.equal(result.invoiceStatus, expectedStatus === 'PASSED' ? 'MATCHED' : 'EXCEPTION');
  assert.equal(result.overallConfidence, null);
  assert.deepEqual(result.discrepancyCodes, codes);
  assert.ok(result.completedAt);
  assert.equal(result.ruleVersion, '3WM-1.1');
  assert.equal(result.policySnapshot.ruleVersion, '3WM-1.1');
  const stored = (await pool.query(`SELECT i.status,mr.status AS result_status,mr.policy_snapshot,
    mr.overall_confidence,mr.completed_at,mr.evaluation_duration_ms::text,
    (SELECT count(*)::int FROM invoice_items WHERE invoice_id=i.id) AS invoice_lines,
    (SELECT count(*)::int FROM match_result_items WHERE match_result_id=mr.id) AS result_lines,
    (SELECT count(*)::int FROM approval_cases WHERE invoice_id=i.id) AS approvals
    FROM invoices i JOIN match_results mr ON mr.invoice_id=i.id WHERE i.id=$1`, [invoiceId])).rows[0];
  assert.equal(stored.status, result.invoiceStatus); assert.equal(stored.result_status, expectedStatus);
  assert.deepEqual(stored.policy_snapshot, result.policySnapshot);
  assert.equal(stored.overall_confidence, null); assert.ok(stored.completed_at);
  assert.equal(stored.invoice_lines, stored.result_lines); assert.equal(stored.result_lines, result.items.length);
  assert.equal(stored.approvals, 0);
  for (const line of result.items) {
    assert.equal(line.semanticConfidence, null);
    assert.notEqual(line.status, 'PENDING');
    if (line.status !== 'MATCHED') assert.ok(line.discrepancyCodes.length);
  }
  const audit = (await pool.query(`SELECT actor_subject,metadata FROM audit_records
    WHERE entity_type='MATCH_RESULT' AND entity_id=$1 AND event_type='MATCHING_COMPLETED'`, [result.id])).rows;
  assert.equal(audit.length, 1); assert.equal(audit[0].actor_subject, actors.accountant.sub);
  assert.equal(audit[0].metadata.invoiceId, invoiceId);
  assert.deepEqual(audit[0].metadata.policySnapshot, result.policySnapshot);
  assert.deepEqual(audit[0].metadata.discrepancyCodes, codes);
  assert.equal(audit[0].metadata.lineCount, result.items.length);
  const transition = (await pool.query(`SELECT metadata FROM audit_records WHERE entity_type='INVOICE' AND entity_id=$1
    AND event_type=$2`, [invoiceId, result.invoiceStatus === 'MATCHED' ? 'INVOICE_MATCHED' : 'INVOICE_EXCEPTION'])).rows;
  assert.equal(transition.length, 1);
  assert.deepEqual(transition[0].metadata.transitions, ['PARSED', 'PENDING_MATCH', result.invoiceStatus]);
}
async function concurrent(table, id, calls) {
  // A real row-lock barrier proves both authenticated API requests are in flight together.
  const blocker = await pool.connect();
  let pending;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM ' + table + ' WHERE id=$1 FOR UPDATE', [id]);
    pending = calls.map(call => call());
    const deadline = Date.now() + 65000;
    let overlap = false;
    while (Date.now() < deadline) {
      const count = (await pool.query(`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1`,
      ['%FROM ' + table + ' WHERE id=$1 FOR UPDATE%'])).rows[0].count;
      if (count >= 2) { overlap = true; break; }
    }
    assert.ok(overlap, 'Both API transactions must wait at the real ' + table + ' lock barrier');
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
  return Promise.all(pending);
}
async function main() {
  for (const [role, username] of [
    ['accountant', 'accountant.demo'], ['admin', 'admin.demo'], ['buyer', 'buyer.demo'],
    ['warehouse', 'warehouse.demo'], ['finance_manager', 'finance.demo'],
  ]) await login(role, username);
  const original = await request('GET', '/matching/policy', 'admin');
  const fields = ['quantityTolerancePercent', 'priceTolerancePercent', 'taxTolerancePercent', 'totalTolerancePercent'];
  const restore = Object.fromEntries(fields.map(key => [key, original[key]]));
  const defaults = { quantityTolerancePercent: '0.00', priceTolerancePercent: '1.00', taxTolerancePercent: '0.00', totalTolerancePercent: '0.00' };
  let trigger = false;
  try {
    await request('PATCH', '/matching/policy', 'admin', defaults);
    const runId = randomUUID(), taxCode = 'M8-' + runId;
    const supplier = (await pool.query('INSERT INTO suppliers(supplier_code,tax_code,name) VALUES($1,$2,$3) RETURNING id',
      ['MATCH-' + runId, taxCode, 'Synthetic Issue 8 Supplier'])).rows[0].id;
    const f = createFixtures(pool, supplier, taxCode, runId);
    async function scenario(label, poOptions, invoiceOptions, status, codes) {
      const order = await f.po(poOptions), invoice = await f.invoice(order, invoiceOptions), result = await match(invoice);
      await assertResult(invoice, result, status, codes);
      console.log('PASS ' + label);
      return { order, invoice, result };
    }
    const perfect = await scenario('perfect 3-way match and atomic mappings/audit', {}, {}, 'PASSED', []);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM invoice_items WHERE invoice_id=$1 AND po_item_id IS NOT NULL',
      [perfect.invoice])).rows[0].count, 1);
    await scenario('partial receipt PASS', { receipts: [{ status: 'RECEIVED', accepted: '60', rejected: '40' }] },
      { quantity: '60' }, 'PASSED', []);
    await scenario('price mismatch', {}, { price: '102' }, 'REVIEW_REQUIRED', ['PRICE_MISMATCH']);
    await scenario('quantity mismatch uses accepted only, excludes DRAFT/CANCELLED and rejects fictional stock',
      { receipts: [{ status: 'RECEIVED', accepted: '60', rejected: '40' },
        { status: 'DRAFT', accepted: '100', rejected: '0' }, { status: 'CANCELLED', accepted: '100', rejected: '0' }] },
      { quantity: '70' }, 'REVIEW_REQUIRED', ['QUANTITY_MISMATCH']);
    await scenario('tax mismatch (2 percentage points)', {}, { tax: '0.0800' }, 'REVIEW_REQUIRED', ['TAX_MISMATCH']);
    await scenario('missing GRN', { receipts: [] }, {}, 'REVIEW_REQUIRED', ['MISSING_GRN', 'QUANTITY_MISMATCH']);
    const unknownOrder = await f.po();
    const unknownId = await f.invoice(unknownOrder, { lines: [{ sku: 'UNKNOWN' }] });
    const unknown = await match(unknownId);
    await assertResult(unknownId, unknown, 'REVIEW_REQUIRED', ['UNRECOGNIZED_ITEM']);
    assert.equal((await pool.query('SELECT po_item_id FROM invoice_items WHERE invoice_id=$1', [unknownId])).rows[0].po_item_id, null);
    console.log('PASS unrecognized item remains unmapped');
    const ambiguousOrder = await f.po({ count: 2, duplicateSku: true });
    const ambiguousId = await f.invoice(ambiguousOrder, { lines: [{}] });
    await assertResult(ambiguousId, await match(ambiguousId), 'REVIEW_REQUIRED', ['AMBIGUOUS_ITEM']);
    assert.equal((await pool.query('SELECT po_item_id FROM invoice_items WHERE invoice_id=$1', [ambiguousId])).rows[0].po_item_id, null);
    console.log('PASS ambiguous item remains unmapped');
    const exactOrder = await f.po();
    const exactId = await f.invoice(exactOrder, { lines: [{ sku: null, description: '  matching   GOODS 1 ' }] });
    await assertResult(exactId, await match(exactId), 'PASSED', []);
    console.log('PASS exact normalized description fallback');
    const descriptionOrder = await f.po();
    const descriptionId = await f.invoice(descriptionOrder, { lines: [{ description: 'Different description' }] });
    const description = await match(descriptionId);
    await assertResult(descriptionId, description, 'REVIEW_REQUIRED', ['ITEM_DESCRIPTION_MISMATCH']);
    assert.ok(description.items[0].purchaseOrderItemId);
    console.log('PASS SKU mapping retained on description mismatch');
    const splitOrder = await f.po();
    const splitId = await f.invoice(splitOrder, { lines: [{ quantity: '60' }, { quantity: '50' }] });
    const split = await match(splitId);
    await assertResult(splitId, split, 'REVIEW_REQUIRED', ['QUANTITY_MISMATCH']);
    assert.deepEqual(split.items.map(i => i.matchedReceivedQuantity), ['60.0000', '40.0000']);
    assert.ok(split.items.every(i => i.discrepancyCodes.includes('QUANTITY_MISMATCH')));
    console.log('PASS split-line aggregation and ordered allocation');
    for (const [quantity, status, codes] of [['38', 'PASSED', []], ['40', 'REVIEW_REQUIRED', ['QUANTITY_MISMATCH']]]) {
      const order = await f.po({ receipts: [{ status: 'RECEIVED', accepted: '60', rejected: '0' },
        { status: 'RECEIVED', accepted: '38', rejected: '0' }] });
      const first = await f.invoice(order, { quantity: '60' });
      await assertResult(first, await match(first), 'PASSED', []);
      const next = await f.invoice(order, { quantity }), result = await match(next);
      await assertResult(next, result, status, codes);
      assert.equal(result.items[0].details.availableToInvoice, '38');
      assert.equal(result.items[0].details.previousValidInvoicedQuantity, '60');
      console.log('PASS prior PASSED 60 + next ' + quantity + ' from accepted 98');
    }
    // Legacy/header corruption is SQL-only; never weaken the Issue #7 XML validation.
    await scenario('legacy header total mismatch', {}, { headerDelta: '1' }, 'REVIEW_REQUIRED', ['TOTAL_MISMATCH']);
    await scenario('seller tax mismatch', {}, { sellerTaxCode: 'other' }, 'REVIEW_REQUIRED', ['SELLER_TAX_CODE_MISMATCH']);
    await scenario('missing seller tax code', {}, { sellerTaxCode: null }, 'REVIEW_REQUIRED', ['SELLER_TAX_CODE_MISSING']);
    await scenario('currency mismatch', {}, { currency: 'USD' }, 'REVIEW_REQUIRED', ['CURRENCY_MISMATCH']);
    const otherSupplier = (await pool.query('INSERT INTO suppliers(supplier_code,tax_code,name) VALUES($1,$2,$3) RETURNING id',
      ['OTHER-' + runId, 'OTHER-' + runId, 'Synthetic Other Supplier'])).rows[0].id;
    await scenario('supplier identity mismatch', {}, { supplier: otherSupplier }, 'REVIEW_REQUIRED', ['SUPPLIER_MISMATCH']);

    const sameOrder = await f.po(), sameId = await f.invoice(sameOrder);
    const same = await concurrent('invoices', sameId, [
      () => api('POST', '/invoices/' + sameId + '/match'), () => api('POST', '/invoices/' + sameId + '/match'),
    ]);
    assert.deepEqual(same.map(r => r.status).sort(), [200, 409]);
    assert.equal(same.find(r => r.status === 409).body.errorCode, 'MATCH_ALREADY_EXISTS');
    await assertResult(sameId, same.find(r => r.status === 200).body, 'PASSED', []);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM match_results WHERE invoice_id=$1', [sameId])).rows[0].count, 1);
    console.log('PASS same-invoice overlap: exactly one result; 200 + 409 MATCH_ALREADY_EXISTS');

    const crossOrder = await f.po(), prior = await f.invoice(crossOrder, { quantity: '80' });
    await assertResult(prior, await match(prior), 'PASSED', []);
    const a = await f.invoice(crossOrder, { quantity: '20' }), b = await f.invoice(crossOrder, { quantity: '20' });
    const cross = await concurrent('purchase_orders', crossOrder.id, [() => match(a), () => match(b)]);
    assert.deepEqual(cross.map(r => r.status).sort(), ['PASSED', 'REVIEW_REQUIRED']);
    for (const [index, id] of [a, b].entries()) await assertResult(id, cross[index], cross[index].status,
      cross[index].status === 'PASSED' ? [] : ['QUANTITY_MISMATCH']);
    assert.equal((await pool.query(`SELECT SUM(ii.quantity)::text AS total FROM match_result_items mri
      JOIN match_results mr ON mr.id=mri.match_result_id JOIN invoice_items ii ON ii.id=mri.invoice_item_id
      JOIN invoices i ON i.id=mr.invoice_id WHERE mr.purchase_order_id=$1 AND mr.status='PASSED' AND i.status='MATCHED'`,
    [crossOrder.id])).rows[0].total, '100.0000');
    assert.deepEqual(cross.map(r => r.items[0].details.availableToInvoice).sort(), ['0', '20']);
    console.log('PASS cross-invoice overlap: one PASSED/MATCHED, one REVIEW_REQUIRED/EXCEPTION; no double consumption');

    const updated = await request('PATCH', '/matching/policy', 'admin', { priceTolerancePercent: '2.00' });
    assert.equal(updated.priceTolerancePercent, '2.00');
    const historical = await request('GET', '/match-results/' + perfect.result.id, 'accountant');
    assert.equal(historical.policySnapshot.priceTolerancePercent, '1.00');
    const latestAudit = (await pool.query(`SELECT actor_subject,metadata FROM audit_records
      WHERE entity_type='MATCHING_POLICY' AND event_type='MATCHING_POLICY_UPDATED' AND entity_id=$1
      ORDER BY created_at DESC,id DESC LIMIT 1`, [updated.id])).rows[0];
    assert.equal(latestAudit.actor_subject, actors.admin.sub);
    assert.equal(latestAudit.metadata.previous.priceTolerancePercent, '1.00');
    assert.equal(latestAudit.metadata.new.priceTolerancePercent, '2.00');
    assert.ok(latestAudit.metadata.roles.includes('admin'));
    await scenario('updated policy used for later invoice', {}, { price: '101.50' }, 'PASSED', []);
    console.log('PASS policy update audit + immutable historical snapshot');

    // Deliberately fail the last audit writes, proving rollback after result/items/mappings were written.
    const rollbackOrder = await f.po(), rollbackId = await f.invoice(rollbackOrder);
    await pool.query(`CREATE FUNCTION matching_test_rollback() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type IN ('MATCHING_COMPLETED','MATCHING_POLICY_UPDATED') THEN
        RAISE EXCEPTION 'controlled matching rollback probe'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER trg_matching_test_rollback BEFORE INSERT ON audit_records
      FOR EACH ROW EXECUTE FUNCTION matching_test_rollback();`);
    trigger = true;
    const failed = await request('POST', '/invoices/' + rollbackId + '/match', 'accountant', undefined, 503);
    assert.equal(failed.errorCode, 'MATCHING_UNAVAILABLE');
    assert.ok(!JSON.stringify(failed).includes('controlled matching rollback probe'));
    const rollback = (await pool.query(`SELECT status,
      (SELECT count(*)::int FROM match_results WHERE invoice_id=$1) AS results,
      (SELECT count(*)::int FROM match_result_items mri JOIN invoice_items ii ON ii.id=mri.invoice_item_id WHERE ii.invoice_id=$1) AS lines,
      (SELECT count(*)::int FROM invoice_items WHERE invoice_id=$1 AND po_item_id IS NOT NULL) AS mappings,
      (SELECT count(*)::int FROM audit_records WHERE entity_id=$1) AS audits FROM invoices WHERE id=$1`, [rollbackId])).rows[0];
    assert.deepEqual(rollback, { status: 'PARSED', results: 0, lines: 0, mappings: 0, audits: 0 });
    await request('PATCH', '/matching/policy', 'admin', { priceTolerancePercent: '3.00' }, 503);
    assert.equal((await request('GET', '/matching/policy', 'admin')).priceTolerancePercent, '2.00');
    await pool.query('DROP TRIGGER trg_matching_test_rollback ON audit_records; DROP FUNCTION matching_test_rollback()');
    trigger = false;
    await assertResult(rollbackId, await match(rollbackId), 'PASSED', []);
    console.log('PASS technical matching and policy-audit rollback; PARSED/no partial result, mapping or audit; retry succeeds');

    for (const role of ['buyer', 'warehouse', 'finance_manager']) {
      await request('POST', '/invoices/' + randomUUID() + '/match', role, undefined, 403);
      await request('PATCH', '/matching/policy', role, { priceTolerancePercent: '1' }, 403);
    }
    await request('PATCH', '/matching/policy', 'accountant', { priceTolerancePercent: '1' }, 403);
    for (const role of Object.keys(actors)) {
      for (const path of ['/invoices/' + perfect.invoice + '/match-result', '/match-results/' + perfect.result.id, '/matching/policy']) {
        await request('GET', path, role);
      }
    }
    const adminOrder = await f.po(), adminInvoice = await f.invoice(adminOrder);
    const adminMatch = await request('POST', '/invoices/' + adminInvoice + '/match', 'admin');
    assert.equal(adminMatch.status, 'PASSED');
    assert.equal((await pool.query("SELECT actor_subject FROM audit_records WHERE entity_id=$1 AND event_type='MATCHING_COMPLETED'", [adminMatch.id])).rows[0].actor_subject,
      actors.admin.sub);
    for (const path of ['/matching/policy', '/match-results/' + perfect.result.id]) await request('GET', path, null, undefined, 401);
    await request('POST', '/invoices/' + randomUUID() + '/match', null, undefined, 401);
    await request('POST', '/invoices/' + randomUUID() + '/match', 'accountant', undefined, 404);
    await request('GET', '/match-results/' + randomUUID(), 'accountant', undefined, 404);
    await request('POST', '/invoices/' + perfect.invoice + '/match', 'accountant', undefined, 409);
    const draftId = await f.invoice(await f.po(), { status: 'RECEIVED' });
    await request('POST', '/invoices/' + draftId + '/match', 'accountant', undefined, 409);
    await request('POST', '/invoices/' + draftId + '/match', 'accountant', { quantity: '100' }, 400);
    await request('PATCH', '/matching/policy', 'admin', { priceTolerancePercent: 1 }, 400);
    await request('PATCH', '/matching/policy', 'admin', { totalTolerancePercent: '100.01' }, 400);
    console.log('PASS real JWT/RBAC, read roles, admin mutation, strict inputs and safe HTTP errors');

    await request('PATCH', '/matching/policy', 'admin', defaults);
    const benchmarkPo = { count: 100, receipts: [{ status: 'RECEIVED', accepted: '60', rejected: '0' },
      { status: 'RECEIVED', accepted: '40', rejected: '0' }] };
    const warmOrder = await f.po(benchmarkPo), warmInvoice = await f.invoice(warmOrder);
    await assertResult(warmInvoice, await match(warmInvoice), 'PASSED', []);
    const order = await f.po(benchmarkPo), invoice = await f.invoice(order), measured = await match(invoice);
    await assertResult(invoice, measured, 'PASSED', []);
    assert.equal(measured.items.length, 100);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM goods_receipt_items gri
      JOIN goods_receipts gr ON gr.id=gri.goods_receipt_id WHERE gr.purchase_order_id=$1 AND gr.status='RECEIVED'`, [order.id])).rows[0].count, 200);
    assert.ok(new D(measured.evaluationDurationMs).gte(0) && new D(measured.evaluationDurationMs).lt(1000),
      '100-line warmed CORE evaluation must be sub-second');
    console.log('PASS 100-line benchmark: 100 PO lines, 100 invoice lines, 200 accepted GRN-line records across 2 GRNs; evaluationDurationMs=' +
      measured.evaluationDurationMs + ' (<1000ms CORE ONLY; excludes HTTP/auth/fixture setup)');
    console.log('PASS real deterministic 3-way matching: PostgreSQL, Keycloak, APISIX, atomic audits, rollback and both concurrency barriers.');
  } finally {
    if (trigger) await pool.query('DROP TRIGGER IF EXISTS trg_matching_test_rollback ON audit_records; DROP FUNCTION IF EXISTS matching_test_rollback()');
    await request('PATCH', '/matching/policy', 'admin', restore);
  }
}
main().catch(error => { console.error('FAIL matching acceptance: ' + error.message); process.exitCode = 1; })
  .finally(() => pool.end());
