import { Injectable } from '@nestjs/common';
import { WorkflowRepository } from './workflow.repository';
import { FlowableClient, EngineError, EngineTask } from './flowable/flowable.client';
import { WorkflowError } from './workflow-error';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { TASK_ROLES } from './domain/workflow-rules';
import { CompleteTaskDto, UpdateWorkflowPolicyDto } from './workflow.dto';

@Injectable()
export class WorkflowService {
  constructor(private readonly repository: WorkflowRepository, private readonly engine: FlowableClient) {}
  private async safe<T>(work: ()=>Promise<T>): Promise<T> {
    try { return await work(); }
    catch(error) {
      if(error instanceof WorkflowError) throw error;
      if(error?.code==='23505' && error.constraint==='uq_approval_case_invoice')
        throw new WorkflowError('WORKFLOW_ALREADY_EXISTS','Workflow already exists for this invoice.',409);
      throw new WorkflowError('WORKFLOW_UNAVAILABLE','Workflow operation could not be confirmed. Consult the persisted operation and reconcile before retry.');
    }
  }
  start(id: string, actor: AuthenticatedUser) {
    return this.safe(async()=>{
      const started=await this.repository.prepareStart(id,actor);
      if(started.route==='STP') return started;
      return {...started,...await this.execute(started.operationId)};
    });
  }
  claim(id: string, actor: AuthenticatedUser) {
    return this.safe(async()=>{
      const intent=await this.repository.prepareAction(id,'CLAIM',{},actor);
      if(intent.idempotent) return intent;
      return this.execute(intent.operationId);
    });
  }
  complete(id: string, dto: CompleteTaskDto, actor: AuthenticatedUser) {
    return this.safe(async()=>{
      const intent=await this.repository.prepareAction(id,'COMPLETE',{action:dto.action,reason:dto.reason?.trim()||null},actor);
      return this.execute(intent.operationId);
    });
  }
  cases() { return this.safe(()=>this.repository.cases()); }
  detail(id: string) { return this.safe(()=>this.repository.detail(id)); }
  tasks(id: string) { return this.safe(()=>this.repository.tasks(id)); }
  myTasks(actor: AuthenticatedUser) { return this.safe(()=>this.repository.myTasks(actor)); }
  policy() { return this.safe(()=>this.repository.policy()); }
  updatePolicy(dto: UpdateWorkflowPolicyDto, actor: AuthenticatedUser) {
    if(!Object.keys(dto).some(k=>dto[k]!==undefined)) throw new WorkflowError('EMPTY_POLICY_UPDATE','Supply at least one workflow policy field.',400);
    return this.safe(()=>this.repository.updatePolicy(dto,actor));
  }
  private mismatch(): never { throw new WorkflowError('WORKFLOW_STATE_MISMATCH','Engine evidence does not match the application case. Operator reconciliation is required.'); }
  private async verifyProcess(process: any, approval: any) {
    if(!process || process.businessKey!=='approval-case:'+approval.id || process.deleteReason ||
      (approval.workflow_instance_id && process.id!==approval.workflow_instance_id)) this.mismatch();
    const definition=await this.engine.verifyDefinition(process.processDefinitionId);
    process.processDefinitionVersion=String(definition.version);
    return process;
  }
  private async verifyTask(task: EngineTask, process: any, approval: any, mirror?: any) {
    const role=TASK_ROLES[task?.taskDefinitionKey];
    const snapshot=approval.match_snapshot;
    const allowed=[...snapshot.requiredRoles,...(snapshot.requiresFinanceApproval?['finance_manager']:[])];
    if(!task || task.processInstanceId!==process.id || !role || !allowed.includes(role) ||
      (mirror && (task.id!==mirror.flowable_task_id || task.taskDefinitionKey!==mirror.task_key || role!==mirror.assigned_role))) this.mismatch();
    const links=await this.engine.identityLinks(task.id);
    const candidates=links.filter((link:any)=>link.type==='candidate');
    if(candidates.length!==1 || candidates[0].group!==role || candidates[0].user) this.mismatch();
  }
  // Used by the explicit operator CLI as well as normal authenticated API operations.
  reconcileOperation(id: string) { return this.safe(()=>this.execute(id)); }
  private async execute(id: string): Promise<any> {
    return this.repository.serialized(id,async()=>{
      const {op,approval,task,actor}=await this.repository.operation(id);
      if(op.status==='APPLIED') return this.repository.detail(approval.id);
      let uncertain=Boolean(op.dispatched_at&&!op.retry_safe);
      const send=async(work:()=>Promise<any>)=>{
        if(uncertain) throw new WorkflowError('WORKFLOW_RECONCILIATION_REQUIRED','A previous dispatch has an ambiguous outcome. Report engine history before an operator retries.');
        await this.repository.dispatch(id);
        uncertain=true;
        try { return await work(); }
        catch(error) { if(error instanceof EngineError && error.retrySafe) uncertain=false; throw error; }
      };
      try {
        let process: any;
        if(op.operation==='START') {
          const matches=await this.engine.processes('approval-case:'+approval.id);
          if(matches.length>1) this.mismatch();
          process=matches[0];
          if(!process) {
            const definition=await this.engine.definition();
            const snapshot=approval.match_snapshot;
            const started=await send(()=>this.engine.start(definition.id,'approval-case:'+approval.id,{
              approvalCaseId:approval.id,invoiceId:approval.invoice_id,matchResultId:approval.match_result_id,
              invoiceTotal:snapshot.invoiceTotal,discrepancyCodes:JSON.stringify(snapshot.discrepancyCodes),
              needsWarehouse:snapshot.requiredRoles.includes('warehouse'),needsBuyer:snapshot.requiredRoles.includes('buyer'),
              needsAccountant:snapshot.requiredRoles.includes('accountant'),requiresFinanceApproval:snapshot.requiresFinanceApproval,
            }));
            process=await this.engine.process(started.id);
          }
          process=await this.verifyProcess(process,approval);
          if(process.endTime) this.mismatch();
          uncertain=true; // The observed process is durable even if the local sync subsequently fails.
        } else {
          process=await this.verifyProcess(await this.engine.process(approval.workflow_instance_id),approval);
          const active=await this.engine.task(task.flowable_task_id);
          if(op.operation==='CLAIM') {
            if(!active || process.endTime) this.mismatch();
            await this.verifyTask(active,process,approval,task);
            if(active.assignee && active.assignee!==actor.sub) this.mismatch();
            if(!active.assignee) await send(()=>this.engine.claim(active.id,actor.sub));
            const claimed=await this.engine.task(active.id);
            if(!claimed || claimed.assignee!==actor.sub) this.mismatch();
            uncertain=true;
          } else {
            if(active) {
              await this.verifyTask(active,process,approval,task);
              if(process.endTime || (!op.payload.override && active.assignee!==actor.sub) ||
                (op.payload.override && active.assignee!==task.assignee_subject)) this.mismatch();
              await send(()=>this.engine.complete(active.id,op.payload.action,id));
            }
            // A completion timeout/DB failure is recoverable only with this command's persisted engine marker.
            const history=await this.engine.historicTask(task.flowable_task_id);
            if(!history || !history.endTime || history.processInstanceId!==process.id ||
              history.taskDefinitionKey!==task.task_key ||
              !history.variables?.some((v:any)=>v.name==='applicationOperationId'&&v.value===id)) this.mismatch();
            uncertain=true;
            process=await this.verifyProcess(await this.engine.process(process.id),approval);
            const expected=op.payload.action==='REJECT'?'rejected':op.payload.action==='REQUEST_CREDIT_NOTE'?'creditNote':'approved';
            if(process.endTime && process.endActivityId!==expected) this.mismatch();
            if(!process.endTime && ['REJECT','REQUEST_CREDIT_NOTE'].includes(op.payload.action)) this.mismatch();
          }
        }
        const tasks=await this.engine.tasks(process.id);
        if(process.endTime ? tasks.length!==0 : tasks.length!==1) this.mismatch();
        for(const current of tasks) await this.verifyTask(current,process,approval);
        return await this.repository.finish(id,process,tasks);
      } catch(error) {
        const code=error instanceof WorkflowError?(error.getResponse() as any).errorCode:'WORKFLOW_PERSISTENCE_FAILED';
        // Failure of this secondary write leaves the original durable PENDING intent discoverable.
        try { await this.repository.failure(id,code,!uncertain); } catch { /* operator report still sees PENDING */ }
        throw error;
      }
    });
  }
}

