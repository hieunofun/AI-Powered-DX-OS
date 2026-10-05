import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { WorkflowError } from './workflow-error';
import { workflowRoute, policySnapshot, WorkflowPolicy, PROCESS_KEY, TASK_ROLES, outcome } from './domain/workflow-rules';

const POLICY = `id,policy_code AS "policyCode",auto_ready_for_payment_max_amount::text AS "autoReadyForPaymentMaxAmount",
  finance_approval_threshold::text AS "financeApprovalThreshold"`;
const CASE = `c.id,c.invoice_id AS "invoiceId",c.match_result_id AS "matchResultId",c.status,c.case_type AS "caseType",
  c.assigned_role AS "assignedRole",c.current_stage AS "currentStage",c.decision,c.decision_reason AS "decisionReason",
  c.workflow_instance_id AS "workflowInstanceId",c.workflow_definition_key AS "workflowDefinitionKey",
  c.workflow_definition_version AS "workflowDefinitionVersion",c.match_snapshot AS "matchSnapshot",
  c.requested_by_subject AS "requestedBySubject",c.resolved_by_subject AS "resolvedBySubject",
  c.requested_at AS "requestedAt",c.resolved_at AS "resolvedAt",i.status AS "invoiceStatus"`;
const TASK = `id,approval_case_id AS "approvalCaseId",flowable_task_id AS "flowableTaskId",task_key AS "taskKey",
  task_name AS "taskName",assigned_role AS "assignedRole",assignee_subject AS "assigneeSubject",status,action,
  action_reason AS "actionReason",created_at AS "createdAt",claimed_at AS "claimedAt",completed_at AS "completedAt"`;

@Injectable()
export class WorkflowRepository {
  constructor(private readonly db: DatabaseService) {}
  async audit(client: PoolClient, type: string, id: string, event: string, actor: AuthenticatedUser, metadata: any) {
    await client.query(`INSERT INTO audit_records(entity_type,entity_id,event_type,actor_subject,metadata)
      VALUES($1,$2,$3,$4,$5::jsonb)`,[type,id,event,actor.sub,JSON.stringify({...metadata,roles:actor.roles})]);
  }
  private async activePolicy(client: PoolClient, update=false): Promise<WorkflowPolicy> {
    const rows=(await client.query('SELECT '+POLICY+' FROM workflow_policies WHERE is_active FOR '+(update?'UPDATE':'SHARE'))).rows;
    if(rows.length!==1) throw new WorkflowError('WORKFLOW_POLICY_UNAVAILABLE','Exactly one active workflow policy is required.');
    return rows[0];
  }
  policy() { return this.db.transaction(c=>this.activePolicy(c)); }
  updatePolicy(dto: Partial<WorkflowPolicy>, actor: AuthenticatedUser) {
    return this.db.transaction(async c=>{
      const previous=await this.activePolicy(c,true);
      const current=(await c.query(`UPDATE workflow_policies SET auto_ready_for_payment_max_amount=$2,finance_approval_threshold=$3
        WHERE id=$1 RETURNING `+POLICY,[previous.id,dto.autoReadyForPaymentMaxAmount===undefined?previous.autoReadyForPaymentMaxAmount:dto.autoReadyForPaymentMaxAmount,
        dto.financeApprovalThreshold??previous.financeApprovalThreshold])).rows[0];
      await this.audit(c,'WORKFLOW_POLICY',current.id,'WORKFLOW_POLICY_UPDATED',actor,{previous:policySnapshot(previous),new:policySnapshot(current)});
      return current;
    });
  }
  private async intent(c: PoolClient, caseId: string, taskId: string|null, operation: string, payload: any, actor: AuthenticatedUser) {
    return (await c.query(`INSERT INTO workflow_operations(approval_case_id,approval_task_id,operation,payload,actor_subject,actor_roles)
      VALUES($1,$2,$3,$4::jsonb,$5,$6) RETURNING id`,[caseId,taskId,operation,JSON.stringify(payload),actor.sub,actor.roles])).rows[0].id as string;
  }
  prepareStart(invoiceId: string, actor: AuthenticatedUser) {
    return this.db.transaction(async c=>{
      await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      const invoice=(await c.query('SELECT id,status,total_amount::text AS total FROM invoices WHERE id=$1 FOR UPDATE',[invoiceId])).rows[0];
      if(!invoice) throw new WorkflowError('INVOICE_NOT_FOUND','Invoice not found.',404);
      if((await c.query('SELECT id FROM approval_cases WHERE invoice_id=$1',[invoiceId])).rowCount ||
        (await c.query("SELECT id FROM audit_records WHERE entity_id=$1 AND event_type='INVOICE_READY_FOR_PAYMENT'",[invoiceId])).rowCount)
        throw new WorkflowError('WORKFLOW_ALREADY_EXISTS','Workflow has already been started for this invoice.',409);
      const match=(await c.query(`SELECT id,status,discrepancy_codes,policy_snapshot,rule_version,completed_at
        FROM match_results WHERE invoice_id=$1 FOR SHARE`,[invoiceId])).rows[0];
      if(!match || !match.completed_at) throw new WorkflowError('MATCH_RESULT_REQUIRED','A completed matching result is required.',409);
      const policy=await this.activePolicy(c);
      const route=workflowRoute(invoice.status,match.status,invoice.total,policy,match.discrepancy_codes);
      const snapshot={matchResultId:match.id,matchStatus:match.status,discrepancyCodes:match.discrepancy_codes,
        policySnapshot:match.policy_snapshot,ruleVersion:match.rule_version,invoiceTotal:invoice.total,
        requiredRoles:route.requiredRoles,requiresFinanceApproval:route.requiresFinanceApproval,workflowPolicySnapshot:policySnapshot(policy)};
      if(route.route==='STP') {
        await c.query("UPDATE invoices SET status='READY_FOR_PAYMENT' WHERE id=$1",[invoiceId]);
        await this.audit(c,'INVOICE',invoiceId,'INVOICE_READY_FOR_PAYMENT',actor,{invoiceId,matchResultId:match.id,route:'STP',
          previousStatus:'MATCHED',newStatus:'READY_FOR_PAYMENT',policySnapshot:snapshot.workflowPolicySnapshot});
        return {route:'STP',invoiceId,invoiceStatus:'READY_FOR_PAYMENT'};
      }
      const caseId=(await c.query(`INSERT INTO approval_cases(invoice_id,match_result_id,status,case_type,current_stage,
        requested_by_subject,match_snapshot,workflow_definition_key,workflow_definition_version)
        VALUES($1,$2,'STARTING',$3,'STARTING',$4,$5::jsonb,$6,'WF-1.0') RETURNING id`,
      [invoiceId,match.id,route.route,actor.sub,JSON.stringify(snapshot),PROCESS_KEY])).rows[0].id;
      const operationId=await this.intent(c,caseId,null,'START',{},actor);
      await this.audit(c,'APPROVAL_CASE',caseId,'WORKFLOW_START_REQUESTED',actor,{invoiceId,matchResultId:match.id,operationId,businessKey:'approval-case:'+caseId});
      return {route:route.route,approvalCaseId:caseId,operationId};
    });
  }
  async cases() { return (await this.db.query('SELECT '+CASE+' FROM approval_cases c JOIN invoices i ON i.id=c.invoice_id ORDER BY c.requested_at DESC LIMIT 200')).rows; }
  async detail(id: string) {
    const value=(await this.db.query('SELECT '+CASE+' FROM approval_cases c JOIN invoices i ON i.id=c.invoice_id WHERE c.id=$1',[id])).rows[0];
    if(!value) throw new WorkflowError('APPROVAL_CASE_NOT_FOUND','Approval case not found.',404);
    value.decisions=(await this.db.query(`SELECT id,approval_task_id AS "approvalTaskId",action,reason,actor_subject AS "actorSubject",
      actor_roles AS "actorRoles",previous_case_status AS "previousCaseStatus",new_case_status AS "newCaseStatus",
      previous_invoice_status AS "previousInvoiceStatus",new_invoice_status AS "newInvoiceStatus",created_at AS "createdAt"
      FROM approval_decisions WHERE approval_case_id=$1 ORDER BY created_at,id`,[id])).rows;
    return value;
  }
  async tasks(id: string) {
    await this.detail(id);
    return (await this.db.query('SELECT '+TASK+' FROM approval_tasks WHERE approval_case_id=$1 ORDER BY created_at,id',[id])).rows;
  }
  async myTasks(actor: AuthenticatedUser) {
    return (await this.db.query('SELECT '+TASK+` FROM approval_tasks WHERE status IN ('OPEN','CLAIMED')
      AND ($1 OR assigned_role=ANY($2::text[])) AND (assignee_subject IS NULL OR assignee_subject=$3 OR $1) ORDER BY created_at LIMIT 200`,
    [actor.roles.includes('admin'),actor.roles,actor.sub])).rows;
  }
  prepareAction(taskId: string, operation: 'CLAIM'|'COMPLETE', payload: any, actor: AuthenticatedUser) {
    return this.db.transaction(async c=>{
      await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      const owner=(await c.query(`SELECT c.id,c.invoice_id FROM approval_tasks t JOIN approval_cases c ON c.id=t.approval_case_id WHERE t.id=$1`,[taskId])).rows[0];
      if(!owner) throw new WorkflowError('APPROVAL_TASK_NOT_FOUND','Approval task not found.',404);
      const invoice=(await c.query('SELECT id,status FROM invoices WHERE id=$1 FOR UPDATE',[owner.invoice_id])).rows[0];
      const approval=(await c.query('SELECT * FROM approval_cases WHERE id=$1 FOR UPDATE',[owner.id])).rows[0];
      const task=(await c.query('SELECT * FROM approval_tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0];
      const admin=actor.roles.includes('admin');
      if(!admin && !actor.roles.includes(task.assigned_role)) throw new WorkflowError('TASK_ROLE_FORBIDDEN','Your authenticated roles cannot act on this task.',403);
      if(task.status==='COMPLETED') throw new WorkflowError('TASK_ALREADY_COMPLETED','Task already completed.',409);
      if(invoice.status!==(approval.case_type==='CLEAN_FINANCE'?'MATCHED':'EXCEPTION'))
        throw new WorkflowError('INVALID_INVOICE_STATE','Invoice changed while workflow review was active.',409);
      if(task.status==='CANCELLED' || approval.status!=='PENDING') throw new WorkflowError('INVALID_TASK_STATE','Task is not active.',409);
      const pending=(await c.query("SELECT operation FROM workflow_operations WHERE approval_case_id=$1 AND status IN ('PENDING','FAILED')",[owner.id])).rows[0];
      if(pending) throw new WorkflowError(operation==='COMPLETE' && pending.operation==='COMPLETE'?'TASK_ALREADY_COMPLETED':
        operation==='CLAIM'&&pending.operation==='CLAIM'?'TASK_ALREADY_CLAIMED':'WORKFLOW_RECONCILIATION_REQUIRED','A prior workflow operation must finish or be reconciled first.',409);
      if(operation==='CLAIM') {
        if(task.status==='CLAIMED') {
          if(task.assignee_subject===actor.sub) return {taskId,idempotent:true};
          throw new WorkflowError('TASK_ALREADY_CLAIMED','Task is claimed by another user.',409);
        }
      } else if(!admin && (task.status!=='CLAIMED' || task.assignee_subject!==actor.sub)) {
        throw new WorkflowError('TASK_NOT_OWNED','Claim the task before completing it; only its claimant can complete.',403);
      }
      const operationId=await this.intent(c,owner.id,taskId,operation,{...payload,override:operation==='COMPLETE'&&admin&&task.assignee_subject!==actor.sub},actor);
      return {operationId,approvalCaseId:owner.id,taskId};
    });
  }
  async operation(id: string) {
    const op=(await this.db.query('SELECT * FROM workflow_operations WHERE id=$1',[id])).rows[0];
    if(!op) throw new WorkflowError('WORKFLOW_OPERATION_NOT_FOUND','Workflow operation not found.',404);
    const approval=(await this.db.query('SELECT * FROM approval_cases WHERE id=$1',[op.approval_case_id])).rows[0];
    const task=op.approval_task_id?(await this.db.query('SELECT * FROM approval_tasks WHERE id=$1',[op.approval_task_id])).rows[0]:null;
    return {op,approval,task,actor:{sub:op.actor_subject,roles:op.actor_roles,username:op.actor_subject} as AuthenticatedUser};
  }
  async serialized<T>(id: string, work: ()=>Promise<T>): Promise<T> {
    const {op}=await this.operation(id);
    const c=await this.db.getClient();
    let locked=false;
    try {
      locked=(await c.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',['workflow:'+op.approval_case_id])).rows[0].locked;
      if(!locked) throw new WorkflowError('WORKFLOW_OPERATION_IN_PROGRESS','Another operator is reconciling this case.',409);
      return await work();
    } finally {
      // If unlock fails, destroy the session so the pool cannot retain its advisory lock.
      let destroy=false;
      try { if(locked) await c.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['workflow:'+op.approval_case_id]); }
      catch { destroy=true; }
      c.release(destroy);
    }
  }
  async dispatch(id: string) {
    await this.db.query("UPDATE workflow_operations SET dispatched_at=clock_timestamp(),retry_safe=false,updated_at=now() WHERE id=$1 AND status<>'APPLIED'",[id]);
  }
  async failure(id: string, code: string, retrySafe: boolean) {
    return this.db.transaction(async c=>{
      const op=(await c.query("UPDATE workflow_operations SET status='FAILED',error_code=$2,retry_safe=$3,updated_at=now() WHERE id=$1 AND status<>'APPLIED' RETURNING *",[id,code,retrySafe])).rows[0];
      if(!op) return;
      if(op.operation==='START') {
        await c.query("UPDATE approval_cases SET status='FAILED',current_stage='FAILED' WHERE id=$1",[op.approval_case_id]);
        await this.audit(c,'APPROVAL_CASE',op.approval_case_id,'WORKFLOW_START_FAILED',{sub:op.actor_subject,roles:op.actor_roles,username:''},
          {operationId:id,errorCode:code,retrySafe});
      }
    });
  }
  async pending() {
    return (await this.db.query(`SELECT id,approval_case_id AS "approvalCaseId",operation,status,error_code AS "errorCode",
      dispatched_at AS "dispatchedAt",retry_safe AS "retrySafe" FROM workflow_operations WHERE status<>'APPLIED' ORDER BY created_at`)).rows;
  }
  async finish(id: string, process: any, engineTasks: any[]) {
    return this.db.transaction(async c=>{
      const original=(await c.query('SELECT * FROM workflow_operations WHERE id=$1',[id])).rows[0];
      const base=(await c.query('SELECT invoice_id FROM approval_cases WHERE id=$1',[original.approval_case_id])).rows[0];
      const invoice=(await c.query('SELECT id,status FROM invoices WHERE id=$1 FOR UPDATE',[base.invoice_id])).rows[0];
      const approval=(await c.query('SELECT * FROM approval_cases WHERE id=$1 FOR UPDATE',[original.approval_case_id])).rows[0];
      const op=(await c.query('SELECT * FROM workflow_operations WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(op.status==='APPLIED') return {approvalCaseId:approval.id,invoiceId:invoice.id,invoiceStatus:invoice.status};
      if(invoice.status!==(approval.case_type==='CLEAN_FINANCE'?'MATCHED':'EXCEPTION'))
        throw new WorkflowError('INVALID_INVOICE_STATE','Invoice changed before workflow synchronization.',409);
      const actor={sub:op.actor_subject,roles:op.actor_roles,username:''};
      if(op.operation==='START') {
        await c.query(`UPDATE approval_cases SET workflow_instance_id=$2,status='PENDING',workflow_definition_version=$3 WHERE id=$1`,
          [approval.id,process.id,'WF-1.0 / engine v'+process.processDefinitionVersion]);
        await this.audit(c,'APPROVAL_CASE',approval.id,'WORKFLOW_STARTED',actor,{invoiceId:invoice.id,operationId:id,businessKey:process.businessKey,processInstanceId:process.id});
      } else if(op.operation==='CLAIM') {
        await c.query("UPDATE approval_tasks SET status='CLAIMED',assignee_subject=$2,claimed_at=clock_timestamp() WHERE id=$1",[op.approval_task_id,actor.sub]);
        await this.audit(c,'APPROVAL_TASK',op.approval_task_id,'APPROVAL_TASK_CLAIMED',actor,{approvalCaseId:approval.id,operationId:id});
      } else {
        await c.query(`UPDATE approval_tasks SET status='COMPLETED',action=$2,action_reason=$3,completed_at=clock_timestamp() WHERE id=$1`,
          [op.approval_task_id,op.payload.action,op.payload.reason??null]);
        await this.audit(c,'APPROVAL_TASK',op.approval_task_id,'APPROVAL_TASK_COMPLETED',actor,
          {approvalCaseId:approval.id,operationId:id,action:op.payload.action,reason:op.payload.reason??null,override:op.payload.override});
      }
      for(const task of engineTasks) {
        const role=TASK_ROLES[task.taskDefinitionKey];
        const existing=(await c.query('SELECT * FROM approval_tasks WHERE flowable_task_id=$1',[task.id])).rows[0];
        if(existing ? existing.approval_case_id!==approval.id || existing.task_key!==task.taskDefinitionKey ||
          existing.assigned_role!==role || existing.assignee_subject!==(task.assignee??null) || !['OPEN','CLAIMED'].includes(existing.status)
          : Boolean(task.assignee)) throw new WorkflowError('WORKFLOW_STATE_MISMATCH','Engine task mirror or assignee differs from the application record.');
        const created=(await c.query(`INSERT INTO approval_tasks(approval_case_id,flowable_task_id,task_key,task_name,assigned_role)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT(flowable_task_id) DO NOTHING RETURNING id`,[approval.id,task.id,task.taskDefinitionKey,task.name,role])).rows[0];
        if(created) await this.audit(c,'APPROVAL_TASK',created.id,'APPROVAL_TASK_CREATED',actor,{approvalCaseId:approval.id,flowableTaskId:task.id,taskKey:task.taskDefinitionKey,assignedRole:role});
      }
      let caseStatus='PENDING',invoiceStatus=invoice.status;
      if(process.endTime) {
        if(op.operation!=='COMPLETE' || engineTasks.length) throw new WorkflowError('WORKFLOW_STATE_MISMATCH','Unexpected process completion.');
        const terminal=outcome(op.payload.action);
        caseStatus=terminal.caseStatus; invoiceStatus=terminal.invoiceStatus;
        await c.query(`UPDATE approval_cases SET status=$2,assigned_role=NULL,current_stage='RESOLVED',decision=$3,decision_reason=$4,
          resolution_note=$4,resolved_at=clock_timestamp(),resolved_by_subject=$5 WHERE id=$1`,
          [approval.id,caseStatus,op.payload.action,op.payload.reason??null,actor.sub]);
        // Audit both logical invoice transitions, with financial evidence left intact.
        if(caseStatus==='APPROVED') await c.query("UPDATE invoices SET status='APPROVED' WHERE id=$1",[invoice.id]);
        await c.query('UPDATE invoices SET status=$2 WHERE id=$1',[invoice.id,invoiceStatus]);
        for(const event of terminal.events) await this.audit(c,event.startsWith('INVOICE_')?'INVOICE':'APPROVAL_CASE',
          event.startsWith('INVOICE_')?invoice.id:approval.id,event,actor,{approvalCaseId:approval.id,invoiceId:invoice.id,
            operationId:id,action:op.payload.action,reason:op.payload.reason??null,override:op.payload.override,
            previousInvoiceStatus:event==='INVOICE_READY_FOR_PAYMENT'?'APPROVED':invoice.status,newInvoiceStatus:event==='INVOICE_APPROVED'?'APPROVED':invoiceStatus});
      } else {
        if(engineTasks.length!==1) throw new WorkflowError('WORKFLOW_STATE_MISMATCH','Sequential workflow requires exactly one active task.');
        const role=TASK_ROLES[engineTasks[0].taskDefinitionKey];
        await c.query("UPDATE approval_cases SET status='PENDING',assigned_role=$2,current_stage=$3 WHERE id=$1",
          [approval.id,role,role==='finance_manager'?'FINANCE_REVIEW':'DOMAIN_REVIEW']);
      }
      if(op.operation==='COMPLETE') await c.query(`INSERT INTO approval_decisions(approval_case_id,approval_task_id,action,reason,
        actor_subject,actor_roles,previous_case_status,new_case_status,previous_invoice_status,new_invoice_status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[approval.id,op.approval_task_id,op.payload.action,op.payload.reason??null,
        actor.sub,actor.roles,approval.status,caseStatus,invoice.status,invoiceStatus]);
      await c.query("UPDATE workflow_operations SET status='APPLIED',error_code=NULL,retry_safe=false,updated_at=now() WHERE id=$1",[id]);
      return {approvalCaseId:approval.id,invoiceId:invoice.id,invoiceStatus,caseStatus,taskId:op.approval_task_id,operationId:id};
    });
  }
}

