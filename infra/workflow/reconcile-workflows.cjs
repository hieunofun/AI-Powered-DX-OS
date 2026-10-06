// Run inside the API container with its existing engine/DB environment.
// Report is the default. Only --apply --operation <UUID> executes persisted intent.
require('reflect-metadata');
const {NestFactory}=require('@nestjs/core');
const {AppModule}=require('../../apps/api/dist/app.module');
const {WorkflowRepository}=require('../../apps/api/dist/workflow/workflow.repository');
const {WorkflowService}=require('../../apps/api/dist/workflow/workflow.service');
const {FlowableClient}=require('../../apps/api/dist/workflow/flowable/flowable.client');
async function main(){
  const args=process.argv.slice(2),apply=args.includes('--apply');
  const at=args.indexOf('--operation'),id=at>=0?args[at+1]:null;
  if(apply && (!id||!/^[0-9a-f-]{36}$/i.test(id))) throw new Error('--apply requires --operation <UUID>');
  if(args.some((value,i)=>!['--apply','--operation'].includes(value)&&!(at>=0&&i===at+1))) throw new Error('Unknown option');
  const app=await NestFactory.createApplicationContext(AppModule,{logger:false});
  try {
    const repository=app.get(WorkflowRepository),engine=app.get(FlowableClient);
    if(apply) {
      const result=await app.get(WorkflowService).reconcileOperation(id);
      console.log(JSON.stringify({mode:'apply',operationId:id,result}));
    } else {
      const pending=await repository.pending();
      for(const row of pending.filter(row=>!id||row.id===id)){
        try {
          const processes=await engine.processes('approval-case:'+row.approvalCaseId);
          console.log(JSON.stringify({...row,businessKey:'approval-case:'+row.approvalCaseId,
            observedProcesses:processes.map(p=>({id:p.id,ended:Boolean(p.endTime)})),mode:'report'}));
        } catch { console.log(JSON.stringify({...row,mode:'report',engine:'unavailable'})); }
      }
      console.log(JSON.stringify({mode:'report',pending:pending.length,mutations:0}));
    }
  } finally {await app.close();}
}
main().catch(error=>{
  const response=typeof error.getResponse==='function'?error.getResponse():null;
  console.error(JSON.stringify({errorCode:response?.errorCode||'RECONCILIATION_FAILED',message:response?.message||'Inspect engine/database connectivity and operator arguments.'}));
  process.exitCode=1;
});

