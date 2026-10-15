/* SPDX-License-Identifier: MIT */
import { PoolClient } from 'pg';
import { EvidenceContext, EvidenceRecord } from '../evidence/evidence.types';
import { fingerprint } from '../evidence/file-safety';
import { DraftRecord } from '../extraction/draft.types';
import { DraftLineageSink, LineageEdge, LineageStore, ResourceRef, ResourceSnapshot } from './lineage.types';
import { rawEvidenceSnapshot } from './raw-evidence.snapshot';
export class DraftLineageWriter implements DraftLineageSink {
  constructor(private readonly store: LineageStore) {}
  async capture(client: PoolClient, context: EvidenceContext, record: DraftRecord, source: EvidenceRecord) {
    if (!record.draft) return;
    if (record.tenantId !== context.tenantId || source.evidence.tenant_id !== context.tenantId || record.evidenceId !== source.evidence.id || record.sourceHash !== source.evidence.sha256) throw new Error('Lineage source scope mismatch.');
    const pack = record.schemaId.split('.')[0], edges: LineageEdge[] = [];
    const node = (ref: ResourceRef, version: string, metadata: Record<string, unknown>): ResourceSnapshot => ({ ref, version, metadata, sha256: fingerprint(metadata) });
    const raw = rawEvidenceSnapshot(source.evidence);
    const draft = node({ pack_id: pack, type: 'extraction-draft', id: record.id }, 'original-1',
      { schema_id: record.schemaId, source_sha256: record.sourceHash, fields_sha256: fingerprint(record.original), created_at: record.draft.created_at });
    for (const run of record.providerRuns) {
      const extraction = node({ pack_id: 'platform', type: 'extraction-run', id: run.extractor.run_id }, '1',
        { ...run.extractor, schema_id: run.schema_id, source_sha256: record.sourceHash, usage: run.usage, fields_sha256: fingerprint(run.fields) });
      edges.push({ from: extraction, to: raw, relation: 'DERIVED_FROM', createdAt: record.draft.created_at },
        { from: draft, to: extraction, relation: 'DERIVED_FROM', createdAt: record.draft.created_at });
    }
    const corrections = record.draft.corrections.map(correction => node({ pack_id: 'platform', type: 'extraction-correction', id: correction.id }, String(correction.revision),
      { field_path: correction.field_path, revision: correction.revision, actor_subject: correction.actor_subject, created_at: correction.created_at,
        previous_value_sha256: fingerprint(correction.previous_value ?? null), new_value_sha256: fingerprint(correction.new_value) }));
    corrections.forEach((correction, index) => edges.push({ from: correction, to: draft, relation: 'CORRECTS', createdAt: record.draft.corrections[index].created_at }));
    if (record.confirmation) {
      const confirmation = record.confirmation;
      const confirmed = node({ pack_id: 'platform', type: 'draft-confirmation', id: confirmation.id }, '1',
        { actor_subject: confirmation.actor_subject, confirmed_at: confirmation.confirmed_at, confirmed_revision: confirmation.confirmed_revision, schema_id: confirmation.schema_id });
      const facts = node(confirmation.verified_payload_ref, '1', { payload_sha256: fingerprint(record.verifiedPayload), source_sha256: record.sourceHash, confirmation_id: confirmation.id });
      for (const target of [draft, ...corrections]) edges.push({ from: confirmed, to: target, relation: 'CONFIRMS', createdAt: confirmation.confirmed_at });
      edges.push({ from: facts, to: confirmed, relation: 'DERIVED_FROM', createdAt: confirmation.confirmed_at });
    }
    await this.store.append(client, context, record.evidenceId, edges);
  }
}
