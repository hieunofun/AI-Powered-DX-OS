/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { EngineError } from '../../platform/workflow/flowable.transport';
import { WorkflowEnginePort } from '../../platform/workflow/workflow-engine.port';
import { EvidenceContext, EvidenceError, fail } from '../../platform/evidence/evidence.types';
import { contextValid, UUID } from '../../platform/evidence/file-safety';
import { OnboardingCase, OnboardingStore, WorkflowIntent } from './onboarding.types';
import { OnboardingService } from './onboarding.service';
export class OnboardingWorker {
  private active = 0;
  constructor(private readonly store: OnboardingStore, private readonly service: OnboardingService, private readonly engine: WorkflowEnginePort,
    private readonly now: () => number = Date.now) {
    if (!engine?.start || !engine?.historicTask || !engine?.complete) throw new Error('An actual generic workflow engine port is required.');
  }
  private at() { return new Date(this.now()).toISOString(); }
  private async change(ctx: EvidenceContext, id: string, token: string, work: (record: OnboardingCase) => void, permission?: string) {
    return this.store.transaction(ctx, async client => {
      await this.store.lock(client, ctx, id); const record = await this.store.read(ctx, id, client);
      if (!record || record.intent?.lease?.token !== token || Date.parse(record.intent.lease.until) <= this.now()) fail('REVISION_CONFLICT', 409);
      if (permission) {
        await this.service.authorize(client, ctx, permission, record); await this.service.sourceGuard(client, ctx, record);
        if (record.decision) await this.service.verifiedDecision(client, { tenantId: ctx.tenantId, subject: record.decision.approver }, record);
      }
      const before = structuredClone(record); work(record); record.updatedAt = this.at();
      await this.store.save(client, ctx, before, record); return record;
    });
  }
  private async guard(ctx: EvidenceContext, id: string, token: string, permission: string) {
    const inspect = () => this.store.transaction(ctx, async client => {
      const record = await this.service.read(client, ctx, id, permission);
      if (record.intent?.lease?.token !== token || Date.parse(record.intent.lease.until) <= this.now()) fail('REVISION_CONFLICT', 409);
      await this.service.sourceGuard(client, ctx, record);
      if (record.decision) await this.service.verifiedDecision(client, { tenantId: ctx.tenantId, subject: record.decision.approver }, record);
      return record;
    });
    const record = await inspect(); await this.service.byteGuard(ctx, record); return inspect();
  }
  private processProof(record: OnboardingCase, process: any) {
    if (!process || typeof process.id !== 'string' || !process.id || process.id.length > 200 || process.businessKey !== record.workflow.businessKey ||
      process.processDefinitionId !== record.workflow.definitionId || record.workflow.processId && process.id !== record.workflow.processId) fail('RECONCILIATION_REQUIRED', 409);
  }
  private taskProof(record: OnboardingCase, task: any) {
    if (!task || typeof task.id !== 'string' || !task.id || task.id.length > 200 || task.processInstanceId !== record.workflow.processId || task.taskDefinitionKey !== 'access_review' ||
      record.workflow.taskId && task.id !== record.workflow.taskId) fail('RECONCILIATION_REQUIRED', 409);
  }
  private candidateProof(record: OnboardingCase, links: any) {
    const candidates = Array.isArray(links) ? links.filter(link => link.type === 'candidate') : [];
    if (candidates.length !== 1 || candidates[0].group !== record.binding.workflow.reviewer_group || candidates[0].user) fail('RECONCILIATION_REQUIRED', 409);
  }
  private async phase(ctx: EvidenceContext, id: string, token: string, phase: WorkflowIntent['phase'], permission: string) {
    return this.change(ctx, id, token, record => { record.intent.phase = phase; }, permission);
  }
  private async write(ctx: EvidenceContext, id: string, token: string, sent: WorkflowIntent['phase'], retryPhase: WorkflowIntent['phase'], permission: string, action: () => Promise<unknown>) {
    await this.phase(ctx, id, token, sent, permission);
    try { await action(); }
    catch (error) { if (error instanceof EngineError && error.retrySafe) await this.phase(ctx, id, token, retryPhase, permission); throw error; }
  }
  async processNext(ctx: EvidenceContext) { return this.run(ctx, undefined, false); }
  async reconcile(ctx: EvidenceContext, id: string) {
    if (typeof id !== 'string' || !UUID.test(id)) fail('INVALID_REQUEST'); return this.run(ctx, id, true);
  }
  private async run(ctx: EvidenceContext, selectedId: string | undefined, readOnly: boolean) {
    contextValid(ctx); const permission = readOnly ? 'onboarding.workflow.reconcile' : 'onboarding.workflow.process';
    await this.store.transaction(ctx, client => this.service.authorize(client, ctx, permission));
    if (this.active >= 2) fail('QUOTA_EXCEEDED', 429, true); this.active++;
    try {
      const id = selectedId || await this.store.candidate(ctx, this.at()); if (!id) return;
      const token = randomUUID();
      const claimed = await this.store.transaction(ctx, async client => {
        await this.store.lock(client, ctx, id); const record = await this.service.read(client, ctx, id, permission);
        if (!record.intent || record.intent.phase === 'DONE' || record.intent.lease && Date.parse(record.intent.lease.until) > this.now() ||
          !readOnly && (record.intent.attempts >= 3 || record.intent.nextAttemptAt && Date.parse(record.intent.nextAttemptAt) > this.now())) return;
        const before = structuredClone(record); if (!readOnly) record.intent.attempts++;
        record.intent.lease = { token, until: new Date(this.now() + 120000).toISOString() }; delete record.intent.nextAttemptAt;
        const operation = record.operations.find(op => op.id === record.intent.operationId); if (!operation) fail('INVALID_STATE', 409);
        operation.state = 'RUNNING'; operation.updated_at = this.at(); delete operation.error; record.updatedAt = this.at();
        await this.store.save(client, ctx, before, record); return record;
      });
      if (!claimed) return;
      try {
        const guard = () => this.guard(ctx, id, token, permission);
        let record = await guard();
        if (record.intent.kind === 'START') {
          let processes = await this.engine.processes(record.workflow.businessKey); record = await guard();
          if (!Array.isArray(processes) || processes.length > 1) fail('RECONCILIATION_REQUIRED', 409);
          if (!processes.length) {
            if (record.intent.phase !== 'READY' || readOnly) fail('RECONCILIATION_REQUIRED', 409);
            await this.write(ctx, id, token, 'START_SENT', 'READY', permission, () => this.engine.start(record.workflow.definitionId, record.workflow.businessKey, {
              tenantId: ctx.tenantId, caseId: id, packId: 'onboarding', requesterSubject: record.requester, requestSha256: record.requestHash,
              manifestSha256: record.manifestSha256, reviewerGroup: record.binding.workflow.reviewer_group,
            }));
            record = await guard(); processes = await this.engine.processes(record.workflow.businessKey); record = await guard();
          }
          if (processes.length !== 1) fail('RECONCILIATION_REQUIRED', 409); this.processProof(record, processes[0]);
          record = await this.change(ctx, id, token, current => { current.workflow.processId = processes[0].id; current.intent.phase = 'START_CONFIRMED'; }, permission);
          const process = await this.engine.process(record.workflow.processId); await guard(); this.processProof(record, process);
          if (process.endTime) fail('RECONCILIATION_REQUIRED', 409);
          const tasks = await this.engine.tasks(record.workflow.processId); record = await guard();
          if (!Array.isArray(tasks) || tasks.length !== 1) fail('DEPENDENCY_UNAVAILABLE', 503, true); this.taskProof(record, tasks[0]);
          const links = await this.engine.identityLinks(tasks[0].id); await guard();
          this.candidateProof(record, links);
          const finished = await this.change(ctx, id, token, current => {
            current.workflow.taskId = tasks[0].id; current.state = 'AWAITING_APPROVAL'; current.intent.phase = 'DONE'; delete current.intent.lease;
            const operation = current.operations.find(op => op.id === current.intent.operationId); operation.state = 'SUCCEEDED'; operation.updated_at = this.at(); delete operation.error;
          }, permission);
          return finished.operations.find(op => op.id === finished.intent.operationId);
        }
        if (!record.decision || !record.workflow?.taskId || !record.workflow.processId) fail('INVALID_STATE', 409);
        let historic = await this.engine.historicTask(record.workflow.taskId); record = await guard();
        if (!historic?.endTime) {
          let task = await this.engine.task(record.workflow.taskId); record = await guard(); this.taskProof(record, task);
          if (task.assignee && task.assignee !== record.decision.approver) fail('RECONCILIATION_REQUIRED', 409);
          if (!task.assignee) {
            if (readOnly || !['READY'].includes(record.intent.phase)) fail('RECONCILIATION_REQUIRED', 409);
            const links = await this.engine.identityLinks(task.id); record = await guard();
            this.candidateProof(record, links);
            await this.write(ctx, id, token, 'CLAIM_SENT', 'READY', permission, () => this.engine.claim(task.id, record.decision.approver));
            record = await guard(); task = await this.engine.task(record.workflow.taskId); record = await guard(); this.taskProof(record, task);
            if (task.assignee !== record.decision.approver) fail('RECONCILIATION_REQUIRED', 409);
          }
          if (record.intent.phase !== 'COMPLETE_SENT') {
            const priorPhase = record.intent.phase; record = await this.phase(ctx, id, token, 'CLAIM_CONFIRMED', permission);
            if (readOnly) {
              if (priorPhase === 'CLAIM_SENT') await this.change(ctx, id, token, current => { current.intent.attempts = 0; }, permission);
              fail('RECONCILIATION_REQUIRED', 409);
            }
            record = await guard();
            await this.write(ctx, id, token, 'COMPLETE_SENT', 'CLAIM_CONFIRMED', permission, () => this.engine.complete(record.workflow.taskId, record.decision.action, record.intent.operationId));
            await guard();
          }
          historic = await this.engine.historicTask(record.workflow.taskId); record = await guard();
        }
        this.taskProof(record, historic);
        const operations = Array.isArray(historic.variables) ? historic.variables.filter(value => value.name === 'applicationOperationId') : [];
        const taskEnded = Date.parse(historic.endTime);
        if (!Number.isFinite(taskEnded) || historic.assignee !== record.decision.approver || operations.length !== 1 ||
          operations[0].scope !== 'local' || operations[0].value !== record.intent.operationId) fail('RECONCILIATION_REQUIRED', 409);
        const process = await this.engine.process(record.workflow.processId); record = await guard(); this.processProof(record, process);
        const ended = Date.parse(process.endTime); if (!process.endTime || !Number.isFinite(ended) || taskEnded > ended || ended > this.now() + 5000) fail('RECONCILIATION_REQUIRED', 409);
        const finished = await this.change(ctx, id, token, current => {
          current.workflow.endedAt = new Date(ended).toISOString(); current.state = current.decision.action === 'APPROVE' ? 'COMPLETED' : 'REJECTED';
          current.intent.phase = 'DONE'; delete current.intent.lease;
          const operation = current.operations.find(op => op.id === current.intent.operationId); operation.state = 'SUCCEEDED'; operation.updated_at = this.at(); delete operation.error;
        }, permission);
        return finished.operations.find(op => op.id === finished.intent.operationId);
      } catch (cause) {
        const failed = await this.change(ctx, id, token, record => {
          const code = cause instanceof EvidenceError ? cause.code : 'DEPENDENCY_UNAVAILABLE', retryable = cause instanceof EngineError ? cause.retrySafe : cause instanceof EvidenceError ? cause.retryable : false;
          const operation = record.operations.find(op => op.id === record.intent.operationId);
          record.intent.failures.push({ code, at: this.at(), attempt: record.intent.attempts }); delete record.intent.lease;
          const pending = !readOnly && retryable && record.intent.attempts < 3;
          operation.state = pending ? 'PENDING' : record.intent.phase !== 'READY' ? 'RECONCILIATION_REQUIRED' : 'FAILED'; operation.updated_at = this.at();
          operation.error = { code, message: 'Onboarding workflow requires verified recovery.', correlation_id: randomUUID(), retryable: pending };
          if (pending) record.intent.nextAttemptAt = new Date(this.now() + 1000 * 2 ** (record.intent.attempts - 1) + Math.floor(Math.random() * 250)).toISOString();
          else if (!readOnly) record.intent.attempts = 3;
          record.state = 'RECONCILIATION_REQUIRED';
        });
        return failed.operations.find(op => op.id === failed.intent.operationId);
      }
    } finally { this.active--; }
  }
}
