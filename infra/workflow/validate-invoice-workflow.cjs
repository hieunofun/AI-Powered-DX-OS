// Real Keycloak -> APISIX -> NestJS -> PostgreSQL -> Flowable acceptance.
// SQL creates immutable matching evidence only; no workflow repository or engine is mocked.
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {Pool}=require('pg');
const {engine}=require('./flowable-http.cjs');
const {bootstrap}=require('./bootstrap-flowable.cjs');
const db=new Pool({host:process.env.POSTGRES_HOST||'localhost',port:process.env.POSTGRES_PORT||5432,
  user:process.env.POSTGRES_USER||'smartprocure_user',password:process.env.POSTGRES_PASSWORD||'postgres_password',
  database:process.env.POSTGRES_DB||'smartprocure_db',connectionTimeoutMillis:5000});
const gateway=process.env.GATEWAY_URL||'http://localhost:9080';
const keycloak=process.env.KEYCLOAK_URL||'http://localhost:8080';
const actors={};
async function login(role,user){
  const res=await fetch(keycloak+'/realms/smartprocure/protocol/openid-connect/token',{method:'POST',signal:AbortSignal.timeout(20000),
    body:new URLSearchParams({client_id:process.env.CI_CLIENT_ID||'smartprocure-ci',grant_type:'password',username:user,password:process.env.DEMO_PASSWORD||'DemoPassword123!'})});
  assert.equal(res.status,200,'Real login '+role);
  const data=await res.json();
  actors[role]={token:data.access_token,sub:JSON.parse(Buffer.from(data.access_token.split('.')[1],'base64url')).sub};
}
async function api(method,path,role='accountant',body){
  for(let attempt=0;attempt<31;attempt++){
    const res=await fetch(gateway+'/api'+path,{method,signal:AbortSignal.timeout(90000),
      headers:{...(role?{Authorization:'Bearer '+actors[role].token}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    const text=await res.text();
    if(res.status===429&&attempt<30){await new Promise(r=>setTimeout(r,2000));continue;}
    let data;
    try{data=text?JSON.parse(text):{};}catch{data={gatewayRejected:true};}
    return {status:res.status,body:data};
  }
}
async function request(method,path,role,body,status=200){
  const res=await api(method,path,role,body);
  assert.equal(res.status,status,method+' '+path+' '+JSON.stringify(res.body));
  return res.body;
}
async function fixture(codes=[],total='100.00'){
  const supplier=(await db.query('SELECT id FROM suppliers ORDER BY created_at LIMIT 1')).rows[0].id;
  const po=(await db.query(`INSERT INTO purchase_orders(po_number,supplier_id,currency,status,order_date,subtotal,tax_amount,total_amount)
    VALUES($1,$2,'VND','ISSUED',CURRENT_DATE,$3,0,$3) RETURNING id`,['WF-PO-'+randomUUID(),supplier,total])).rows[0].id;
  const item=(await db.query(`INSERT INTO purchase_order_items(purchase_order_id,line_number,sku,description,ordered_quantity,unit_price,tax_rate,line_subtotal,tax_amount,line_total)
    VALUES($1,1,'WF-SKU','Workflow fixture',1,$2,0,$2,0,$2) RETURNING id`,[po,total])).rows[0].id;
  const invoiceId=(await db.query(`INSERT INTO invoices(invoice_number,supplier_id,purchase_order_id,invoice_date,status,subtotal,tax_amount,total_amount,source_type)
    VALUES($1,$2,$3,CURRENT_DATE,$4,$5,0,$5,'WORKFLOW_TEST_FIXTURE') RETURNING id`,
    ['WF-INV-'+randomUUID(),supplier,po,codes.length?'EXCEPTION':'MATCHED',total])).rows[0].id;
  const line=(await db.query(`INSERT INTO invoice_items(invoice_id,line_number,po_item_id,sku,description,quantity,unit_price,tax_rate,line_subtotal,tax_amount,line_total)
    VALUES($1,1,$2,'WF-SKU','Workflow fixture',1,$3,0,$3,0,$3) RETURNING id`,[invoiceId,item,total])).rows[0].id;
  const matchId=(await db.query(`INSERT INTO match_results(invoice_id,purchase_order_id,status,discrepancy_codes,rule_version,completed_at,policy_snapshot)
    VALUES($1,$2,$3,$4,'3WM-1.0',now(),'{"policyCode":"WORKFLOW_FIXTURE_MATCH","ruleVersion":"3WM-1.0"}') RETURNING id`,
    [invoiceId,po,codes.length?'REVIEW_REQUIRED':'PASSED',codes])).rows[0].id;
  await db.query(`INSERT INTO match_result_items(match_result_id,invoice_item_id,purchase_order_item_id,status,discrepancy_codes)
    VALUES($1,$2,$3,$4,$5)`,[matchId,line,item,codes.length?'MISMATCHED':'MATCHED',codes]);
  return {invoiceId,matchId};
}
const start=id=>request('POST','/invoices/'+id+'/workflow/start','accountant');
const detail=id=>request('GET','/approval-cases/'+id,'accountant');
const tasks=id=>request('GET','/approval-cases/'+id+'/tasks','accountant');
const claim=(id,role)=>request('POST','/approval-tasks/'+id+'/claim',role);
const complete=(id,role,action='APPROVE',reason)=>request('POST','/approval-tasks/'+id+'/complete',role,{action,...(reason===undefined?{}:{reason})});
async function active(caseId,role){
  const all=await tasks(caseId),open=all.filter(t=>['OPEN','CLAIMED'].includes(t.status));
  assert.equal(open.length,1); assert.equal(open[0].assignedRole,role);
  return open[0];
}
async function state(invoiceId){
  return (await db.query('SELECT status FROM invoices WHERE id=$1',[invoiceId])).rows[0].status;
}
async function audit(caseId,invoiceId,required){
  const rows=(await db.query(`SELECT event_type,actor_subject,metadata,created_at FROM audit_records
    WHERE entity_id=ANY($1::uuid[]) OR metadata->>'approvalCaseId'=$2 ORDER BY created_at`,[[caseId,invoiceId],caseId])).rows;
  for(const event of required) assert.ok(rows.some(r=>r.event_type===event),'Missing audit '+event);
  assert.ok(rows.every(r=>r.actor_subject&&Array.isArray(r.metadata.roles)&&r.created_at));
  return rows;
}
function docker(args){ return execFileSync('docker',['compose',...args],{encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe']}); }
async function recover(caseId){
  const op=(await db.query("SELECT id FROM workflow_operations WHERE approval_case_id=$1 AND status<>'APPLIED'",[caseId])).rows[0];
  assert.ok(op);
  const report=docker(['exec','-T','smartprocure-api','node','infra/workflow/reconcile-workflows.cjs','--operation',op.id]);
  assert.ok(report.includes('"mode":"report"')); assert.ok(report.includes('"mutations":0'));
  docker(['exec','-T','smartprocure-api','node','infra/workflow/reconcile-workflows.cjs','--apply','--operation',op.id]);
  assert.equal((await db.query('SELECT status FROM workflow_operations WHERE id=$1',[op.id])).rows[0].status,'APPLIED');
  const processes=await engine('/history/historic-process-instances?businessKey='+encodeURIComponent('approval-case:'+caseId));
  assert.equal(processes.data.length,1,'Recovery must preserve exactly one process');
  return op.id;
}
async function concurrent(invoiceId,work){
  const barrier=await db.connect();
  const pending=[];
  try{
    await barrier.query('BEGIN');
    await barrier.query('SELECT id FROM invoices WHERE id=$1 FOR UPDATE',[invoiceId]);
    pending.push(...work.map(fn=>fn()));
    let count=0;
    for(let i=0;i<150;i++){
      count=Number((await db.query(`SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
        AND wait_event_type='Lock' AND query LIKE '%FROM invoices WHERE id=$1 FOR UPDATE%'`)).rows[0].count);
      if(count>=2) break;
      await new Promise(r=>setTimeout(r,100));
    }
    assert.ok(count>=2,'Both real API requests reached the invoice row lock');
    await barrier.query('COMMIT');
    return await Promise.all(pending);
  }finally{
    await barrier.query('ROLLBACK');
    barrier.release();
    await Promise.allSettled(pending);
  }
}
async function main(){
  await Promise.all([['accountant','accountant.demo'],['admin','admin.demo'],['buyer','buyer.demo'],['warehouse','warehouse.demo'],['finance_manager','finance.demo']]
    .map(([role,user])=>login(role,user)));
  const initialPolicy=await request('GET','/workflow/policy','admin');
  assert.equal(initialPolicy.financeApprovalThreshold,'100000000.00'); assert.equal(initialPolicy.autoReadyForPaymentMaxAmount,null);
  const stp=await fixture();
  const clean=await start(stp.invoiceId);
  assert.equal(clean.route,'STP'); assert.equal(await state(stp.invoiceId),'READY_FOR_PAYMENT');
  assert.equal((await db.query('SELECT count(*) FROM approval_cases WHERE invoice_id=$1',[stp.invoiceId])).rows[0].count,'0');
  assert.equal((await db.query("SELECT count(*) FROM audit_records WHERE entity_id=$1 AND event_type='INVOICE_READY_FOR_PAYMENT'",[stp.invoiceId])).rows[0].count,'1');
  await request('POST','/invoices/'+stp.invoiceId+'/workflow/start','accountant',undefined,409);
  console.log('PASS clean STP without case/process, audited, repeated start 409');
  await request('POST','/invoices/'+stp.invoiceId+'/workflow/start',null,undefined,401);
  await request('POST','/invoices/'+stp.invoiceId+'/workflow/start','buyer',undefined,403);
  await request('POST','/invoices/'+stp.invoiceId+'/workflow/start','admin',{requiredRole:'admin'},400);
  console.log('PASS real unauthenticated 401, start-role 403 and untrusted body rejection');

  for(const [code,role,wrong] of [['PRICE_MISMATCH','buyer','warehouse'],['QUANTITY_MISMATCH','warehouse','buyer'],['TAX_MISMATCH','accountant','buyer']]){
    const input=await fixture([code]); const created=await start(input.invoiceId); const task=await active(created.approvalCaseId,role);
    assert.equal(await state(input.invoiceId),'EXCEPTION');
    await request('POST','/approval-tasks/'+task.id+'/claim',wrong,undefined,403);
    await request('POST','/approval-tasks/'+task.id+'/complete',role,{action:'APPROVE'},403);
    await claim(task.id,role); await claim(task.id,role); // same subject idempotent
    await complete(task.id,role);
    assert.equal(await state(input.invoiceId),'READY_FOR_PAYMENT'); assert.equal((await detail(created.approvalCaseId)).status,'APPROVED');
    const info=await detail(created.approvalCaseId);
    assert.equal(info.decisions.length,1); assert.equal(info.matchSnapshot.matchResultId,input.matchId);
    const process=await engine('/history/historic-process-instances/'+info.workflowInstanceId);
    assert.ok(process.endTime); assert.equal(process.endActivityId,'approved');
    await audit(info.id,input.invoiceId,['WORKFLOW_STARTED','APPROVAL_TASK_CREATED','APPROVAL_TASK_CLAIMED','APPROVAL_TASK_COMPLETED',
      'APPROVAL_CASE_APPROVED','INVOICE_APPROVED','INVOICE_READY_FOR_PAYMENT']);
    console.log('PASS '+code+' routes to '+role+', enforces ownership/RBAC, real engine completes and audits approval');
  }
  const multi=await fixture(['PRICE_MISMATCH','QUANTITY_MISMATCH','TAX_MISMATCH']);
  const multiCase=await start(multi.invoiceId);
  for(const role of ['warehouse','buyer','accountant']){
    const task=await active(multiCase.approvalCaseId,role); await claim(task.id,role); await complete(task.id,role);
    if(role!=='accountant') assert.equal(await state(multi.invoiceId),'EXCEPTION');
  }
  assert.equal(await state(multi.invoiceId),'READY_FOR_PAYMENT');
  assert.deepEqual((await tasks(multiCase.approvalCaseId)).map(t=>t.assignedRole),['warehouse','buyer','accountant']);
  console.log('PASS multi-discrepancy deterministic warehouse -> buyer -> accountant, no dropped responsibility');

  const finance=await fixture(['PRICE_MISMATCH'],'100000000.00');
  const financeCase=await start(finance.invoiceId);
  const buyerTask=await active(financeCase.approvalCaseId,'buyer'); await claim(buyerTask.id,'buyer'); await complete(buyerTask.id,'buyer');
  const financeTask=await active(financeCase.approvalCaseId,'finance_manager');
  for(const role of ['buyer','warehouse','accountant']) await request('POST','/approval-tasks/'+financeTask.id+'/claim',role,undefined,403);
  assert.equal(await state(finance.invoiceId),'EXCEPTION');
  await claim(financeTask.id,'finance_manager'); await complete(financeTask.id,'finance_manager');
  assert.equal(await state(finance.invoiceId),'READY_FOR_PAYMENT');
  console.log('PASS exact >=100000000.00 finance threshold, finance-only task and approval');

  for(const action of ['REJECT','REQUEST_CREDIT_NOTE','APPROVE_WITH_ADJUSTMENT']){
    const input=await fixture(['PRICE_MISMATCH','TAX_MISMATCH']);
    const before=(await db.query('SELECT subtotal::text,tax_amount::text,total_amount::text FROM invoices WHERE id=$1',[input.invoiceId])).rows[0];
    const beforeLines=(await db.query('SELECT * FROM invoice_items WHERE invoice_id=$1',[input.invoiceId])).rows;
    const created=await start(input.invoiceId); const task=await active(created.approvalCaseId,'buyer');
    await claim(task.id,'buyer'); await request('POST','/approval-tasks/'+task.id+'/complete','buyer',{action,reason:'  '},400);
    await complete(task.id,'buyer',action,'Documented vendor resolution for '+action);
    if(action==='APPROVE_WITH_ADJUSTMENT'){
      const next=await active(created.approvalCaseId,'accountant'); await claim(next.id,'accountant'); await complete(next.id,'accountant');
    }
    const info=await detail(created.approvalCaseId);
    assert.equal(info.status,action==='REJECT'?'REJECTED':action==='REQUEST_CREDIT_NOTE'?'CREDIT_NOTE_REQUESTED':'APPROVED');
    assert.equal(await state(input.invoiceId),action==='REJECT'?'REJECTED':action==='REQUEST_CREDIT_NOTE'?'EXCEPTION':'READY_FOR_PAYMENT');
    assert.equal(info.decisions[0].action,action); assert.ok(info.decisions[0].reason); assert.ok(info.resolvedAt);
    assert.deepEqual((await db.query('SELECT subtotal::text,tax_amount::text,total_amount::text FROM invoices WHERE id=$1',[input.invoiceId])).rows[0],before);
    assert.deepEqual((await db.query('SELECT * FROM invoice_items WHERE invoice_id=$1',[input.invoiceId])).rows,beforeLines);
    assert.equal((await engine('/runtime/tasks?processInstanceId='+info.workflowInstanceId)).data.length,0);
    if(action!=='APPROVE_WITH_ADJUSTMENT') assert.equal((await db.query("SELECT count(*) FROM audit_records WHERE entity_id=$1 AND event_type='INVOICE_READY_FOR_PAYMENT'",[input.invoiceId])).rows[0].count,'0');
    await audit(info.id,input.invoiceId,[action==='REJECT'?'INVOICE_REJECTED':action==='REQUEST_CREDIT_NOTE'?'VENDOR_CREDIT_NOTE_REQUESTED':'INVOICE_APPROVED']);
    console.log('PASS '+action+' reason/history/end state; no financial values rewritten');
  }
  const race=await fixture(['PRICE_MISMATCH']);
  const starts=await concurrent(race.invoiceId,[()=>api('POST','/invoices/'+race.invoiceId+'/workflow/start'),()=>api('POST','/invoices/'+race.invoiceId+'/workflow/start')]);
  assert.deepEqual(starts.map(r=>r.status).sort(),[200,409]);
  const raceCase=starts.find(r=>r.status===200).body.approvalCaseId;
  assert.equal((await db.query('SELECT count(*) FROM approval_cases WHERE invoice_id=$1',[race.invoiceId])).rows[0].count,'1');
  assert.equal((await engine('/history/historic-process-instances?businessKey='+encodeURIComponent('approval-case:'+raceCase))).data.length,1);
  const raceTask=await active(raceCase,'buyer');
  const claims=await concurrent(race.invoiceId,['buyer','admin'].map(role=>()=>api('POST','/approval-tasks/'+raceTask.id+'/claim',role)));
  assert.deepEqual(claims.map(r=>r.status).sort(),[200,409]);
  const winner=claims[0].status===200?'buyer':'admin';
  const completes=await concurrent(race.invoiceId,[()=>api('POST','/approval-tasks/'+raceTask.id+'/complete',winner,{action:'APPROVE'}),
    ()=>api('POST','/approval-tasks/'+raceTask.id+'/complete',winner,{action:'APPROVE'})]);
  assert.deepEqual(completes.map(r=>r.status).sort(),[200,409]);
  assert.equal(completes.find(r=>r.status===409).body.errorCode,'TASK_ALREADY_COMPLETED');
  assert.equal((await db.query('SELECT count(*) FROM approval_decisions WHERE approval_task_id=$1',[raceTask.id])).rows[0].count,'1');
  console.log('PASS simultaneous start/claim/complete with database barriers: one case, process, claimant, decision; competing requests 409');

  const snap=await fixture(['PRICE_MISMATCH'],'200.00'); const snapCase=await start(snap.invoiceId);
  await request('PATCH','/workflow/policy','admin',{financeApprovalThreshold:'100.00',autoReadyForPaymentMaxAmount:'50.00'});
  assert.equal((await detail(snapCase.approvalCaseId)).matchSnapshot.workflowPolicySnapshot.financeApprovalThreshold,'100000000.00');
  const snapTask=await active(snapCase.approvalCaseId,'buyer'); await claim(snapTask.id,'buyer'); await complete(snapTask.id,'buyer');
  assert.equal(await state(snap.invoiceId),'READY_FOR_PAYMENT'); // old threshold snapshot did not gain a finance stage
  const cleanFinance=await fixture([], '50.01'); const cleanFinanceCase=await start(cleanFinance.invoiceId);
  assert.equal(cleanFinanceCase.route,'CLEAN_FINANCE');
  const cfTask=await active(cleanFinanceCase.approvalCaseId,'finance_manager');
  await complete(cfTask.id,'admin'); // explicit admin override on unclaimed task
  assert.equal(await state(cleanFinance.invoiceId),'READY_FOR_PAYMENT');
  const override=(await db.query("SELECT metadata FROM audit_records WHERE entity_id=$1 AND event_type='APPROVAL_TASK_COMPLETED'",[cfTask.id])).rows[0];
  assert.equal(override.metadata.override,true);
  const cap=await fixture([], '50.00'); assert.equal((await start(cap.invoiceId)).route,'STP');
  await request('PATCH','/workflow/policy','admin',{financeApprovalThreshold:'100000000.00',autoReadyForPaymentMaxAmount:null});
  assert.ok((await db.query("SELECT id FROM audit_records WHERE event_type='WORKFLOW_POLICY_UPDATED' AND metadata ? 'previous' AND metadata ? 'new'")).rowCount);
  console.log('PASS immutable policy snapshots, clean finance cap boundary, admin override audit and policy previous/new audit');

  const changed=await fixture(['PRICE_MISMATCH']);
  const changedCase=await start(changed.invoiceId);
  const changedTask=await active(changedCase.approvalCaseId,'buyer');
  await db.query("UPDATE invoices SET status='REJECTED' WHERE id=$1",[changed.invoiceId]);
  const conflict=await request('POST','/approval-tasks/'+changedTask.id+'/claim','buyer',undefined,409);
  assert.equal(conflict.errorCode,'INVALID_INVOICE_STATE');
  assert.equal((await db.query('SELECT status FROM approval_tasks WHERE id=$1',[changedTask.id])).rows[0].status,'OPEN');
  await db.query("UPDATE invoices SET status='EXCEPTION' WHERE id=$1",[changed.invoiceId]);
  await claim(changedTask.id,'buyer'); await complete(changedTask.id,'buyer');
  console.log('PASS externally changed invoice state prevents task action before engine dispatch');

  // A real stopped engine, not a mocked HTTP response.
  const outage=await fixture(['PRICE_MISMATCH']);
  docker(['stop','-t','5','smartprocure-flowable']);
  try{
    const failed=await request('POST','/invoices/'+outage.invoiceId+'/workflow/start','accountant',undefined,503);
    assert.equal(failed.errorCode,'WORKFLOW_ENGINE_UNAVAILABLE');
    const row=(await db.query('SELECT id,status,workflow_instance_id FROM approval_cases WHERE invoice_id=$1',[outage.invoiceId])).rows[0];
    assert.equal(row.status,'FAILED'); assert.equal(row.workflow_instance_id,null);
    assert.equal((await db.query('SELECT count(*) FROM approval_tasks WHERE approval_case_id=$1',[row.id])).rows[0].count,'0');
    assert.equal(await state(outage.invoiceId),'EXCEPTION');
    await audit(row.id,outage.invoiceId,['WORKFLOW_START_FAILED']);
  }finally{docker(['up','-d','smartprocure-flowable']);}
  await bootstrap();
  const outageCase=(await db.query('SELECT id FROM approval_cases WHERE invoice_id=$1',[outage.invoiceId])).rows[0].id;
  await recover(outageCase); await active(outageCase,'buyer');
  await request('POST','/invoices/'+outage.invoiceId+'/workflow/start','accountant',undefined,409);
  console.log('PASS real Flowable outage: safe 503/FAILED, no fake tasks; explicit recovery one process');

  const orphan=await fixture(['PRICE_MISMATCH']);
  await db.query(`CREATE FUNCTION workflow_test_fail_sync() RETURNS trigger AS $$
    BEGIN IF NEW.invoice_id='`+orphan.invoiceId+`'::uuid THEN RAISE EXCEPTION 'Controlled workflow sync failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await db.query('CREATE TRIGGER workflow_test_fail_sync BEFORE UPDATE OF workflow_instance_id ON approval_cases FOR EACH ROW EXECUTE FUNCTION workflow_test_fail_sync()');
  let orphanCase;
  try{
    await request('POST','/invoices/'+orphan.invoiceId+'/workflow/start','accountant',undefined,503);
    const row=(await db.query('SELECT * FROM approval_cases WHERE invoice_id=$1',[orphan.invoiceId])).rows[0];
    orphanCase=row.id; assert.equal(row.status,'FAILED'); assert.equal(row.workflow_instance_id,null);
    assert.equal((await engine('/history/historic-process-instances?businessKey='+encodeURIComponent('approval-case:'+row.id))).data.length,1);
    assert.equal(await state(orphan.invoiceId),'EXCEPTION');
  }finally{
    await db.query('DROP TRIGGER workflow_test_fail_sync ON approval_cases'); await db.query('DROP FUNCTION workflow_test_fail_sync()');
  }
  await recover(orphanCase);
  const orphanTask=await active(orphanCase,'buyer'); await claim(orphanTask.id,'buyer');
  // Fail the relational decision write AFTER real Flowable completion; recover using the engine's command marker.
  await db.query(`CREATE FUNCTION workflow_test_fail_decision() RETURNS trigger AS $$
    BEGIN IF NEW.approval_case_id='`+orphanCase+`'::uuid THEN RAISE EXCEPTION 'Controlled decision persistence failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await db.query('CREATE TRIGGER workflow_test_fail_decision BEFORE INSERT ON approval_decisions FOR EACH ROW EXECUTE FUNCTION workflow_test_fail_decision()');
  try{
    await request('POST','/approval-tasks/'+orphanTask.id+'/complete','buyer',{action:'APPROVE'},503);
    assert.equal(await state(orphan.invoiceId),'EXCEPTION');
    assert.equal((await db.query('SELECT count(*) FROM approval_decisions WHERE approval_task_id=$1',[orphanTask.id])).rows[0].count,'0');
  }finally{
    await db.query('DROP TRIGGER workflow_test_fail_decision ON approval_decisions'); await db.query('DROP FUNCTION workflow_test_fail_decision()');
  }
  await recover(orphanCase);
  assert.equal(await state(orphan.invoiceId),'READY_FOR_PAYMENT');
  assert.equal((await db.query('SELECT count(*) FROM approval_decisions WHERE approval_task_id=$1',[orphanTask.id])).rows[0].count,'1');
  console.log('PASS PostgreSQL failure after real engine start and completion: businessKey/operation-marker recovery, no duplicates');

  for(const role of ['accountant','admin','buyer','warehouse','finance_manager']){
    await request('GET','/approval-cases',role); await request('GET','/my-approval-tasks',role);
  }
  console.log('PASS real invoice workflow acceptance: STP, all roles/actions, snapshots/audits, concurrency, outage and non-ACID recovery');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>db.end());

