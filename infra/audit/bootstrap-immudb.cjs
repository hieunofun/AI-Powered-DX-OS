// Run inside smartprocure-api. Creates schema only; never inserts fake seals.
const assert=require('node:assert/strict');
const {Pool}=require('pg');
const {immudbOptions,LEDGER_TABLE_SQL,LEDGER_COLUMNS,ledgerColumnName}=require('../../apps/api/dist/audit/immudb/immudb.client');
async function bootstrap(){
  const pool=new Pool(immudbOptions());pool.on('error',()=>{});
  let phase='connect/schema';
  try {
    await pool.query(LEDGER_TABLE_SQL);
    phase='schema-columns';
    const schema=await pool.query('SELECT '+LEDGER_COLUMNS+' FROM smartprocure_audit_seals LIMIT 0');
    assert.deepEqual(schema.fields.map(f=>ledgerColumnName(f.name)),LEDGER_COLUMNS.split(','));
    phase='native-verifier';
    const response=await fetch((process.env.IMMUDB_VERIFIER_URL||'http://smartprocure-audit-verifier:8081')+'/health',
      {signal:AbortSignal.timeout(10000)});
    assert.equal(response.status,200);
    const health=await response.json();assert.equal(health.status,'ok');
    assert.equal(health.clientVersion,'1.9.0-RC2.0.20231116103301-d5f425e46b4b');
    console.log('PASS Apache ledger schema and exact linked native verifier; real receipt proof checks remain mandatory.');
  } catch(error) {
    // Static phase and machine code only; no SQL, credentials or stack output.
    const code=/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'CHECK_FAILED';
    console.error('IMMUDB_BOOTSTRAP_FAILED phase='+phase+' code='+code);throw error;
  } finally {await pool.end();}
}
if(require.main===module) bootstrap().catch(()=>{console.error('IMMUDB_BOOTSTRAP_FAILED: check pinned server, schema and credentials.');process.exitCode=1;});
module.exports={bootstrap};
