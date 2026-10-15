/* SPDX-License-Identifier: MIT */
import { PoolClient } from 'pg';
import { EvidenceService } from '../evidence/evidence.service';
import { EvidenceContext, fail } from '../evidence/evidence.types';
import { contextValid, fingerprint, UUID } from '../evidence/file-safety';
import { LineageAccess, LineageStore, ResourceRef, ResourceSnapshot } from './lineage.types';
export interface PersistedResourceInspector {
  // Resolve persisted immutable versions from the owning pack, under current tenant/resource authority.
  // Neither model output nor caller-supplied payloads can supply these facts.
  inspect(client: PoolClient, context: EvidenceContext, ref: ResourceRef): Promise<{ tenantId: string; evidenceIds: string[]; snapshot: ResourceSnapshot }>;
}
export class EvaluationLineageWriter {
  constructor(private readonly store: LineageStore, private readonly evidence: Pick<EvidenceService, 'detail'>,
    private readonly access: LineageAccess, private readonly inspector: PersistedResourceInspector) {
    if (!inspector?.inspect || !access?.check) throw new Error('Persisted resource inspection and current authority are required.');
  }
  // Called by the owning match/decision adapter in its domain transaction. No public link-writing API.
  async capture(client: PoolClient, context: EvidenceContext, evidenceId: string, from: ResourceRef, to: ResourceRef,
    relation: 'EVALUATED_BY' | 'SUPPORTS', occurredAt: string) {
    contextValid(context);
    if (!UUID.test(evidenceId) || !['EVALUATED_BY', 'SUPPORTS'].includes(relation)) fail('INVALID_REQUEST');
    const source = await this.evidence.detail(context, evidenceId);
    const snapshots: ResourceSnapshot[] = [];
    for (const ref of [from, to]) {
      await this.access.check(context, 'lineage.record', ref);
      const inspected = await this.inspector.inspect(client, context, ref);
      if (!inspected || inspected.tenantId !== context.tenantId || !inspected.evidenceIds.includes(evidenceId) ||
        fingerprint(inspected.snapshot.ref) !== fingerprint(ref)) fail('NOT_FOUND', 404);
      snapshots.push(inspected.snapshot);
    }
    if (snapshots[0].metadata.source_sha256 !== source.sha256) fail('REVISION_CONFLICT', 409);
    for (const ref of [from, to]) await this.access.check(context, 'lineage.record', ref);
    await this.store.append(client, context, evidenceId, [{ from: snapshots[0], to: snapshots[1], relation, createdAt: occurredAt }]);
  }
}
