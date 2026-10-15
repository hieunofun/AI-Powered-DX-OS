/* SPDX-License-Identifier: MIT */
// Isolated doubles. No claim of PostgreSQL, production policy/decision/SSO or actual domain execution.
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { checksum, fingerprint } from '../src/platform/evidence/file-safety';
import { EvidenceContext, fail } from '../src/platform/evidence/evidence.types';
import { ActionProposal, CaseSnapshot, Command, ExplanationJob, MediationStore, VerifiedApproval } from '../src/packs/openresolve/mediation/mediation.types';
import { AiMediationService } from '../src/packs/openresolve/mediation/mediation.service';
import { TOOLS } from '../src/packs/openresolve/mediation/mediation-validation';
export class MemoryMediationStore implements MediationStore {
  enabled = true; version = '1'; jobs = new Map<string, ExplanationJob>(); proposals = new Map<string, ActionProposal>();
  commands = new Map<string, { hash: string; result: unknown }>(); effects = new Map<string, unknown>(); history: unknown[] = [];
  private tail = Promise.resolve();
  async transaction<T>(_ctx: EvidenceContext, work: (client: PoolClient, version: string) => Promise<T>, requireEnabled = true): Promise<T> {
    const previous = this.tail; let release: () => void; this.tail = new Promise<void>(resolve => { release = resolve; }); await previous;
    const backup = structuredClone({ jobs: this.jobs, proposals: this.proposals, commands: this.commands, effects: this.effects, history: this.history });
    try { if (requireEnabled && !this.enabled) fail('DEPENDENCY_UNAVAILABLE', 503); return await work({} as PoolClient, this.version); }
    catch (error) { Object.assign(this, backup); throw error; } finally { release(); }
  }
  async job(ctx: EvidenceContext, id: string) { const job = this.jobs.get(id); return job?.tenantId === ctx.tenantId ? structuredClone(job) : undefined; }
  async operation(ctx: EvidenceContext, id: string) { return structuredClone([...this.jobs.values()].find(job => job.tenantId === ctx.tenantId && job.operation.id === id)); }
  async saveJob(_client: PoolClient, job: ExplanationJob) { this.jobs.set(job.id, structuredClone(job)); this.history.push(structuredClone(job)); }
  async candidate(ctx: EvidenceContext, now: string) { return [...this.jobs.values()].find(job => job.tenantId === ctx.tenantId && ['PENDING', 'RUNNING'].includes(job.operation.state) &&
    (!job.lease || job.lease.until <= now) && (!job.nextAttemptAt || job.nextAttemptAt <= now))?.id; }
  async lock() {}
  async proposal(ctx: EvidenceContext, id: string) { const proposal = this.proposals.get(id); return proposal?.tenantId === ctx.tenantId ? structuredClone(proposal) : undefined; }
  async saveProposal(_client: PoolClient, proposal: ActionProposal) { this.proposals.set(proposal.id, structuredClone(proposal)); this.history.push(structuredClone(proposal)); }
  async command<T>(_client: PoolClient, ctx: EvidenceContext, command: Command, work: () => Promise<T>): Promise<T> {
    const key = ctx.tenantId + ':' + command.scope, existing = this.commands.get(key);
    if (existing) { if (existing.hash !== command.hash) fail('IDEMPOTENCY_CONFLICT', 409); return structuredClone(existing.result) as T; }
    const result = await work(); this.commands.set(key, { hash: command.hash, result: structuredClone(result) }); return result;
  }
}
export function mediationFixture() {
  const store = new MemoryMediationStore(), tenant = randomUUID(), caseId = randomUUID(), bytes = Buffer.from('Explicitly fictional, clean evidence fixture');
  const contexts = { requester: { tenantId: tenant, subject: 'requester' }, worker: { tenantId: tenant, subject: 'worker' }, approver: { tenantId: tenant, subject: 'approver' }, foreign: { tenantId: randomUUID(), subject: 'requester' } };
  let time = Date.now(); const active = new Set(['requester', 'worker', 'approver']), decisions = new Map<string, VerifiedApproval>();
  const content = { tenantId: tenant, caseRef: { pack_id: 'openresolve', type: 'case', id: caseId }, version: '1',
    policy: { ref: { pack_id: 'platform', type: 'policy', id: randomUUID() }, version: '1.0.0', sha256: 'c'.repeat(64) },
    facts: [{ id: randomUUID(), code: 'INVOICE', label: 'Supplier', value: 'FICTIONAL Supplier', evidenceId: randomUUID(), evidenceHash: checksum(bytes), factsVersion: 'confirmed-1' }],
    requiredFactCodes: ['INVOICE', 'RECEIPT'], disclosure: 'SYNTHETIC' as const };
  const snapshot: CaseSnapshot = { ...content, hash: fingerprint(content) };
  const state = { policyAllowed: true, clean: true, failExecution: false };
  const source = { authorize: jest.fn(async (_client, ctx, action, id) => {
    if (ctx.tenantId !== tenant || id && id !== caseId) fail('NOT_FOUND', 404); if (!active.has(ctx.subject)) fail('FORBIDDEN', 403);
    if (action === 'ai.process' && ctx.subject !== 'worker' || action === 'ai.approve' && ctx.subject !== 'approver') fail('FORBIDDEN', 403);
  }), load: jest.fn(async (_client, ctx, id) => {
    if (ctx.tenantId !== tenant || id !== caseId) fail('NOT_FOUND', 404); if (!active.has(ctx.subject) || !state.clean) fail('FORBIDDEN', 403); return structuredClone(snapshot);
  }) };
  const evidence = { withCleanBytes: jest.fn(async (ctx, _id, _action, work) => {
    if (!active.has(ctx.subject) || !state.clean) fail('FORBIDDEN', 403); return work(bytes, async () => { if (!state.clean || !active.has(ctx.subject)) fail('FORBIDDEN', 403); });
  }) };
  const provider = { select: jest.fn(async (input, _disclosure, recheck) => {
    await recheck(); return { fact_aliases: input.facts.map(f => f.alias), suggested_tool: 'NONE' as const,
      provenance: { provider: 'gemini' as const, model_version: 'gemini-fixture-1', prompt_version: 'fixture', run_id: randomUUID() }, usage: { input_tokens: 100, reserved_tokens: 200 } };
  }) };
  const policy = { evaluate: jest.fn(async (_client, _ctx, s, action) => ({ effect: state.policyAllowed ? 'ALLOW' as const : 'DENY' as const, policyHash: s.policy.sha256, risk: TOOLS[action.tool], requiresApproval: TOOLS[action.tool] !== 'R0' })) };
  const approvals = { verify: jest.fn(async (_client, ctx, _proposal, ref) => {
    const decision = decisions.get(ref.id); if (!decision || decision.approver !== ctx.subject || !active.has(ctx.subject)) fail('FORBIDDEN', 403); return structuredClone(decision);
  }) };
  const executor = { executeInTransaction: jest.fn(async (_client, _ctx, _snapshot, proposal) => {
    store.effects.set(proposal.id, structuredClone(proposal.input)); if (state.failExecution) throw new Error('Fixture exception after local effect');
    return { action_id: proposal.id, resource_ref: { pack_id: 'openresolve', type: 'case-action', id: randomUUID() }, sha256: fingerprint(proposal.input), executed_at: new Date(time).toISOString() };
  }) };
  const createService = () => new AiMediationService(store, source, evidence, provider, policy, approvals, executor, () => time);
  const service = createService();
  const decision = (proposalId: string) => { const proposal = store.proposals.get(proposalId), ref = { pack_id: 'platform', type: 'decision', id: randomUUID() };
    decisions.set(ref.id, { decisionRef: ref, proposalHash: proposal.hash, policyHash: proposal.policyHash, approver: 'approver', approvedAt: new Date(time).toISOString(), decisionVersion: '1', state: 'APPROVED' }); return ref; };
  const rehash = () => { const content: Partial<CaseSnapshot> = { ...snapshot }; delete content.hash; snapshot.hash = fingerprint(content); };
  return { store, tenant, caseId, contexts, active, snapshot, state, source, evidence, provider, policy, approvals, executor, service, createService, decision, decisions, rehash,
    advance: (ms = 10000) => { time += ms; } };
}
