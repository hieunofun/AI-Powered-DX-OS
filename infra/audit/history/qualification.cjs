// Called only by the disposable two-ledger/PostgreSQL qualification test.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Pool}=require('pg');
const {buildPackage}=require('../../../apps/api/dist/audit/domain/audit-package');
const {ImmudbClient}=require('../../../apps/api/dist/audit/immudb/immudb.client');
const {main,exportRecords,verifyArchive,filename,sha}=require('./migrate.cjs');
const database='ledger_history_qualification';
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
const time='2026-10-14T00:00:00.000000Z';
async function run() {
  assert.ok(process.env.POSTGRES_HOST,'A real isolated PostgreSQL is required');
  assert.equal(process.env.IMMUDB_PASSWORD,'disposable-ledger-qualification-only');
  const [mode,file,dir]=process.argv.slice(2);
  const config={host:process.env.POSTGRES_HOST,port:Number(process.env.POSTGRES_PORT||5432),user:'qualification',password:'disposable-postgres-qualification-only'};
  if(mode==='prepare') {
    const admin=new Pool({...config,database:'postgres'});
    try {await admin.query('CREATE DATABASE '+database);}finally{await admin.end();}
    const records=ids.map(id=>{
      const evidence={supplier:{id,tax_code:'123'},po:{id,total_amount:'100.00'},poItems:[{id,line_number:1,unit_price:'100.0000'}],
        grns:[],grnItems:[],invoice:{id,status:'READY_FOR_PAYMENT'},invoiceItems:[],files:[],
        match:{id,status:'PASSED',completed_at:time},matchItems:[],approvalCase:null,tasks:[],decisions:[],events:[]};
      const built=buildPackage(evidence,time,time,'FINALIZATION');
      return {package:{id,invoice_id:id,package_version:built.manifest.packageVersion,package_json:built.manifest,
        package_sha256:built.packageSha256,merkle_root:built.manifest.merkleRoot,final_business_state:'READY_FOR_PAYMENT'},
      seal:{id,invoice_id:id,audit_package_id:id,status:'SEALED',seal_key:'smartprocure:audit:invoice:'+id+':v1',
        package_sha256:built.packageSha256,merkle_root:built.manifest.merkleRoot}};
    });
    await fs.writeFile(file,JSON.stringify(records));return;
  }
  process.env.POSTGRES_DB=database;process.env.POSTGRES_USER='qualification';process.env.POSTGRES_PASSWORD=config.password;
  const db=new Pool({...config,database});
  try {
    const records=JSON.parse(await fs.readFile(file));
    if(mode==='persist') {
      // Minimal real tables expose the same row_to_json export contract. Full
      // business schema/immutability guards remain covered by the main stack CI.
      await db.query(`CREATE TABLE audit_packages(id text PRIMARY KEY,invoice_id text,package_version text,package_json jsonb,
        package_sha256 text,merkle_root text,final_business_state text);
        CREATE TABLE audit_seals(id text PRIMARY KEY,invoice_id text,audit_package_id text,status text,seal_key text,
        package_sha256 text,merkle_root text,immudb_tx_id text,immudb_tx_hash text,immudb_state_tx_id text,immudb_state_hash text,receipt jsonb);
        CREATE TABLE audit_finalizations(status text);`);
      for(const record of records) {
        const p=record.package,s=record.seal;
        await db.query('INSERT INTO audit_packages SELECT * FROM jsonb_populate_record(NULL::audit_packages,$1)',[JSON.stringify(p)]);
        await db.query('INSERT INTO audit_seals SELECT * FROM jsonb_populate_record(NULL::audit_seals,$1)',[JSON.stringify(s)]);
      }
      return;
    }
    const snapshot=async()=>sha(JSON.stringify((await db.query('SELECT row_to_json(s) AS seal,row_to_json(p) AS package FROM audit_seals s JOIN audit_packages p ON p.id=s.audit_package_id ORDER BY s.seal_key')).rows));
    const before=await snapshot();
    if(mode==='export') {
      await main(['inventory']);await main(['export',dir]);
      const pin=sha(await fs.readFile(path.join(dir,'manifest.json')));
      await main(['export',dir]);await main(['verify',dir,pin]);await main(['restore',dir,pin,dir+'-restore']);
      await assert.rejects(verifyArchive(dir,'a'.repeat(64),process.env.IMMUDB_HISTORY_VERIFIER_BINARY));
      const persisted=(await db.query('SELECT row_to_json(s) AS seal,row_to_json(p) AS package FROM audit_seals s JOIN audit_packages p ON p.id=s.audit_package_id ORDER BY s.seal_key')).rows.map(r=>({...r,receipt:r.seal.receipt}));
      let count=0;
      await assert.rejects(exportRecords(persisted,dir+'-interrupted',process.env.IMMUDB_HISTORY_VERIFIER_BINARY,async()=>{if(++count===2)throw Error('interrupted');}));
      await assert.rejects(fs.access(path.join(dir+'-interrupted','manifest.json')));
      const resumed=await exportRecords(persisted,dir+'-interrupted',process.env.IMMUDB_HISTORY_VERIFIER_BINARY);
      await verifyArchive(dir+'-interrupted',resumed,process.env.IMMUDB_HISTORY_VERIFIER_BINARY);
      const bad=structuredClone(persisted);bad[0].package.package_json.evidence.po.total_amount='999.00';
      await assert.rejects(exportRecords(bad,dir+'-tampered',process.env.IMMUDB_HISTORY_VERIFIER_BINARY));
      await fs.writeFile(dir+'-pin.txt',pin);
      console.log('PASS real PostgreSQL inventory/export, native old-ledger comparison, idempotence, interrupted export, isolated restore and original decimal/package/receipt preservation');
    } else if(mode==='cutover') {
      const adapter=new ImmudbClient();
      try {
        const current=JSON.parse(await fs.readFile(file+'.new.json'));
        const active=await adapter.proof(current.seal_key,current);
        assert.equal(active.ledgerEpoch,'apache-d5f425e-opendx-1');assert.equal(active.serverUUID,current.receipt.serverUUID);
        assert.equal(active.txId,current.immudb_tx_id);assert.equal(active.txHash,current.immudb_tx_hash);
        assert.deepEqual(await adapter.get(current.seal_key,current),active.entry);
        for(const record of records) {
          const proof=await adapter.proof(record.seal.seal_key,record.seal);
          assert.equal(proof.txId,record.seal.immudb_tx_id);assert.equal(proof.txHash,record.seal.immudb_tx_hash);
          assert.equal(proof.ledgerEpoch,'pr3-archive');
          assert.deepEqual(await adapter.get(record.seal.seal_key,record.seal),proof.entry);
          const forged={...record.seal,immudb_state_hash:'f'.repeat(64)};
          await assert.rejects(adapter.proof(record.seal.seal_key,forged));
        }
        const archiveFile=path.join(dir,filename(records[0].seal.seal_key)),raw=await fs.readFile(archiveFile);
        await fs.writeFile(archiveFile,Buffer.concat([raw,Buffer.from(' ')]));
        await assert.rejects(adapter.get(records[0].seal.seal_key,records[0].seal));
        await fs.writeFile(archiveFile,raw);
        await fs.rename(archiveFile,archiveFile+'.missing');
        await assert.rejects(adapter.proof(records[0].seal.seal_key,records[0].seal));
        await fs.rename(archiveFile+'.missing',archiveFile);
        console.log('PASS real adapter verifies old and new epochs together; copied active rows cannot replace originals; corrupt/missing archives and forged anchors fail closed');
      } finally{await adapter.onModuleDestroy();}
    } else throw Error('Unknown mode');
    assert.equal(await snapshot(),before,'Migration must not update any historical PostgreSQL package or receipt');
  } finally{await db.end();}
}
run().catch(error=>{console.error('Historical migration qualification: '+error.message);process.exitCode=1;});
