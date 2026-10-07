// Run inside smartprocure-api. Creates schema only; never inserts fake seals.
const assert=require('node:assert/strict');
const {Pool}=require('pg');
const {immudbOptions,LEDGER_TABLE_SQL,LEDGER_COLUMNS}=require('../../apps/api/dist/audit/immudb/immudb.client');
async function bootstrap(){
  const pool=new Pool(immudbOptions());pool.on('error',()=>{});
  let phase='connect/schema';
  try {
    await pool.query(LEDGER_TABLE_SQL);
    phase='schema-columns';
    const schema=await pool.query('SELECT '+LEDGER_COLUMNS+' FROM smartprocure_audit_seals LIMIT 0');
    assert.deepEqual(schema.fields.map(f=>f.name),LEDGER_COLUMNS.split(','));
    phase='state';
    const state=(await pool.query('SELECT immudb_state()')).rows[0];
    // Exact v1.11.0 database.CurrentState does not populate ImmutableState.Db;
    // the wire wrapper therefore returns an empty db column. Never fabricate it.
    assert.equal(state.db,'');
    assert.match(String(state.tx_id),/^[1-9]\d*$/);assert.match(state.tx_hash,/^[0-9a-f]{64}$/);
    // Exact SQL function syntax from the pinned source. Empty-key probes prove
    // dispatch/function availability, not successful cryptographic verification.
    phase='verify-row-dispatch';
    const missing=(await pool.query("SELECT immudb_verify_row('smartprocure_audit_seals', 'bootstrap-no-seal')")).rows[0];
    assert.equal(missing.verified,'false');
    phase='verify-transaction-dispatch';
    const first=(await pool.query('SELECT immudb_verify_tx(1)')).rows[0];
    assert.equal(first.verified,'true');assert.equal(String(first.tx_id),'1');
    console.log('PASS ImmuDB schema/state and exact SQL verification function dispatch; native client proof checks remain mandatory.');
  } catch(error) {
    // Static phase and machine code only; no SQL, credentials or stack output.
    const code=/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'CHECK_FAILED';
    console.error('IMMUDB_BOOTSTRAP_FAILED phase='+phase+' code='+code);throw error;
  } finally {await pool.end();}
}
if(require.main===module) bootstrap().catch(()=>{console.error('IMMUDB_BOOTSTRAP_FAILED: check pinned server, schema and credentials.');process.exitCode=1;});
module.exports={bootstrap};
