/* SPDX-License-Identifier: MIT */
import { PoolClient } from 'pg';
import { Evidence, EvidenceContext } from '../../../platform/evidence/evidence.types';
import { fingerprint } from '../../../platform/evidence/file-safety';
import { LineageEdge, LineageStore, ResourceSnapshot } from '../../../platform/lineage/lineage.types';
import { rawEvidenceSnapshot } from '../../../platform/lineage/raw-evidence.snapshot';
import { AuthorizedOrderSnapshot, ConnectorCaseRequest, ConnectorLineageSink, SourceObservation } from './ingress.types';
function native(record: SourceObservation): ResourceSnapshot {
  return { ref: { pack_id: 'openresolve', type: 'source-observation', id: record.id }, version: 'native-1', sha256: record.contentHash,
    metadata: { source_id: record.sourceId, kind: record.kind, source_event_id: record.event.source_event_id, schema_id: record.event.schema_id,
      observed_at: record.event.observed_at, received_at: record.receivedAt, requested_by: record.requestedBy, simulated: record.simulated, raw_sha256: record.rawHash, witness_version: record.witnessVersion } };
}
export class ConnectorLineageWriter implements ConnectorLineageSink {
  constructor(private readonly store: LineageStore) {}
  async capture(client: PoolClient, context: EvidenceContext, record: SourceObservation, evidence: Evidence, order: AuthorizedOrderSnapshot, request?: ConnectorCaseRequest, original?: SourceObservation) {
    if (record.tenantId !== context.tenantId || order.tenantId !== context.tenantId || original && original.tenantId !== context.tenantId ||
      !record.evidenceId || !record.evidenceSha256 || evidence.id !== record.evidenceId || evidence.tenant_id !== context.tenantId || evidence.sha256 !== record.evidenceSha256) throw new Error('Connector lineage scope mismatch.');
    const observation = native(record), witness = rawEvidenceSnapshot(evidence);
    const po: ResourceSnapshot = { ref: { pack_id: 'openresolve', type: 'purchase-order', id: order.purchaseOrderId }, version: fingerprint(order.sourceVersion), sha256: fingerprint(order), metadata: { source_version: order.sourceVersion } };
    const edges: LineageEdge[] = [{ from: observation, to: witness, relation: 'DERIVED_FROM', createdAt: record.receivedAt },
      { from: observation, to: po, relation: 'EVALUATED_BY', createdAt: record.receivedAt }];
    if (request) {
      const intent: ResourceSnapshot = { ref: { pack_id: 'openresolve', type: 'connector-case-intent', id: record.id }, version: '1', sha256: fingerprint(request), metadata: { state_at_enqueue: 'PENDING', simulated: record.simulated } };
      edges.push({ from: observation, to: intent, relation: 'SUPPORTS', createdAt: record.receivedAt });
      if (original) edges.push({ from: native(original), to: intent, relation: 'SUPPORTS', createdAt: record.receivedAt });
    }
    await this.store.append(client, context, record.evidenceId, edges);
  }
}
