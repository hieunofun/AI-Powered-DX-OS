/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { AiProviderError } from '../../../ai/extraction/extraction-provider';
import { EvidenceService } from '../../../platform/evidence/evidence.service';
import { EvidenceContext, EvidenceError, fail } from '../../../platform/evidence/evidence.types';
import { checksum, contextValid, fingerprint, idempotencyKey, UUID } from '../../../platform/evidence/file-safety';
import { ActionProposal, CaseSnapshot, Command, ExplanationJob, ExplanationProvider, MediationApproval, MediationCaseSource, MediationExecutor, MediationPolicy, MediationStore } from './mediation.types';
import { actionInput, enforcePolicy, explainRequest, grounded, proposalHash, refValid, selectionInput, validateSnapshot } from './mediation-validation';
export class AiMediationService {
  private active = 0;
  constructor(private readonly store: MediationStore, private readonly source: MediationCaseSource,
    private readonly evidence: Pick<EvidenceService, 'withCleanBytes'>, private readonly provider: ExplanationProvider,
    private readonly policy: MediationPolicy, private readonly approvals: MediationApproval, private readonly executor: MediationExecutor,
    private readonly now: () => number = Date.now) {
    if (!store?.transaction || !source?.authorize || !source?.load || !evidence?.withCleanBytes || !provider?.select || !policy?.evaluate ||
      !approvals?.verify || !executor?.executeInTransaction) throw new Error('Current case/evidence/policy/decision/transactional execution adapters are mandatory.');
  }
  private at() { return new Date(this.now()).toISOString(); }
  private id(ctx: EvidenceContext, id: string) { contextValid(ctx); if (!UUID.test(id)) fail('INVALID_REQUEST'); }
  private command(ctx: EvidenceContext, route: string, key: string, body: unknown): Command {
    idempotencyKey(key); return { scope: fingerprint([ctx.tenantId, ctx.subject, 'POST', route, key]), hash: fingerprint(body) };
  }
  private async snapshot(client: PoolClient, ctx: EvidenceContext, id: string, expected?: string) {
    const snapshot = validateSnapshot(ctx, id, await this.source.load(client, ctx, id));
    if (expected && snapshot.hash !== expected) fail('REVISION_CONFLICT', 409);
    return snapshot;
  }
  private async sources(ctx: EvidenceContext, snapshot: CaseSnapshot) {
    const expected = new Map<string, string>();
    for (const fact of snapshot.facts) {
      if (expected.has(fact.evidenceId) && expected.get(fact.evidenceId) !== fact.evidenceHash) fail('INVALID_STATE', 409);
      expected.set(fact.evidenceId, fact.evidenceHash);
    }
    if (expected.size > 8) fail('INVALID_STATE', 409);
    for (const [id, hash] of expected) await this.evidence.withCleanBytes(ctx, id, 'evidence.download', async (bytes, recheck) => {
      if (checksum(bytes) !== hash) fail('CHECKSUM_MISMATCH', 422); await recheck();
    });
  }
  async request(ctx: EvidenceContext, caseId: string, body: unknown, key: string) {
    this.id(ctx, caseId); const input = explainRequest(body), command = this.command(ctx, '/ai/cases/' + caseId + '/explanations', key, input);
    return this.store.transaction(ctx, async (client, controlVersion) => {
      await this.source.authorize(client, ctx, 'ai.explain', caseId);
      const snapshot = await this.snapshot(client, ctx, caseId);
      return this.store.command(client, ctx, command, async () => {
        const id = randomUUID(), at = this.at(), operation: ExplanationJob['operation'] = { id: randomUUID(), tenant_id: ctx.tenantId,
          kind: 'AI_EXPLANATION', state: 'PENDING', created_at: at, updated_at: at, resource_ref: { pack_id: 'openresolve', type: 'ai-explanation', id } };
        const job: ExplanationJob = { id, tenantId: ctx.tenantId, requester: ctx.subject, caseId, question: input.question, controlVersion,
          snapshot, operation, acknowledgement: structuredClone(operation), createdAt: at, updatedAt: at, attempts: 0, failures: [] };
        await this.store.saveJob(client, job); return operation;
      });
    });
  }
  private async readJob(client: PoolClient, ctx: EvidenceContext, id: string) {
    const job = await this.store.job(ctx, id, client); if (!job) fail('NOT_FOUND', 404);
    await this.source.authorize(client, ctx, 'ai.explain', job.caseId);
    await this.snapshot(client, ctx, job.caseId, job.snapshot?.hash); return job;
  }
  async detail(ctx: EvidenceContext, id: string) {
    this.id(ctx, id); return this.store.transaction(ctx, async client => {
      const job = await this.readJob(client, ctx, id);
      return { id, tenant_id: job.tenantId, case_id: job.caseId, created_at: job.createdAt, operation: job.operation,
        snapshot_sha256: job.snapshot.hash, ...(job.result ? { result: job.result } : {}) };
    }, false);
  }
  async operation(ctx: EvidenceContext, id: string) {
    this.id(ctx, id); const job = await this.store.operation(ctx, id); if (!job) return;
    return this.store.transaction(ctx, async client => (await this.readJob(client, ctx, job.id)).operation, false);
  }
  async processNext(ctx: EvidenceContext) {
    contextValid(ctx);
    await this.store.transaction(ctx, client => this.source.authorize(client, ctx, 'ai.process'));
    if (this.active >= 2) fail('QUOTA_EXCEEDED', 429, true); this.active++;
    try {
      const id = await this.store.candidate(ctx, this.at()); if (!id) return;
      const token = randomUUID();
      const claimed = await this.store.transaction(ctx, async (client, controlVersion) => {
        await this.store.lock(client, ctx, 'job', id); const job = await this.store.job(ctx, id, client); if (!job) fail('NOT_FOUND', 404);
        await this.source.authorize(client, ctx, 'ai.process', job.caseId);
        if (!['PENDING', 'RUNNING'].includes(job.operation.state) || job.lease && Date.parse(job.lease.until) > this.now() ||
          job.nextAttemptAt && Date.parse(job.nextAttemptAt) > this.now()) return;
        if (job.attempts >= 3 || job.controlVersion !== controlVersion) {
          job.operation.state = 'FAILED'; job.updatedAt = job.operation.updated_at = this.at(); delete job.lease;
          job.failures.push({ code: 'INVALID_STATE', at: this.at(), attempt: job.attempts }); await this.store.saveJob(client, job); return;
        }
        job.attempts++; job.lease = { token, until: new Date(this.now() + 120000).toISOString() }; delete job.nextAttemptAt;
        job.operation.state = 'RUNNING'; job.updatedAt = job.operation.updated_at = this.at(); delete job.operation.error;
        await this.store.saveJob(client, job); return job;
      });
      if (!claimed) return (await this.store.job(ctx, id))?.operation;
      const requester = { tenantId: ctx.tenantId, subject: claimed.requester };
      const recheck = async () => {
        await this.store.transaction(ctx, async (client, version) => {
          if (version !== claimed.controlVersion) fail('REVISION_CONFLICT', 409);
          const live = await this.store.job(ctx, id, client);
          if (live?.lease?.token !== token || Date.parse(live.lease.until) <= this.now()) fail('REVISION_CONFLICT', 409);
          await this.source.authorize(client, ctx, 'ai.process', claimed.caseId);
          await this.source.authorize(client, requester, 'ai.explain', claimed.caseId);
          await this.snapshot(client, requester, claimed.caseId, claimed.snapshot.hash);
          await this.snapshot(client, ctx, claimed.caseId, claimed.snapshot.hash);
        });
        await this.sources(requester, claimed.snapshot); await this.sources(ctx, claimed.snapshot);
      };
      try {
        await recheck();
        const selection = claimed.snapshot.facts.length ? await this.provider.select(selectionInput(claimed.snapshot, claimed.question), claimed.snapshot.disclosure, recheck) : undefined;
        const result = grounded(claimed.snapshot, selection); await recheck();
        return await this.store.transaction(ctx, async (client, version) => {
          await this.store.lock(client, ctx, 'job', id); const job = await this.store.job(ctx, id, client);
          if (job?.lease?.token !== token || Date.parse(job.lease.until) <= this.now() || version !== job.controlVersion) fail('REVISION_CONFLICT', 409);
          await this.source.authorize(client, ctx, 'ai.process', job.caseId);
          await this.snapshot(client, requester, job.caseId, job.snapshot.hash); await this.snapshot(client, ctx, job.caseId, job.snapshot.hash);
          job.result = result; job.operation.state = 'SUCCEEDED'; job.updatedAt = job.operation.updated_at = this.at(); delete job.lease; delete job.operation.error;
          await this.store.saveJob(client, job); return job.operation;
        });
      } catch (cause) {
        // History can record a blocked attempt while disabled; this path never performs provider/tool I/O.
        return this.store.transaction(ctx, async client => {
          await this.store.lock(client, ctx, 'job', id); const job = await this.store.job(ctx, id, client);
          if (job?.lease?.token !== token || Date.parse(job.lease.until) <= this.now()) fail('REVISION_CONFLICT', 409);
          const code = cause instanceof EvidenceError || cause instanceof AiProviderError ? cause.code : 'DEPENDENCY_UNAVAILABLE';
          const retryable = job.attempts < 3 && (cause instanceof AiProviderError ? cause.retryable : cause instanceof EvidenceError ? cause.retryable : true);
          job.failures.push({ code, at: this.at(), attempt: job.attempts,
            ...(cause instanceof AiProviderError && UUID.test(cause.runId || '') ? { providerRunId: cause.runId } : {}) }); job.operation.state = retryable ? 'PENDING' : 'FAILED';
          const publicCode = cause instanceof AiProviderError ? ['RATE_LIMITED', 'BUDGET_EXCEEDED'].includes(code) ? 'QUOTA_EXCEEDED' : 'DEPENDENCY_UNAVAILABLE' : code;
          job.updatedAt = job.operation.updated_at = this.at(); job.operation.error = { code: publicCode, retryable, message: 'AI explanation is blocked.', correlation_id: randomUUID() };
          const providerDelay = cause instanceof AiProviderError && Number.isFinite(cause.retryAfterSeconds) ? Math.max(0, Math.min(86400, cause.retryAfterSeconds)) * 1000 : 0;
          if (retryable) job.nextAttemptAt = new Date(this.now() + Math.max(providerDelay, 1000 * 2 ** (job.attempts - 1)) + Math.floor(Math.random() * 250)).toISOString();
          delete job.lease; await this.store.saveJob(client, job); return job.operation;
        }, false);
      }
    } finally { this.active--; }
  }
  private async currentProposal(client: PoolClient, ctx: EvidenceContext, id: string, controlVersion: string) {
    const proposal = await this.store.proposal(ctx, id, client); if (!proposal) fail('NOT_FOUND', 404);
    if (proposal.hash !== proposalHash(proposal) || proposal.controlVersion !== controlVersion) fail('REVISION_CONFLICT', 409);
    const requester = { tenantId: ctx.tenantId, subject: proposal.requester };
    await this.source.authorize(client, ctx, 'ai.explain', proposal.caseId);
    await this.source.authorize(client, requester, 'ai.propose', proposal.caseId);
    const snapshot = await this.snapshot(client, ctx, proposal.caseId, proposal.snapshotHash);
    await this.snapshot(client, requester, proposal.caseId, proposal.snapshotHash);
    const action = actionInput(proposal.input, snapshot), verdict = await this.policy.evaluate(client, ctx, snapshot, action);
    enforcePolicy(verdict, snapshot, action);
    if (verdict.requiresApproval !== proposal.requiresApproval || verdict.risk !== proposal.risk || verdict.policyHash !== proposal.policyHash) fail('REVISION_CONFLICT', 409);
    return { proposal, snapshot };
  }
  private view(proposal: ActionProposal) {
    return { id: proposal.id, tenant_id: proposal.tenantId, case_id: proposal.caseId, explanation_id: proposal.explanationId,
      snapshot_sha256: proposal.snapshotHash, policy_sha256: proposal.policyHash, proposal_sha256: proposal.hash, input: proposal.input, risk: proposal.risk,
      requires_approval: proposal.requiresApproval, state: proposal.state, created_at: proposal.createdAt,
      ...(proposal.approval ? { decision_ref: proposal.approval.decisionRef } : {}), ...(proposal.receipt ? { receipt: proposal.receipt } : {}) };
  }
  async propose(ctx: EvidenceContext, explanationId: string, body: unknown, key: string) {
    this.id(ctx, explanationId);
    return this.store.transaction(ctx, async (client, controlVersion) => {
      const job = await this.readJob(client, ctx, explanationId); if (job.operation.state !== 'SUCCEEDED') fail('INVALID_STATE', 409);
      await this.source.authorize(client, ctx, 'ai.propose', job.caseId);
      const input = actionInput(body, job.snapshot);
      if (input.fact_ids?.some(id => !job.result.statements.some(statement => statement.fact_id === id))) fail('INVALID_REQUEST');
      const verdict = await this.policy.evaluate(client, ctx, job.snapshot, input); enforcePolicy(verdict, job.snapshot, input);
      return this.store.command(client, ctx, this.command(ctx, '/ai/explanations/' + explanationId + '/proposals', key, input), async () => {
        const proposal: ActionProposal = { id: randomUUID(), tenantId: ctx.tenantId, explanationId, caseId: job.caseId, requester: ctx.subject,
          snapshotHash: job.snapshot.hash, policyHash: verdict.policyHash, controlVersion, input, risk: verdict.risk, requiresApproval: verdict.requiresApproval,
          hash: '', state: verdict.requiresApproval ? 'AWAITING_APPROVAL' : 'READY', createdAt: this.at() };
        proposal.hash = proposalHash(proposal); await this.store.saveProposal(client, proposal); return this.view(proposal);
      });
    });
  }
  async proposalDetail(ctx: EvidenceContext, id: string) {
    this.id(ctx, id); return this.store.transaction(ctx, async (client, version) => this.view((await this.currentProposal(client, ctx, id, version)).proposal), false);
  }
  private async approval(client: PoolClient, ctx: EvidenceContext, proposal: ActionProposal, ref: unknown) {
    if (!refValid(ref) || ref.pack_id !== 'platform' || ref.type !== 'decision' || ctx.subject === proposal.requester) fail('FORBIDDEN', 403);
    await this.source.authorize(client, ctx, 'ai.approve', proposal.caseId);
    const approval = await this.approvals.verify(client, ctx, proposal, ref);
    if (!approval || Object.keys(approval).some(key => !['decisionRef', 'proposalHash', 'policyHash', 'approver', 'approvedAt', 'decisionVersion', 'state'].includes(key)) ||
      approval.state !== 'APPROVED' || fingerprint(approval.decisionRef) !== fingerprint(ref) || approval.proposalHash !== proposal.hash || approval.policyHash !== proposal.policyHash ||
      approval.approver !== ctx.subject || approval.approver === proposal.requester || !approval.decisionVersion || approval.decisionVersion.length > 120 ||
      !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(approval.approvedAt) || !Number.isFinite(Date.parse(approval.approvedAt)) || Date.parse(approval.approvedAt) > this.now() + 5000) fail('FORBIDDEN', 403);
    return approval;
  }
  async attachApproval(ctx: EvidenceContext, id: string, body: unknown, key: string) {
    this.id(ctx, id);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !('decision_ref' in body)) fail('INVALID_REQUEST');
    const ref = (body as { decision_ref: unknown }).decision_ref;
    return this.store.transaction(ctx, async (client, version) => {
      await this.store.lock(client, ctx, 'proposal', id); const { proposal } = await this.currentProposal(client, ctx, id, version);
      if (!proposal.requiresApproval) fail('INVALID_STATE', 409);
      const approval = await this.approval(client, ctx, proposal, ref);
      if (proposal.approval && fingerprint(proposal.approval) !== fingerprint(approval)) fail('REVISION_CONFLICT', 409);
      return this.store.command(client, ctx, this.command(ctx, '/ai/proposals/' + id + '/approval', key, { decision_ref: ref }), async () => {
        if (!proposal.approval) { proposal.approval = approval; proposal.state = 'APPROVED'; await this.store.saveProposal(client, proposal); }
        return this.view(proposal);
      });
    });
  }
  async execute(ctx: EvidenceContext, id: string, body: unknown, key: string) {
    this.id(ctx, id);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) fail('INVALID_REQUEST');
    return this.store.transaction(ctx, async (client, version) => {
      await this.store.lock(client, ctx, 'proposal', id); const { proposal, snapshot } = await this.currentProposal(client, ctx, id, version);
      await this.source.authorize(client, ctx, 'ai.execute', proposal.caseId);
      if (proposal.requiresApproval) {
        if (!proposal.approval || !['APPROVED', 'EXECUTED'].includes(proposal.state)) fail('FORBIDDEN', 403);
        const live = await this.approval(client, { tenantId: ctx.tenantId, subject: proposal.approval.approver }, proposal, proposal.approval.decisionRef);
        if (fingerprint(live) !== fingerprint(proposal.approval)) fail('REVISION_CONFLICT', 409);
      }
      return this.store.command(client, ctx, this.command(ctx, '/ai/proposals/' + id + '/execute', key, {}), async () => {
        if (proposal.state === 'EXECUTED') return this.view(proposal);
        if (proposal.input.tool === 'case.read_summary') {
          proposal.receipt = { action_id: proposal.id, resource_ref: snapshot.caseRef, sha256: fingerprint(snapshot.facts.filter(f => proposal.input.fact_ids.includes(f.id))), executed_at: this.at() };
        } else proposal.receipt = await this.executor.executeInTransaction(client, ctx, snapshot, proposal);
        const receipt = proposal.receipt;
        if (!receipt || Object.keys(receipt).some(key => !['action_id', 'resource_ref', 'sha256', 'executed_at'].includes(key)) || receipt.action_id !== proposal.id ||
          !refValid(receipt.resource_ref) || receipt.resource_ref.pack_id !== 'openresolve' || !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
          !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(receipt.executed_at) || !Number.isFinite(Date.parse(receipt.executed_at))) fail('INVALID_STATE', 409);
        proposal.state = 'EXECUTED'; await this.store.saveProposal(client, proposal); return this.view(proposal);
      });
    });
  }
}
