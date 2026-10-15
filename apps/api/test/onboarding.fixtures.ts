/* SPDX-License-Identifier: MIT */
// Deterministic memory/engine/identity/decision doubles; NOT runtime acceptance.
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { Evidence, EvidenceContext, fail } from '../src/platform/evidence/evidence.types';
import { checksum, fingerprint } from '../src/platform/evidence/file-safety';
import { EngineError } from '../src/platform/workflow/flowable.transport';
import { WorkflowEnginePort } from '../src/platform/workflow/workflow-engine.port';
import { OnboardingBinding, OnboardingCase, OnboardingCommand, OnboardingStore, VerifiedOnboardingDecision } from '../src/packs/onboarding/onboarding.types';
import { ONBOARDING_MANIFEST } from '../src/packs/onboarding/onboarding.manifest';
import { OnboardingService } from '../src/packs/onboarding/onboarding.service';
import { OnboardingWorker } from '../src/packs/onboarding/onboarding.worker';
const copy = <T>(value: T): T => structuredClone(value);
export const tenant = '00000000-0000-4000-8000-000000000060';
export const requester = { tenantId: tenant, subject: 'fixture-requester' };
export const reviewer = { tenantId: tenant, subject: 'fixture-reviewer' };
export const processor = { tenantId: tenant, subject: 'fixture-worker' };
export const foreign = { tenantId: '00000000-0000-4000-8000-000000000061', subject: requester.subject };
export class MemoryOnboardingStore implements OnboardingStore {
  records = new Map<string, OnboardingCase>(); commands = new Map<string, { hash: string; response: any }>();
  history: OnboardingCase[] = []; failSave = false; private queue = Promise.resolve();
  async transaction<T>(_ctx: EvidenceContext, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const previous = copy({ records: this.records, commands: this.commands, history: this.history });
      try { return await work({} as PoolClient); } catch (cause) { Object.assign(this, previous); throw cause; }
    }); this.queue = result.then(() => undefined, () => undefined); return result;
  }
  async read(ctx: EvidenceContext, id: string) { return copy(this.records.get(ctx.tenantId + ':' + id)); }
  async operation(ctx: EvidenceContext, id: string) { return copy([...this.records.values()].find(record => record.tenantId === ctx.tenantId && record.operations.some(op => op.id === id))); }
  async lock() {}
  async save(_client: PoolClient, ctx: EvidenceContext, _before: OnboardingCase | undefined, after: OnboardingCase) {
    this.records.set(ctx.tenantId + ':' + after.id, copy(after)); this.history.push(copy(after));
    if (this.failSave) throw new Error('Injected transaction/lineage failure');
  }
  async command<T>(_client: PoolClient, ctx: EvidenceContext, command: OnboardingCommand, work: () => Promise<T>): Promise<T> {
    const address = ctx.tenantId + ':' + command.scope, old = this.commands.get(address);
    if (old) { if (old.hash !== command.hash) fail('IDEMPOTENCY_CONFLICT', 409); return copy(old.response); }
    const response = await work(); this.commands.set(address, { hash: command.hash, response: copy(response) }); return response;
  }
  async candidate(ctx: EvidenceContext, at: string) {
    return [...this.records.values()].find(record => record.tenantId === ctx.tenantId && record.intent && record.intent.phase !== 'DONE' && record.intent.attempts < 3 &&
      (!record.intent.lease || record.intent.lease.until <= at) && (!record.intent.nextAttemptAt || record.intent.nextAttemptAt <= at))?.id;
  }
}
export class MemoryOnboardingEngine implements WorkflowEnginePort {
  rows: any[] = []; taskRow: any; historyRow: any; starts = 0; claims = 0; completions = 0;
  fault: 'start-after' | 'start-before' | 'claim-after' | 'complete-after' | undefined;
  afterWrite?: () => void; duplicate = false; wrongGroup = false;
  constructor(private readonly at: () => string) {}
  async start(definitionId: string, businessKey: string, variables: Record<string, string | boolean>) {
    this.starts++; if (this.fault === 'start-before') throw new EngineError(true);
    const row = { id: randomUUID(), businessKey, processDefinitionId: definitionId, endTime: null };
    this.rows.push(row); this.taskRow = { id: randomUUID(), processInstanceId: row.id, taskDefinitionKey: 'access_review', name: 'Fixture review', assignee: null, group: variables.reviewerGroup };
    this.afterWrite?.(); if (this.fault === 'start-after') { this.fault = undefined; throw new EngineError(false); } return copy(row);
  }
  async processes(key: string) { const rows = this.rows.filter(row => row.businessKey === key); return copy(this.duplicate && rows.length ? [...rows, { ...rows[0], id: randomUUID() }] : rows); }
  async process(id: string) { return copy(this.rows.find(row => row.id === id) || null); }
  async tasks(id: string) { return copy(this.taskRow?.processInstanceId === id && !this.historyRow?.endTime ? [this.taskRow] : []); }
  async task(id: string) { return copy(this.taskRow?.id === id && !this.historyRow?.endTime ? this.taskRow : null); }
  async historicTask(id: string) { return copy(this.historyRow?.id === id ? this.historyRow : null); }
  async identityLinks() { return [{ type: 'candidate', groupId: this.wrongGroup ? 'wrong-group' : this.taskRow.group }]; }
  async claim(id: string, subject: string) {
    this.claims++; if (this.taskRow?.id !== id) throw new EngineError(true); this.taskRow.assignee = subject; this.afterWrite?.();
    if (this.fault === 'claim-after') { this.fault = undefined; throw new EngineError(false); }
  }
  async complete(id: string, _action: string, operationId: string) {
    this.completions++; if (this.taskRow?.id !== id) throw new EngineError(true);
    this.historyRow = { ...this.taskRow, endTime: this.at(), variables: [{ name: 'applicationOperationId', value: operationId, scope: 'local' }] };
    this.rows.find(row => row.id === this.taskRow.processInstanceId).endTime = this.at(); this.afterWrite?.();
    if (this.fault === 'complete-after') { this.fault = undefined; throw new EngineError(false); }
  }
}
export function onboardingFixture() {
  let time = Date.parse('2026-10-15T18:30:00.000Z'); const now = () => time, at = () => new Date(now()).toISOString();
  const store = new MemoryOnboardingStore(), engine = new MemoryOnboardingEngine(at), denied = new Set<string>(), evidenceId = randomUUID();
  const bytes = Buffer.from('synthetic acknowledged policy'), hash = checksum(bytes);
  const evidence: Evidence = { id: evidenceId, tenant_id: tenant, filename: 'synthetic.xml', media_type: 'application/xml', size_bytes: bytes.length, sha256: hash,
    source: { kind: 'USER_UPLOAD' }, retention_class: 'STANDARD', quarantine_state: 'CLEAN', processing_state: 'NOT_STARTED', created_at: at(), updated_at: at(), created_by: requester.subject, revision: 1, legal_hold: false };
  const current: OnboardingBinding = { manifest_sha256: fingerprint(ONBOARDING_MANIFEST), core_version: '1.0.0', enabled: true,
    workflow: { ref: copy(ONBOARDING_MANIFEST.workflow_refs[0]), definition_id: 'onboarding_access_review_v1:1:fixture-definition', process_key: 'onboarding_access_review_v1', reviewer_group: 'onboarding-reviewer-' + tenant },
    policy_ref: { id: randomUUID(), version: '1.0.0', sha256: 'b'.repeat(64) } };
  const decisions = new Map<string, VerifiedOnboardingDecision>(); let readBytes = Buffer.from(bytes);
  const allowed = (ctx: EvidenceContext) => { if (ctx.tenantId !== tenant || denied.has(ctx.subject)) fail('FORBIDDEN', 403); };
  const runtime = { require: async (_client: PoolClient, ctx: EvidenceContext, _pack: string, permission: string) => {
    allowed(ctx); const actor = ctx.subject === processor.subject ? 'worker' : ctx.subject === reviewer.subject ? 'reviewer' : 'requester';
    const roles = { 'onboarding.case.create': ['requester'], 'onboarding.case.read': ['requester', 'reviewer', 'worker'], 'onboarding.checklist.record': ['requester'],
      'onboarding.access.request': ['requester'], 'onboarding.access.decide': ['reviewer'], 'onboarding.workflow.process': ['worker'], 'onboarding.workflow.reconcile': ['worker'] };
    if (!roles[permission]?.includes(actor) || denied.has(permission)) fail('FORBIDDEN', 403); return copy(current);
  } };
  const sources = { inspect: async (_client: PoolClient, ctx: EvidenceContext, id: string, expected: string) => {
    allowed(ctx); if (denied.has('evidence:' + ctx.subject)) fail('FORBIDDEN', 403);
    if (id !== evidenceId || expected !== evidence.sha256 || evidence.quarantine_state !== 'CLEAN') fail('FILE_NOT_CLEAN', 409);
    return { evidence: copy(evidence), rawSnapshot: { ref: { pack_id: 'platform', type: 'evidence', id }, version: 'blob-1', sha256: evidence.sha256, metadata: { media_type: evidence.media_type, size_bytes: evidence.size_bytes, source_sha256: evidence.sha256, retention_class_at_registration: evidence.retention_class, created_at: evidence.created_at } } };
  } };
  const evidenceService = { detail: async () => copy(evidence), withCleanBytes: async (ctx, id, _action, work) => {
    const check = () => sources.inspect({} as PoolClient, ctx, id, hash).then(() => undefined); await check(); return work(Buffer.from(readBytes), check);
  } };
  const decisionPort = { verify: async (_client, ctx: EvidenceContext, _request, ref) => {
    allowed(ctx); const decision = decisions.get(ref?.id); if (!decision || denied.has('decision')) fail('FORBIDDEN', 403); return copy(decision);
  } };
  const service = new OnboardingService(store, runtime, evidenceService, sources, decisionPort, now);
  const worker = () => new OnboardingWorker(store, service, engine, now);
  const create = () => service.create(requester, { display_label: 'Fictional employee' }, randomUUID());
  const checklist = async (id: string) => { for (const code of ['WELCOME_ACK', 'ACCESS_POLICY_ACK']) await service.recordChecklist(requester, id, code, { evidence_id: evidenceId, acknowledged: true, expected_revision: 0 }, randomUUID()); };
  const submit = (id: string) => service.submit(requester, id, { access_profile: 'DOCS_READ_ONLY' }, randomUUID());
  const ready = async () => { const record = await create(); await checklist(record.id); await submit(record.id); return record.id; };
  const awaiting = async () => { const id = await ready(); await worker().processNext(processor); return id; };
  const decision = async (id: string, action: 'APPROVE' | 'REJECT' = 'APPROVE') => {
    const record = await store.read(requester, id), ref = { pack_id: 'platform', type: 'decision', id: randomUUID() };
    const content = { request_sha256: record.requestHash, action, approver: reviewer.subject, policy_ref: current.policy_ref };
    decisions.set(ref.id, { decision_ref: ref, action, approver: reviewer.subject, subject_ref: { pack_id: 'onboarding', type: 'access-request', id: record.request.id },
      subject_sha256: record.requestHash, policy_ref: copy(current.policy_ref), decision_version: '1', approved_at: at(), decision_snapshot: { ref, version: '1', sha256: fingerprint(content), metadata: content } }); return ref;
  };
  const deciding = async (action: 'APPROVE' | 'REJECT' = 'APPROVE') => { const id = await awaiting(), ref = await decision(id, action); await service.decide(reviewer, id, { decision_ref: ref }, randomUUID()); return id; };
  return { store, engine, denied, evidence, evidenceId, current, decisions, service, worker, create, checklist, submit, ready, awaiting, decision, deciding,
    advance: (ms: number) => { time += ms; }, tamper: () => { readBytes = Buffer.from('tampered'); } };
}
