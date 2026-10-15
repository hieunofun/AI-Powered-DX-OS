/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { EvidenceService } from '../../platform/evidence/evidence.service';
import { EvidenceContext, fail } from '../../platform/evidence/evidence.types';
import { checksum, contextValid, fingerprint, idempotencyKey, UUID } from '../../platform/evidence/file-safety';
import { ONBOARDING_MANIFEST } from './onboarding.manifest';
import { accessInput, binding, caseView, CHECKLIST, checklistInput, createInput, decisionInput, SCOPES, utc } from './onboarding-validation';
import { AccessRequest, CapabilityPackRuntime, OnboardingBinding, OnboardingCase, OnboardingCommand, OnboardingDecisionPort, OnboardingEvidenceBindings, OnboardingOperation, OnboardingStore } from './onboarding.types';
export class OnboardingService {
  constructor(private readonly store: OnboardingStore, private readonly runtime: CapabilityPackRuntime,
    private readonly evidence: Pick<EvidenceService, 'detail' | 'withCleanBytes'>, private readonly sources: OnboardingEvidenceBindings,
    private readonly decisions: OnboardingDecisionPort, private readonly now: () => number = Date.now) {
    if (!runtime?.require || !sources?.inspect || !decisions?.verify || !evidence?.withCleanBytes) throw new Error('Current owning capability/evidence/decision ports are mandatory.');
  }
  private at() { return new Date(this.now()).toISOString(); }
  private id(ctx: EvidenceContext, id: string) { contextValid(ctx); if (typeof id !== 'string' || !UUID.test(id)) fail('INVALID_REQUEST'); }
  private ref(id: string) { return { pack_id: 'onboarding', type: 'case', id }; }
  private command(ctx: EvidenceContext, route: string, body: unknown, key: string): OnboardingCommand {
    idempotencyKey(key); return { scope: fingerprint([ctx.tenantId, ctx.subject, 'POST', route, key]), hash: fingerprint(body) };
  }
  async authorize(client: PoolClient, ctx: EvidenceContext, permission: string, record?: OnboardingCase): Promise<OnboardingBinding> {
    const declared: readonly string[] = ONBOARDING_MANIFEST.permissions; if (!declared.includes(permission)) fail('FORBIDDEN', 403);
    const value = binding(ctx, permission, await this.runtime.require(client, ctx, 'onboarding', permission, record ? this.ref(record.id) : undefined));
    if (record && (record.tenantId !== ctx.tenantId || record.manifestSha256 !== value.manifest_sha256 ||
      fingerprint({ workflow: record.binding.workflow, policy: record.binding.policy_ref }) !== fingerprint({ workflow: value.workflow, policy: value.policy_ref }))) fail('REVISION_CONFLICT', 409);
    return value;
  }
  async read(client: PoolClient, ctx: EvidenceContext, id: string, permission: string) {
    const record = await this.store.read(ctx, id, client); if (!record) fail('NOT_FOUND', 404); await this.authorize(client, ctx, permission, record); return record;
  }
  async create(ctx: EvidenceContext, body: unknown, key: string) {
    contextValid(ctx); const input = createInput(body), command = this.command(ctx, '/onboarding/cases', input, key);
    return this.store.transaction(ctx, async client => {
      const current = await this.authorize(client, ctx, 'onboarding.case.create');
      const result = await this.store.command(client, ctx, command, async () => {
        const at = this.at(), record: OnboardingCase = { id: randomUUID(), tenantId: ctx.tenantId, requester: ctx.subject, displayLabel: input.display_label,
          createdAt: at, updatedAt: at, manifestSha256: current.manifest_sha256, binding: current, checklist: [], state: 'COLLECTING', operations: [], provisioningState: 'NOT_PROVISIONED' };
        await this.store.save(client, ctx, undefined, record); return caseView(record);
      });
      await this.read(client, ctx, result.id, 'onboarding.case.read'); return result;
    });
  }
  async detail(ctx: EvidenceContext, id: string) { this.id(ctx, id); return this.store.transaction(ctx, async client => caseView(await this.read(client, ctx, id, 'onboarding.case.read'))); }
  async operation(ctx: EvidenceContext, id: string) {
    this.id(ctx, id); const record = await this.store.operation(ctx, id); if (!record) return;
    return this.store.transaction(ctx, async client => (await this.read(client, ctx, record.id, 'onboarding.case.read')).operations.find(operation => operation.id === id));
  }
  private latest(record: OnboardingCase) {
    return CHECKLIST.map(code => record.checklist.filter(receipt => receipt.code === code).sort((a, b) => b.revision - a.revision)[0]).filter(Boolean);
  }
  private async inspect(client: PoolClient, ctx: EvidenceContext, id: string, hash: string) {
    const source = await this.sources.inspect(client, ctx, id, hash);
    if (!source || source.evidence?.tenant_id !== ctx.tenantId || source.evidence.id !== id || source.evidence.quarantine_state !== 'CLEAN' ||
      source.evidence.sha256 !== hash || source.rawSnapshot?.ref.pack_id !== 'platform' || source.rawSnapshot.ref.type !== 'evidence' ||
      source.rawSnapshot.ref.id !== id || source.rawSnapshot.sha256 !== hash || source.rawSnapshot.version !== 'blob-1') fail('FILE_NOT_CLEAN', 409);
    return source;
  }
  async recordChecklist(ctx: EvidenceContext, id: string, code: string, body: unknown, key: string) {
    this.id(ctx, id); const input = checklistInput(code, body), command = this.command(ctx, '/onboarding/cases/' + id + '/checklist/' + code, input, key);
    await this.detail(ctx, id);
    return this.evidence.withCleanBytes(ctx, input.evidence_id, 'evidence.download', async (bytes, recheck) => {
      const hash = checksum(bytes); await recheck();
      return this.store.transaction(ctx, async client => {
        await this.store.lock(client, ctx, id); const record = await this.read(client, ctx, id, 'onboarding.checklist.record');
        await this.inspect(client, ctx, input.evidence_id, hash); await recheck();
        return this.store.command(client, ctx, command, async () => {
          if (record.request || record.state !== 'COLLECTING' || record.requester !== ctx.subject) fail('INVALID_STATE', 409);
          const previous = this.latest(record).find(receipt => receipt.code === code); if ((previous?.revision || 0) !== input.expected_revision) fail('REVISION_CONFLICT', 409);
          const before = structuredClone(record); record.checklist.push({ id: randomUUID(), code: input.code, revision: input.expected_revision + 1, acknowledged: true,
            evidence_id: input.evidence_id, sha256: hash, recorded_by: ctx.subject, recorded_at: this.at() }); record.updatedAt = this.at();
          await this.store.save(client, ctx, before, record); return caseView(record);
        });
      });
    });
  }
  private operationFor(ctx: EvidenceContext, record: OnboardingCase, kind: OnboardingOperation['kind']): OnboardingOperation {
    return { id: randomUUID(), tenant_id: ctx.tenantId, kind, state: 'PENDING', created_at: this.at(), updated_at: this.at(), resource_ref: this.ref(record.id) };
  }
  async sourceGuard(client: PoolClient, ctx: EvidenceContext, record: OnboardingCase) {
    const requester = { tenantId: ctx.tenantId, subject: record.requester }; await this.authorize(client, requester, 'onboarding.access.request', record);
    for (const receipt of record.request?.checklist || this.latest(record)) {
      await this.inspect(client, requester, receipt.evidence_id, receipt.sha256);
      if (ctx.subject !== requester.subject) await this.inspect(client, ctx, receipt.evidence_id, receipt.sha256);
    }
  }
  async byteGuard(ctx: EvidenceContext, record: OnboardingCase) {
    const requester = { tenantId: ctx.tenantId, subject: record.requester };
    for (const receipt of record.request?.checklist || this.latest(record)) for (const actor of ctx.subject === requester.subject ? [requester] : [requester, ctx]) {
      await this.evidence.withCleanBytes(actor, receipt.evidence_id, 'evidence.download', async (bytes, recheck) => {
        if (checksum(bytes) !== receipt.sha256) fail('CHECKSUM_MISMATCH', 422); await recheck();
      });
    }
  }
  async submit(ctx: EvidenceContext, id: string, body: unknown, key: string) {
    this.id(ctx, id); const input = accessInput(body), command = this.command(ctx, '/onboarding/cases/' + id + '/access-requests', input, key);
    return this.store.transaction(ctx, async client => {
      await this.store.lock(client, ctx, id); const record = await this.read(client, ctx, id, 'onboarding.access.request'); await this.sourceGuard(client, ctx, record);
      return this.store.command(client, ctx, command, async () => {
        const checklist = this.latest(record); if (record.request || record.state !== 'COLLECTING' || record.requester !== ctx.subject || checklist.length !== CHECKLIST.length) fail('INVALID_STATE', 409);
        const before = structuredClone(record), request: AccessRequest = { id: randomUUID(), requested_for: record.requester, profile: input.access_profile,
          requested_scopes: [...SCOPES[input.access_profile]], checklist: structuredClone(checklist), manifest_sha256: record.manifestSha256,
          policy_ref: record.binding.policy_ref, created_at: this.at(), created_by: ctx.subject };
        record.request = request; record.requestHash = fingerprint(request); const operation = this.operationFor(ctx, record, 'ONBOARDING_SUBMIT'); record.operations.push(operation);
        record.workflow = { businessKey: 'onboarding:' + ctx.tenantId + ':' + id + ':' + operation.id, definitionId: record.binding.workflow.definition_id };
        record.intent = { operationId: operation.id, kind: 'START', phase: 'READY', attempts: 0, failures: [] }; record.state = 'SUBMITTING'; record.updatedAt = this.at();
        await this.store.save(client, ctx, before, record); return operation;
      });
    });
  }
  async verifiedDecision(client: PoolClient, ctx: EvidenceContext, record: OnboardingCase, decisionRef = record.decision?.decision_ref) {
    if (!record.request || fingerprint(record.request) !== record.requestHash || ctx.subject === record.requester) fail('FORBIDDEN', 403);
    await this.authorize(client, ctx, 'onboarding.access.decide', record);
    const decision = await this.decisions.verify(client, ctx, record.request, decisionRef);
    if (!decision || !['APPROVE', 'REJECT'].includes(decision.action) || decision.approver !== ctx.subject || decision.subject_sha256 !== record.requestHash ||
      decision.subject_ref?.pack_id !== 'onboarding' || decision.subject_ref.type !== 'access-request' || decision.subject_ref.id !== record.request.id ||
      fingerprint(decision.decision_ref) !== fingerprint(decisionRef) || fingerprint(decision.policy_ref) !== fingerprint(record.binding.policy_ref) ||
      !utc(decision.approved_at) || Date.parse(decision.approved_at) > this.now() + 5000 || !decision.decision_version || decision.decision_version.length > 120 ||
      !decision.decision_snapshot || fingerprint(decision.decision_snapshot.ref) !== fingerprint(decision.decision_ref) ||
      decision.decision_snapshot.version !== decision.decision_version || !/^[a-f0-9]{64}$/.test(decision.decision_snapshot.sha256)) fail('FORBIDDEN', 403);
    if (record.decision && fingerprint(record.decision) !== fingerprint(decision)) fail('REVISION_CONFLICT', 409); return decision;
  }
  async decide(ctx: EvidenceContext, id: string, body: unknown, key: string) {
    this.id(ctx, id); const input = decisionInput(body), command = this.command(ctx, '/onboarding/cases/' + id + '/decisions', input, key);
    return this.store.transaction(ctx, async client => {
      await this.store.lock(client, ctx, id); const record = await this.read(client, ctx, id, 'onboarding.access.decide'); await this.sourceGuard(client, ctx, record);
      const decision = await this.verifiedDecision(client, ctx, record, input.decision_ref);
      return this.store.command(client, ctx, command, async () => {
        if (record.state !== 'AWAITING_APPROVAL' || record.decision || !record.workflow?.taskId) fail('INVALID_STATE', 409);
        const before = structuredClone(record), operation = this.operationFor(ctx, record, 'ONBOARDING_DECISION'); record.decision = decision; record.operations.push(operation);
        record.intent = { operationId: operation.id, kind: 'DECISION', phase: 'READY', attempts: 0, failures: [] }; record.state = 'APPLYING_DECISION'; record.updatedAt = this.at();
        await this.store.save(client, ctx, before, record); return operation;
      });
    });
  }
}
