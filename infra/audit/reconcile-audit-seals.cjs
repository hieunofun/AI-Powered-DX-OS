// Report-only by default. No application worker starts in this CLI.
require('reflect-metadata');
const {NestFactory}=require('@nestjs/core');
const {AuditModule}=require('../../apps/api/dist/audit/audit.module');
const {AuditRepository}=require('../../apps/api/dist/audit/audit.repository');
const {AuditSealService}=require('../../apps/api/dist/audit/audit-seal.service');
const {ImmudbClient}=require('../../apps/api/dist/audit/immudb/immudb.client');
async function main(){
  const args=process.argv.slice(2),apply=args.includes('--apply'),at=args.indexOf('--invoice'),id=at<0?null:args[at+1];
  if(at>=0 && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id||'')) throw Error('Invalid invoice UUID');
  if(args.some((arg,i)=>!['--apply','--invoice'].includes(arg)&&!(at>=0&&i===at+1))) throw Error('Unknown option');
  const app=await NestFactory.createApplicationContext(AuditModule,{logger:false});
  let failures=0;
  try {
    const rows=await app.get(AuditRepository).eligible(id),ledger=app.get(ImmudbClient);
    for(const row of rows){
      if(apply){
        try {console.log(JSON.stringify({mode:'apply',...await app.get(AuditSealService).seal(row.invoiceId,'operator:audit-reconcile')}));}
        catch(error){failures++;console.log(JSON.stringify({mode:'apply',invoiceId:row.invoiceId,errorCode:error.errorCode||'AUDIT_UNAVAILABLE'}));}
      }else{
        try {
          const entry=await ledger.get(row.sealKey||'smartprocure:audit:invoice:'+row.invoiceId+':v1');
          console.log(JSON.stringify({...row,mode:'report',ledgerEntryPresent:Boolean(entry),rootMatches:entry&&row.merkleRoot?entry.merkle_root===row.merkleRoot:null}));
        }catch{console.log(JSON.stringify({...row,mode:'report',ledgerStatus:'UNAVAILABLE'}));}
      }
    }
    console.log(JSON.stringify({mode:apply?'apply':'report',eligible:rows.length,failures,...(!apply?{mutations:0}:{})}));
  } finally {await app.close();}
  if(failures) process.exitCode=1;
}
main().catch(()=>{console.error('AUDIT_RECONCILIATION_FAILED: inspect connectivity and operator arguments.');process.exitCode=1;});
