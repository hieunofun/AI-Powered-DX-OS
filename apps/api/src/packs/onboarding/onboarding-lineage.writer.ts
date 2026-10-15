/* SPDX-License-Identifier: MIT */
import { PoolClient } from 'pg';
import { EvidenceContext, fail } from '../../platform/evidence/evidence.types';
import { fingerprint } from '../../platform/evidence/file-safety';
import { LineageEdge, LineageStore, ResourceSnapshot } from '../../platform/lineage/lineage.types';
import { OnboardingCase, OnboardingEvidenceBindings, OnboardingLineageSink } from './onboarding.types';
export class OnboardingLineageWriter implements OnboardingLineageSink {
  constructor(private readonly store: LineageStore, private readonly sources: OnboardingEvidenceBindings) {
    if (!store?.append || !sources?.inspect) throw new Error('Shared transactional lineage and actual owning evidence bindings are required.');
  }
  async capture(client: PoolClient, ctx: EvidenceContext, before: OnboardingCase | undefined, after: OnboardingCase) {
    if (after.tenantId !== ctx.tenantId) fail('INVALID_STATE', 409);
    const requester = { tenantId: ctx.tenantId, subject: after.requester };
    const node = (type: string, id: string, version: string, metadata: Record<string, unknown>): ResourceSnapshot => ({
      ref: { pack_id: 'onboarding', type, id }, version, sha256: fingerprint(metadata), metadata });
    const original = node('case', after.id, 'created-1', { requester: after.requester, created_at: after.createdAt, manifest_sha256: after.manifestSha256 });
    const fresh = after.checklist.filter(receipt => !before?.checklist.some(old => old.id === receipt.id));
    for (const receipt of fresh) {
      const source = await this.sources.inspect(client, requester, receipt.evidence_id, receipt.sha256);
      if (source.evidence.tenant_id !== ctx.tenantId || source.evidence.quarantine_state !== 'CLEAN' || source.evidence.sha256 !== receipt.sha256 ||
        source.rawSnapshot.ref.pack_id !== 'platform' || source.rawSnapshot.ref.type !== 'evidence' || source.rawSnapshot.ref.id !== receipt.evidence_id ||
        source.rawSnapshot.sha256 !== receipt.sha256 || source.rawSnapshot.version !== 'blob-1') fail('FILE_NOT_CLEAN', 409);
      const checklist = node('checklist-receipt', receipt.id, '1', { ...receipt });
      const edges: LineageEdge[] = [{ from: checklist, to: source.rawSnapshot, relation: 'DERIVED_FROM', createdAt: receipt.recorded_at },
        { from: checklist, to: original, relation: 'SUPPORTS', createdAt: receipt.recorded_at }];
      await this.store.append(client, ctx, receipt.evidence_id, edges);
    }
    if (after.request && !before?.request) {
      const request = node('access-request', after.request.id, '1', { ...after.request });
      for (const receipt of after.request.checklist) await this.store.append(client, ctx, receipt.evidence_id, [
        { from: request, to: node('checklist-receipt', receipt.id, '1', { ...receipt }), relation: 'SUPPORTS', createdAt: after.request.created_at }]);
    }
    if (after.decision && !before?.decision) {
      const decision = after.decision, request = node('access-request', after.request.id, '1', { ...after.request });
      if (fingerprint(decision.decision_snapshot.ref) !== fingerprint(decision.decision_ref)) fail('INVALID_STATE', 409);
      for (const receipt of after.request.checklist) await this.store.append(client, ctx, receipt.evidence_id, [
        { from: request, to: decision.decision_snapshot, relation: 'EVALUATED_BY', createdAt: decision.approved_at }]);
    }
    if (after.state === 'COMPLETED' && before?.state !== 'COMPLETED') {
      const completed = node('case', after.id, 'completed-1', { state: after.state, completed_at: after.updatedAt, request_sha256: after.requestHash,
        process_id: after.workflow.processId, decision_ref: after.decision.decision_ref, provisioning_state: after.provisioningState });
      for (const receipt of after.request.checklist) await this.store.append(client, ctx, receipt.evidence_id, [
        { from: completed, to: after.decision.decision_snapshot, relation: 'SUPPORTS', createdAt: after.updatedAt }]);
    }
  }
}
