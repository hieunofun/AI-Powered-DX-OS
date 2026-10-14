// Actual project adapter against a disposable real candidate ledger only.
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { ImmudbClient, immudbOptions, LEDGER_TABLE_SQL, LEDGER_COLUMNS, ledgerColumnName, normalizeLedgerRow } = require('../../../apps/api/dist/audit/immudb/immudb.client');
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const key = id => 'smartprocure:audit:invoice:' + id + ':v1';
async function main() {
  assert.equal(process.env.IMMUDB_HOST, '127.0.0.1');
  assert.equal(process.env.IMMUDB_PASSWORD, 'disposable-ledger-qualification-only');
  const pool = new Pool(immudbOptions());
  const adapter = new ImmudbClient();
  try {
    const mode = process.argv[2];
    if (mode === 'seed') {
      await pool.query(LEDGER_TABLE_SQL);
      const schema = await pool.query('SELECT ' + LEDGER_COLUMNS + ' FROM smartprocure_audit_seals LIMIT 0');
      assert.deepEqual(schema.fields.map(field => ledgerColumnName(field.name)), LEDGER_COLUMNS.split(','));
      for (const [index, id] of ids.entries()) {
        await adapter.insert({ id, invoice_id: id, package_version: 'SMARTPROCURE-AUDIT-1', package_sha256: 'a'.repeat(64), merkle_root: String(index + 1).repeat(64), final_business_state: 'READY_FOR_PAYMENT' }, { seal_key: key(id) });
        const row = await adapter.get(key(id));
        assert.equal(row.seal_key, key(id));
        assert.equal(row.merkle_root, String(index + 1).repeat(64));
      }
      // A second read must not inherit a different key's cached binding.
      assert.equal((await adapter.get(key(ids[0]))).merkle_root, '1'.repeat(64));
    } else if (mode === 'count') {
      const rows = await pool.query('SELECT ' + LEDGER_COLUMNS + ' FROM smartprocure_audit_seals');
      assert.deepEqual(rows.rows.map(row => normalizeLedgerRow(row).seal_key).sort(), ids.map(key).sort());
    } else if (mode === 'append') {
      await pool.query('UPDATE smartprocure_audit_seals SET merkle_root=$1 WHERE seal_key=$2', ['f'.repeat(64), key(ids[0])]);
      assert.equal((await adapter.get(key(ids[0]))).merkle_root, 'f'.repeat(64));
    } else throw new Error('Unknown qualification mode');
  } finally {
    await adapter.onModuleDestroy();
    await pool.end();
  }
}
main().catch(error => { console.error('Candidate wire qualification failed: ' + error.message); process.exitCode = 1; });
