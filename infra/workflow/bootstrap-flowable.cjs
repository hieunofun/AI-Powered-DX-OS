const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {XMLValidator,XMLParser}=require('fast-xml-parser');
const {engine}=require('./flowable-http.cjs');
const key='invoiceExceptionWorkflow';
const file=path.resolve(__dirname,'../flowable/processes/invoice-exception-workflow.bpmn20.xml');
const xml=fs.readFileSync(file,'utf8');
const hash=value=>createHash('sha256').update(value.replace(/\r\n/g,'\n').trim()).digest('hex');
async function bootstrap(){
  assert.equal(XMLValidator.validate(xml),true,'BPMN must be valid XML');
  const parsed=new XMLParser({ignoreAttributes:false}).parse(xml).definitions.process;
  assert.equal(parsed['@_id'],key);
  assert.deepEqual(parsed.userTask.map(t=>t['@_id']),['warehouseReview','buyerReview','accountantReview','financeReview']);
  assert.equal(parsed.exclusiveGateway.length,8);
  assert.deepEqual(parsed.endEvent.map(t=>t['@_id']),['approved','rejected','creditNote']);
  let ready=false;
  const deadline=Date.now()+180000;
  while(Date.now()<deadline){
    try { await engine('/management/engine'); ready=true; break; } catch { await new Promise(r=>setTimeout(r,3000)); }
  }
  assert.ok(ready,'Flowable did not become healthy within bounded wait');
  let definitions=(await engine('/repository/process-definitions?key='+key+'&latest=true')).data;
  if(!definitions.length){
    const form=new FormData();
    form.append('file',new Blob([xml],{type:'application/xml'}),'invoice-exception-workflow.bpmn20.xml');
    await engine('/repository/deployments',{method:'POST',body:form});
    definitions=(await engine('/repository/process-definitions?key='+key+'&latest=true')).data;
  }
  assert.equal(definitions.length,1);
  const deployed=await engine('/repository/process-definitions/'+encodeURIComponent(definitions[0].id)+'/resourcedata',{raw:true});
  assert.equal(hash(deployed),hash(xml),'Existing process key must contain the approved WF-1.0 bytes; inspect deployment before replacement');
  console.log('PASS BPMN XML/key/tasks/gateways and idempotent real deployment',JSON.stringify({key,version:definitions[0].version,sha256:hash(xml)}));
  return definitions[0];
}
module.exports={bootstrap};
if(require.main===module) bootstrap().catch(e=>{console.error(e.message);process.exitCode=1;});

