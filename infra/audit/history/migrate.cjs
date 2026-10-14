// Read-only PostgreSQL/ledger inventory. No SQL writes, volume deletion or reseal.
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {Pool}=require('pg');
const {inspectPackage}=require('../../../apps/api/dist/audit/domain/audit-package');
const {immudbOptions,LEDGER_COLUMNS,normalizeLedgerRow,entryMatches}=require('../../../apps/api/dist/audit/immudb/immudb.client');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const filename=key=>sha(key)+'.json';
const anchor=seal=>({sealKey:seal.seal_key,txId:seal.immudb_tx_id,txHash:seal.immudb_tx_hash,
  stateTxId:seal.immudb_state_tx_id,stateHash:seal.immudb_state_hash});
function offline(record,binary) {
  const pkg=record.package,seal=record.seal,checked=inspectPackage(pkg.package_json);
  if(!checked.manifestMatches || checked.packageSha256!==pkg.package_sha256 || checked.merkleRoot!==pkg.merkle_root ||
    seal.status!=='SEALED' || JSON.stringify(record.receipt)!==JSON.stringify(seal.receipt) ||
    pkg.package_json.invoiceId!==pkg.invoice_id || pkg.package_json.packageVersion!==pkg.package_version ||
    !entryMatches(record.receipt.entry,pkg,seal)) throw Error('Historical package/receipt mismatch');
  execFileSync(binary,['verify-history-file'],{input:JSON.stringify({receipt:record.receipt,anchor:anchor(seal)}),
    encoding:'utf8',timeout:15000,maxBuffer:1024*1024,stdio:['pipe','pipe','pipe']});
}
async function writeOnce(target,bytes) {
  try {await fs.writeFile(target,bytes,{flag:'wx',mode:0o600});}
  catch(error) {if(error.code!=='EEXIST' || !(await fs.readFile(target)).equals(Buffer.from(bytes))) throw error;}
}
async function exportRecords(records,dir,binary,live) {
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  const entries={};
  for(const record of records) {
    offline(record,binary);
    const identity=live?await live(record):undefined;
    const raw=JSON.stringify(identity?{...record,sourceServerUUID:identity}:record)+'\n',key=record.seal.seal_key;
    if(entries[key]) throw Error('Duplicate seal key');
    await writeOnce(path.join(dir,filename(key)),raw); entries[key]=sha(raw);
  }
  const manifest=JSON.stringify({version:'OPENDX-HISTORY-1',count:records.length,entries:Object.fromEntries(Object.entries(entries).sort())})+'\n';
  // Publish only after every receipt and live identity has passed. Partial files
  // from interruption cannot become a valid archive without this manifest/pin.
  await writeOnce(path.join(dir,'manifest.json'),manifest);
  return sha(manifest);
}
async function verifyArchive(dir,pin,binary) {
  if(!/^[0-9a-f]{64}$/.test(pin||'')) throw Error('An independently retained manifest SHA-256 is required');
  const raw=await fs.readFile(path.join(dir,'manifest.json'));
  if(sha(raw)!==pin) throw Error('Manifest hash mismatch');
  const manifest=JSON.parse(raw);
  if(manifest.version!=='OPENDX-HISTORY-1' || Object.keys(manifest.entries).length!==manifest.count) throw Error('Invalid manifest');
  for(const [key,hash] of Object.entries(manifest.entries)) {
    const raw=await fs.readFile(path.join(dir,filename(key)));
    if(sha(raw)!==hash) throw Error('Archive record hash mismatch');
    const record=JSON.parse(raw);
    if(record.seal.seal_key!==key) throw Error('Archive key mismatch');
    offline(record,binary);
  }
  return manifest;
}
async function main(args=process.argv.slice(2)) {
  const mode=args[0]||'inventory',dir=args[1],pin=args[2],binary=process.env.IMMUDB_HISTORY_VERIFIER_BINARY;
  if(['verify','restore'].includes(mode)) {
    const manifest=await verifyArchive(dir,pin,binary);
    if(mode==='restore') {
      const destination=args[3];if(!destination) throw Error('Separate restore destination required');
      if(path.resolve(dir)===path.resolve(destination)) throw Error('Restore must be isolated');
      await fs.mkdir(destination,{recursive:true,mode:0o700});
      for(const key of Object.keys(manifest.entries)) await writeOnce(path.join(destination,filename(key)),await fs.readFile(path.join(dir,filename(key))));
      await writeOnce(path.join(destination,'manifest.json'),await fs.readFile(path.join(dir,'manifest.json')));
      await verifyArchive(destination,pin,binary);
    }
    console.log(JSON.stringify({mode,count:manifest.count,manifestSha256:pin,verified:true}));return;
  }
  if(!['inventory','export'].includes(mode)) throw Error('Use inventory, export, verify or restore');
  const db=new Pool({host:process.env.POSTGRES_HOST||'localhost',port:Number(process.env.POSTGRES_PORT||5432),
    database:process.env.POSTGRES_DB||'smartprocure_db',user:process.env.POSTGRES_USER||'smartprocure_user',password:process.env.POSTGRES_PASSWORD});
  const ledger=new Pool(immudbOptions());const c=await db.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // IDs/hashes remain strings. Preserve original jsonb values, including the
    // original receipt; do not replace them with a fresh native proof response.
    const seals=(await c.query("SELECT row_to_json(s) AS seal,row_to_json(p) AS package FROM audit_seals s JOIN audit_packages p ON p.id=s.audit_package_id ORDER BY s.seal_key")).rows;
    const rows=(await ledger.query('SELECT '+LEDGER_COLUMNS+' FROM smartprocure_audit_seals')).rows.map(normalizeLedgerRow);
    const pending=(await c.query("SELECT count(*)::text AS count FROM audit_finalizations WHERE status<>'BUILT'")).rows[0].count;
    const ready=seals.every(record=>record.seal.status==='SEALED') && pending==='0' && rows.length===seals.length;
    console.log(JSON.stringify({mode,seals:seals.length,ledgerRows:rows.length,pendingFinalizations:pending,ready}));
    if(mode==='inventory') return;
    if(!ready || !dir || !binary) throw Error('Cutover requires reconciliation, an export directory and the native verifier binary');
    const records=seals.map(record=>({...record,receipt:record.seal.receipt}));
    const pin=await exportRecords(records,dir,binary,async record=>{
      const entry=rows.find(row=>row.seal_key===record.seal.seal_key);
      if(!entryMatches(entry,record.package,record.seal)) throw Error('Historical live ledger identity mismatch');
      const response=await fetch((process.env.IMMUDB_VERIFIER_URL||'http://localhost:8081')+'/verify',{
        method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.IMMUDB_VERIFIER_TOKEN},
        body:JSON.stringify({sealKey:record.seal.seal_key,stateTxId:record.seal.immudb_state_tx_id,stateHash:record.seal.immudb_state_hash,
          serverUUID:record.receipt.serverUUID}),signal:AbortSignal.timeout(15000)});
      if(response.status!==200) throw Error('Historical live native proof failed');
      const proof=await response.json();
      if(proof.verified!==true || proof.txId!==record.seal.immudb_tx_id || proof.txHash!==record.seal.immudb_tx_hash ||
        !entryMatches(proof.entry,record.package,record.seal)) throw Error('Historical live transaction identity mismatch');
      if(!/^[a-z0-9-]+$/.test(proof.serverUUID||'')) throw Error('Historical live server identity missing');
      return proof.serverUUID;
    });
    await verifyArchive(dir,pin,binary);console.log(JSON.stringify({mode:'export',count:records.length,manifestSha256:pin,verified:true}));
  } finally {await c.query('ROLLBACK');c.release();await db.end();await ledger.end();}
}
if(require.main===module) main().catch(()=>{console.error('HISTORY_MIGRATION_FAILED: archive was not accepted; retain all original volumes and receipts.');process.exitCode=1;});
module.exports={exportRecords,verifyArchive,filename,sha,offline,main};
