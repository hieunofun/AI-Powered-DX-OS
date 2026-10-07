// REAL disposable CI stack. Never run the fault/tamper probes against production.
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {mkdtempSync,writeFileSync,readFileSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {Pool}=require('pg');
const {Client:MinioClient}=require('minio');
const {buildPackage}=require('../../apps/api/dist/audit/domain/audit-package');
const {hashJson}=require('../../apps/api/dist/audit/domain/canonical-json');
const db=new Pool({host:'localhost',port:Number(process.env.POSTGRES_PORT||5432),database:process.env.POSTGRES_DB||'smartprocure_db',
  user:process.env.POSTGRES_USER||'smartprocure_user',password:process.env.POSTGRES_PASSWORD||'postgres_password',connectionTimeoutMillis:5000});
const ledger=new Pool({host:'localhost',port:Number(process.env.IMMUDB_HOST_PGSQL_PORT||5433),database:process.env.IMMUDB_DATABASE||'defaultdb',
  user:process.env.IMMUDB_USERNAME||'immudb',password:process.env.IMMUDB_PASSWORD||'immudb_dev_only_password',connectionTimeoutMillis:5000,query_timeout:10000});
ledger.on('error',()=>{});
const tokens={},gateway=process.env.GATEWAY_URL||'http://localhost:9080';
const work=mkdtempSync(join(tmpdir(),'smartprocure-audit-'));
let receiptFault=false,stopped=false;
const docker=args=>execFileSync('docker',['compose',...args],{encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe']});
async function login(role,user){
  const response=await fetch('http://localhost:8080/realms/smartprocure/protocol/openid-connect/token',{method:'POST',signal:AbortSignal.timeout(20000),
    body:new URLSearchParams({client_id:'smartprocure-ci',grant_type:'password',username:user,password:process.env.DEMO_PASSWORD||'DemoPassword123!'})});
  assert.equal(response.status,200,'Real Keycloak login');tokens[role]=(await response.json()).access_token;
}
async function api(method,path,role='accountant',body){
  for(let attempt=0;attempt<31;attempt++){
    const form=body instanceof FormData;
    const response=await fetch(gateway+'/api'+path,{method,signal:AbortSignal.timeout(90000),
      headers:{...(role?{Authorization:'Bearer '+tokens[role]}:{}),...(body&&!form?{'Content-Type':'application/json'}:{})},
      ...(body===undefined?{}:{body:form?body:JSON.stringify(body)})});
    if(response.status===429 && attempt<30){await response.arrayBuffer();await new Promise(r=>setTimeout(r,2000));continue;}
    if(response.headers.get('content-type')?.includes('application/pdf')) return {status:response.status,headers:response.headers,bytes:Buffer.from(await response.arrayBuffer())};
    const text=await response.text();let value;try{value=JSON.parse(text);}catch{value={invalidResponse:true};}
    return {status:response.status,headers:response.headers,body:value};
  }
}
async function request(method,path,role,body,status=200){
  const result=await api(method,path,role,body);assert.equal(result.status,status,method+' '+path+' '+JSON.stringify(result.body));return result.body;
}
const base=id=>'/audit/invoices/'+id;
async function fixture(mismatch=false){
  const suffix=randomUUID(),tax='010'+Date.now()+Math.floor(Math.random()*100000),price=mismatch?'120.00':'100.00';
  const supplier=(await db.query('INSERT INTO suppliers(supplier_code,tax_code,name) VALUES($1,$2,$3) RETURNING id',['AUD-'+suffix,tax,'Công ty Audit Việt Nam'])).rows[0].id;
  const po=(await db.query(`INSERT INTO purchase_orders(po_number,supplier_id,status,order_date,subtotal,tax_amount,total_amount)
    VALUES($1,$2,'FULLY_RECEIVED',CURRENT_DATE,100,0,100) RETURNING id`,['AUD-PO-'+suffix,supplier])).rows[0].id;
  const poItem=(await db.query(`INSERT INTO purchase_order_items(purchase_order_id,line_number,sku,description,ordered_quantity,unit_price,tax_rate,line_subtotal,tax_amount,line_total)
    VALUES($1,1,'AUDIT-SKU','Audit goods',1,100,0,100,0,100) RETURNING id`,[po])).rows[0].id;
  const grn=(await db.query("INSERT INTO goods_receipts(grn_number,purchase_order_id,status) VALUES($1,$2,'RECEIVED') RETURNING id",['AUD-GRN-'+suffix,po])).rows[0].id;
  await db.query(`INSERT INTO goods_receipt_items(goods_receipt_id,purchase_order_item_id,line_number,received_quantity,accepted_quantity,rejected_quantity,lot_number)
    VALUES($1,$2,1,1,1,0,'AUDIT-LOT')`,[grn,poItem]);
  const xml=Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><SmartProcureInvoice version="1">
    <NguoiBan><MST>${tax}</MST></NguoiBan><NguoiMua><MST>0312345678</MST></NguoiMua>
    <ThongTinChung><SHDon>AUD-INV-${suffix}</SHDon><NLap>2026-10-06</NLap><DVTTe>VND</DVTTe></ThongTinChung>
    <DanhSachHangHoa><HangHoa><MHHDVu>AUDIT-SKU</MHHDVu><THHDVu>Audit goods</THHDVu><SLuong>1</SLuong><DGia>${price}</DGia><TSuat>0</TSuat><ThTien>${price}</ThTien><TienThue>0</TienThue><TongTien>${price}</TongTien></HangHoa></DanhSachHangHoa>
    <TongTien><TgTCThue>${price}</TgTCThue><TgTThue>0</TgTThue><TgTTTBSo>${price}</TgTTTBSo></TongTien></SmartProcureInvoice>`);
  const form=new FormData();form.set('purchaseOrderId',po);form.set('xml',new Blob([xml],{type:'application/xml'}),'audit.xml');
  const ingested=await request('POST','/invoices/ingest','accountant',form,201),invoiceId=ingested.invoiceId;
  await request('POST','/invoices/'+invoiceId+'/match','accountant');
  const row=(await db.query('SELECT status FROM invoices WHERE id=$1',[invoiceId])).rows[0];
  assert.equal(row.status,mismatch?'EXCEPTION':'MATCHED');
  return {invoiceId,po,poItem,grn,xml,ingestionId:ingested.ingestionId};
}
async function sealed(invoiceId,state){
  const verification=await request('GET',base(invoiceId)+'/verify','accountant');
  assert.equal(verification.verificationStatus,'VERIFIED');assert.equal(verification.immudbCryptographicProofValid,true);
  const detail=await request('GET',base(invoiceId),'accountant');
  assert.equal(detail.pkg.final_business_state,state);assert.equal(detail.seal.status,'SEALED');
  assert.ok(detail.seal.immudb_tx_id);assert.ok(detail.seal.receipt.rowProof);assert.ok(detail.seal.receipt.transactionHeader);
  const e=detail.pkg.package_json.evidence;
  assert.ok(e.po&&e.invoice&&e.match);assert.equal(e.grns.length,1);assert.equal(e.matchItems.length,1);assert.equal(e.files.length,1);
  assert.match(e.files[0].sha256,/^[0-9a-f]{64}$/);
  for(const field of ['password','authorization','access_token','secret_key']) assert.ok(!JSON.stringify(e).toLowerCase().includes('"'+field+'"'));
  const rebuilt=buildPackage(e,detail.pkg.package_json.builtAt,detail.pkg.package_json.capturedAt,detail.pkg.package_json.captureMode);
  assert.equal(rebuilt.packageSha256,detail.pkg.package_sha256);assert.equal(rebuilt.manifest.merkleRoot,detail.pkg.merkle_root);
  assert.equal(buildPackage(e,detail.pkg.package_json.builtAt,detail.pkg.package_json.capturedAt,detail.pkg.package_json.captureMode).manifest.merkleRoot,rebuilt.manifest.merkleRoot);
  assert.equal((await ledger.query('SELECT seal_key FROM smartprocure_audit_seals WHERE seal_key=$1',[detail.seal.seal_key])).rows.length,1);
  return {verification,detail};
}
async function terminal(action,concurrent=false){
  const input=await fixture(true);const started=await request('POST','/invoices/'+input.invoiceId+'/workflow/start','accountant');
  await request('POST',base(input.invoiceId)+'/seal','admin',undefined,409);
  const tasks=await request('GET','/approval-cases/'+started.approvalCaseId+'/tasks','buyer');
  assert.equal(tasks.length,1);assert.equal(tasks[0].assignedRole,'buyer');
  await request('POST','/approval-tasks/'+tasks[0].id+'/claim','buyer');
  const reason='Audit acceptance '+action;
  if(concurrent){
    const attempts=await Promise.all([api('POST','/approval-tasks/'+tasks[0].id+'/complete','buyer',{action,reason}),
      api('POST','/approval-tasks/'+tasks[0].id+'/complete','buyer',{action,reason})]);
    assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
  }else await request('POST','/approval-tasks/'+tasks[0].id+'/complete','buyer',{action,reason});
  const state=action==='REJECT'?'REJECTED':action==='REQUEST_CREDIT_NOTE'?'CREDIT_NOTE_REQUESTED':'READY_FOR_PAYMENT';
  const result=await sealed(input.invoiceId,state),e=result.detail.pkg.package_json.evidence;
  assert.equal(e.tasks.length,1);assert.equal(e.decisions.length,1);assert.equal(e.decisions[0].action,action);assert.equal(e.decisions[0].reason,reason);
  assert.equal(e.approvalCase.id,started.approvalCaseId);
  assert.equal((await db.query('SELECT count(*) FROM approval_decisions WHERE approval_case_id=$1',[started.approvalCaseId])).rows[0].count,'1');
  assert.equal((await db.query('SELECT count(*) FROM audit_packages WHERE invoice_id=$1',[input.invoiceId])).rows[0].count,'1');
  assert.equal((await db.query('SELECT count(*) FROM audit_seals WHERE invoice_id=$1',[input.invoiceId])).rows[0].count,'1');
  if(action==='REQUEST_CREDIT_NOTE') assert.equal(e.invoice.status,'EXCEPTION');
  if(action==='APPROVE_WITH_ADJUSTMENT') assert.equal(e.invoice.total_amount,'120.00');
  console.log('PASS automatic terminal seal '+action+' with real Flowable decision history'+(concurrent?' and concurrent finalization: one decision/package/seal':''));return input;
}
async function pdfText(invoiceId,want){
  const response=await api('GET',base(invoiceId)+'/report.pdf');assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/application\/pdf/);
  assert.equal(response.bytes.subarray(0,5).toString(),'%PDF-');assert.ok(response.bytes.length>1000);
  const path=join(work,want+'.pdf');writeFileSync(path,response.bytes);
  const text=execFileSync('pdftotext',['-layout',path,'-'],{encoding:'utf8'});
  for(const field of ['SmartProcure-Pay Audit Verification Report','Invoice','PO','Supplier','Final State','Package Version','Package SHA-256','Merkle Root','ImmuDB Transaction ID','Verified At','Leaf count',want]) assert.ok(text.includes(field),'PDF missing '+field);
  assert.ok(text.includes('Công ty Audit Việt Nam'),'Unicode supplier rendering');
  if(want!=='VERIFIED') assert.ok(text.includes('WARNING'));
  const attachment=join(work,want+'-paired.json');
  execFileSync('pdfdetach',['-save','1','-o',attachment,path],{stdio:'pipe'});
  const {reportPayloadSha256,...paired}=JSON.parse(readFileSync(attachment,'utf8'));
  assert.equal(hashJson(paired),reportPayloadSha256);assert.equal(paired.verificationStatus,want);
  assert.ok(text.replace(/\s/g,'').includes(reportPayloadSha256),'Printed PDF hash must match its exact extracted JSON attachment');
}
async function restorePoItem(id,original){
  const c=await db.connect();try{await c.query('BEGIN');await c.query("SET LOCAL session_replication_role='replica'");
    await c.query('UPDATE purchase_order_items SET unit_price=$2,updated_at=$3 WHERE id=$1',[id,original.unit_price,original.updated_at]);await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
}
async function main(){
  await Promise.all([['admin','admin.demo'],['accountant','accountant.demo'],['finance_manager','finance.demo'],['buyer','buyer.demo'],['warehouse','warehouse.demo']].map(([r,u])=>login(r,u)));
  const stp=await fixture();
  await request('POST',base(stp.invoiceId)+'/seal','admin',undefined,409);
  const start=await request('POST','/invoices/'+stp.invoiceId+'/workflow/start','accountant');assert.equal(start.route,'STP');
  const {verification,detail}=await sealed(stp.invoiceId,'READY_FOR_PAYMENT');
  assert.equal(detail.pkg.package_json.evidence.approvalCase,null);assert.equal(detail.pkg.package_json.evidence.decisions.length,0);
  console.log('PASS clean STP automatically creates one complete deterministic package, ledger seal and native cryptographic proof');
  // These exact-version SQL wrappers prove real function dispatch and identity;
  // the separate native proof above remains the cryptographic authority.
  assert.match(detail.seal.seal_key,/^smartprocure:audit:invoice:[0-9a-f-]{36}:v1$/);
  assert.match(detail.seal.immudb_tx_id,/^[1-9]\d*$/);
  const wireRow=(await ledger.query("SELECT immudb_verify_row('smartprocure_audit_seals', '"+detail.seal.seal_key+"')")).rows[0];
  const wireTx=(await ledger.query('SELECT immudb_verify_tx('+detail.seal.immudb_tx_id+')')).rows[0];
  assert.equal(wireRow.verified,'true');assert.equal(String(wireRow.tx_id),detail.seal.immudb_tx_id);
  assert.equal(wireTx.verified,'true');assert.equal(String(wireTx.tx_id),detail.seal.immudb_tx_id);
  console.log('PASS exact v1.11.0 immudb_verify_row/immudb_verify_tx signatures against the real sealed row/transaction');
  const file=detail.pkg.package_json.evidence.files[0];
  const minio=new MinioClient({endPoint:'localhost',port:Number(process.env.MINIO_PORT||9000),useSSL:false,
    accessKey:process.env.MINIO_ACCESS_KEY||'minio_dev_only',secretKey:process.env.MINIO_SECRET_KEY||'minio_dev_password_only'});
  const stream=await minio.getObject(process.env.MINIO_BUCKET_INVOICES||'invoices',file.object_key),hash=createHash('sha256');
  for await(const chunk of stream) hash.update(chunk);
  assert.equal(hash.digest('hex'),file.sha256);assert.equal(createHash('sha256').update(stp.xml).digest('hex'),file.sha256);
  assert.equal((await db.query('SELECT sha256 FROM invoice_files WHERE id=$1',[file.id])).rows[0].sha256,file.sha256);
  console.log('PASS raw private MinIO bytes SHA-256 = invoice_files.sha256 = sealed file evidence');
  for(const role of ['admin','accountant','finance_manager']) await request('GET',base(stp.invoiceId)+'/verify',role);
  for(const role of ['buyer','warehouse']) for(const suffix of ['','/verify','/report.json','/report.pdf']) await request('GET',base(stp.invoiceId)+suffix,role,undefined,403);
  await request('GET',base(stp.invoiceId)+'/verify',null,undefined,401);
  await request('POST',base(stp.invoiceId)+'/seal','accountant',undefined,403);
  await request('POST',base(stp.invoiceId)+'/seal','admin',{merkleRoot:'forged'},400);
  console.log('PASS authenticated audit RBAC 401/403 and immutable client-input boundary');
  const jsonResponse=await api('GET',base(stp.invoiceId)+'/report.json');assert.equal(jsonResponse.status,200);assert.match(jsonResponse.headers.get('content-type'),/json/);
  const {reportPayloadSha256,...payload}=jsonResponse.body;assert.equal(hashJson(payload),reportPayloadSha256);
  assert.equal(payload.verificationStatus,'VERIFIED');assert.equal(payload.packageSha256,detail.pkg.package_sha256);assert.equal(payload.immudb.txId,detail.seal.immudb_tx_id);
  await pdfText(stp.invoiceId,'VERIFIED');console.log('PASS JSON payload hash and PDFKit PDF parsed with Poppler (including Unicode and required fields)');
  await terminal('APPROVE',true);await terminal('APPROVE_WITH_ADJUSTMENT');await terminal('REJECT');await terminal('REQUEST_CREDIT_NOTE');
  const original=(await db.query('SELECT unit_price,updated_at::text FROM purchase_order_items WHERE id=$1',[stp.poItem])).rows[0];
  try{
    await db.query('UPDATE purchase_order_items SET unit_price=777 WHERE id=$1',[stp.poItem]);
    const tampered=await request('GET',base(stp.invoiceId)+'/verify');assert.equal(tampered.verificationStatus,'TAMPERED');assert.notEqual(tampered.currentRoot,tampered.sealedRoot);
    assert.equal(tampered.immudbCryptographicProofValid,true);assert.equal(tampered.immudbEntryMatches,true);
    assert.equal((await request('GET',base(stp.invoiceId)+'/report.json')).verificationStatus,'TAMPERED');await pdfText(stp.invoiceId,'TAMPERED');
    console.log('PASS relational tamper -> HTTP 200 TAMPERED; original ledger proof still valid; JSON/PDF visibly warn');
  }finally{await restorePoItem(stp.poItem,original);}
  await request('GET',base(stp.invoiceId)+'/verify');
  await assert.rejects(db.query("UPDATE audit_packages SET package_json='{}' WHERE id=$1",[detail.pkg.id]),e=>e.code==='23514');
  const c=await db.connect();
  try{
    await c.query('BEGIN');await c.query("SET LOCAL session_replication_role='replica'");
    await c.query("UPDATE audit_packages SET package_json=jsonb_set(package_json,'{evidence,invoice,total_amount}','\"999.00\"') WHERE id=$1",[detail.pkg.id]);await c.query('COMMIT');
    const corrupt=await request('GET',base(stp.invoiceId)+'/verify');assert.equal(corrupt.verificationStatus,'TAMPERED');assert.equal(corrupt.packageHashMatches,false);assert.equal(corrupt.merkleRootMatches,false);
  }finally{
    await c.query('BEGIN');await c.query("SET LOCAL session_replication_role='replica'");await c.query('UPDATE audit_packages SET package_json=$2::jsonb WHERE id=$1',[detail.pkg.id,JSON.stringify(detail.pkg.package_json)]);await c.query('COMMIT');c.release();
  }
  console.log('PASS package guard rejects mutation; controlled disposable bypass is independently detected');
  await db.query('UPDATE audit_seals SET immudb_tx_hash=$2 WHERE id=$1',[detail.seal.id,'f'.repeat(64)]);
  assert.equal((await request('GET',base(stp.invoiceId)+'/verify')).verificationStatus,'LEDGER_MISMATCH');
  await db.query('UPDATE audit_seals SET immudb_tx_hash=$2 WHERE id=$1',[detail.seal.id,detail.seal.immudb_tx_hash]);
  console.log('PASS ledger receipt mismatch -> LEDGER_MISMATCH, never VERIFIED');
  const outage=await fixture();docker(['stop','smartprocure-immudb']);stopped=true;
  await request('POST','/invoices/'+outage.invoiceId+'/workflow/start','accountant');
  const pending=(await db.query('SELECT f.invoice_id,s.status,s.immudb_tx_id FROM audit_finalizations f JOIN audit_seals s ON s.invoice_id=f.invoice_id WHERE f.invoice_id=$1',[outage.invoiceId])).rows[0];
  assert.ok(pending);assert.ok(['PENDING','FAILED'].includes(pending.status));assert.equal(pending.immudb_tx_id,null);
  await request('GET',base(outage.invoiceId)+'/verify','accountant',undefined,503);
  const report=docker(['exec','-T','smartprocure-api','node','infra/audit/reconcile-audit-seals.cjs','--invoice',outage.invoiceId]);assert.ok(report.includes('"mutations":0'));assert.ok(report.includes(outage.invoiceId));
  docker(['start','smartprocure-immudb']);stopped=false;
  for(let n=0;n<60;n++){try{await ledger.query('SELECT immudb_state()');break;}catch{if(n===59)throw Error('ImmuDB restart timeout');await new Promise(r=>setTimeout(r,1000));}}
  const attempts=await Promise.all([api('POST',base(outage.invoiceId)+'/seal','admin'),api('POST',base(outage.invoiceId)+'/seal','admin')]);
  assert.ok(attempts.some(r=>r.status===200));assert.ok(attempts.every(r=>[200,409].includes(r.status)));
  await sealed(outage.invoiceId,'READY_FOR_PAYMENT');
  assert.equal((await db.query('SELECT count(*) FROM audit_packages WHERE invoice_id=$1',[outage.invoiceId])).rows[0].count,'1');
  assert.equal((await db.query('SELECT count(*) FROM audit_seals WHERE invoice_id=$1',[outage.invoiceId])).rows[0].count,'1');
  console.log('PASS real stopped ImmuDB preserves durable intent, restart recovery and concurrent seal create exactly one package/key');
  const fault=await fixture();
  await db.query(`CREATE FUNCTION audit_ci_receipt_failure() RETURNS trigger AS $$ BEGIN
    IF NEW.invoice_id='${fault.invoiceId}'::uuid AND NEW.status='SEALED' THEN RAISE EXCEPTION 'disposable audit receipt failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
    CREATE TRIGGER trg_audit_ci_receipt_failure BEFORE UPDATE ON audit_seals FOR EACH ROW EXECUTE FUNCTION audit_ci_receipt_failure()`);receiptFault=true;
  await request('POST','/invoices/'+fault.invoiceId+'/workflow/start','accountant');
  const failSeal=(await db.query('SELECT * FROM audit_seals WHERE invoice_id=$1',[fault.invoiceId])).rows[0];assert.equal(failSeal.status,'FAILED');assert.equal(failSeal.immudb_tx_id,null);
  assert.equal((await ledger.query('SELECT seal_key FROM smartprocure_audit_seals WHERE seal_key=$1',[failSeal.seal_key])).rows.length,1);
  await db.query('DROP TRIGGER trg_audit_ci_receipt_failure ON audit_seals; DROP FUNCTION audit_ci_receipt_failure()');receiptFault=false;
  docker(['exec','-T','smartprocure-api','node','infra/audit/reconcile-audit-seals.cjs','--apply','--invoice',fault.invoiceId]);
  await sealed(fault.invoiceId,'READY_FOR_PAYMENT');console.log('PASS PostgreSQL receipt failure AFTER real ImmuDB INSERT recovers by stable key without duplicate');
  const historical=await fixture();await db.query("UPDATE invoices SET status='READY_FOR_PAYMENT' WHERE id=$1",[historical.invoiceId]);
  const before=(await db.query('SELECT count(*) FROM audit_packages WHERE invoice_id=$1',[historical.invoiceId])).rows[0].count;assert.equal(before,'0');
  const historicalReport=docker(['exec','-T','smartprocure-api','node','infra/audit/reconcile-audit-seals.cjs','--invoice',historical.invoiceId]);assert.ok(historicalReport.includes(historical.invoiceId));
  assert.equal((await db.query('SELECT count(*) FROM audit_packages WHERE invoice_id=$1',[historical.invoiceId])).rows[0].count,'0');
  docker(['exec','-T','smartprocure-api','node','infra/audit/reconcile-audit-seals.cjs','--apply','--invoice',historical.invoiceId]);
  const backfill=await sealed(historical.invoiceId,'READY_FOR_PAYMENT');assert.equal(backfill.detail.pkg.package_json.captureMode,'BACKFILL');
  console.log('PASS historical eligible data report-only discovery and explicit backfill');
  const repeated=await sealed(stp.invoiceId,'READY_FOR_PAYMENT');assert.equal(repeated.verification.currentRoot,verification.currentRoot);
  console.log('PERFORMANCE typical real one-line package '+JSON.stringify(repeated.verification.performance));
  console.log('PASS real immutable audit acceptance: no audit repository or ImmuDB mocks, no payment execution, no Semantic AI.');
}
main().catch(error=>{console.error(error instanceof assert.AssertionError?error.message:'Immutable audit acceptance failed: '+error.message);process.exitCode=1;}).finally(async()=>{
  if(stopped) try{docker(['start','smartprocure-immudb']);}catch{}
  if(receiptFault) try{await db.query('DROP TRIGGER IF EXISTS trg_audit_ci_receipt_failure ON audit_seals; DROP FUNCTION IF EXISTS audit_ci_receipt_failure()');}catch{}
  await db.end();await ledger.end();rmSync(work,{recursive:true,force:true});
});
