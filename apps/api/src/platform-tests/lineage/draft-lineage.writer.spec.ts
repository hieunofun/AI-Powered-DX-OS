/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { DraftLineageWriter } from '../../platform/lineage/draft-lineage.writer';
import { EvidenceRecord } from '../../platform/evidence/evidence.types';
import { DraftRecord } from '../../platform/extraction/draft.types';
import { context, foreign, metadata } from '../../../test/evidence.fixtures';
import { invoiceSuggestion } from '../../../test/ocr.fixtures';
describe('draft lineage derivation (writer port double)', () => {
  let source: EvidenceRecord, record: DraftRecord, append: jest.Mock, writer: DraftLineageWriter;
  beforeEach(() => {
    const evidenceId = randomUUID(), id = randomUUID(), at = '2026-10-15T00:00:00Z', suggestion = invoiceSuggestion(evidenceId);
    source = { evidence: { ...metadata(), id: evidenceId, tenant_id: context.tenantId, revision: 6, quarantine_state: 'CLEAN', processing_state: 'REVIEW_REQUIRED',
      created_at: at, updated_at: at, created_by: context.subject, legal_hold: false }, expiresAt: at, accepted: true, uploadAttempts: 1, scanAttempts: 1, history: [] };
    record = { id, tenantId: context.tenantId, evidenceId, sourceHash: source.evidence.sha256, objectKey: 'private', mediaType: 'application/pdf', evidenceRevision: 6,
      schemaId: suggestion.schema_id, mode: 'OCR', createdAt: at, requestedBy: context.subject, attempts: 1, providerRuns: [suggestion], original: suggestion.fields,
      operation: { id: randomUUID(), tenant_id: context.tenantId, kind: 'EXTRACTION', state: 'SUCCEEDED', created_at: at, updated_at: at,
        resource_ref: { pack_id: 'openresolve', type: 'extraction-draft', id } },
      draft: { id, tenant_id: context.tenantId, evidence_id: evidenceId, schema_id: suggestion.schema_id, revision: 2, state: 'REVIEW_REQUIRED',
        fields: suggestion.fields, extractor: suggestion.extractor, created_at: at, updated_at: at,
        corrections: [{ id: randomUUID(), field_path: '/invoice_number', previous_value: 'SYN-26', new_value: 'CORRECTED', reason: 'Inspected source', actor_subject: context.subject, created_at: at, revision: 2 }] } };
    append = jest.fn(async () => undefined); writer = new DraftLineageWriter({ append, watermark: async () => '0', page: async () => [] });
  });
  test('records original bytes/run/draft and append-only correction hashes without copying field text into graph metadata', async () => {
    await writer.capture({} as PoolClient, context, record, source);
    const edges = append.mock.calls[0][3]; expect(edges.map(edge => edge.relation)).toEqual(['DERIVED_FROM', 'DERIVED_FROM', 'CORRECTS']);
    expect(edges[0].to).toMatchObject({ version: 'blob-1', sha256: source.evidence.sha256, metadata: { retention_class_at_registration: 'STANDARD' } });
    expect(edges[2].from.metadata).toMatchObject({ actor_subject: context.subject, revision: 2 });
    expect(JSON.stringify(edges)).not.toContain('CORRECTED');
    await writer.capture({} as PoolClient, context, record, source); expect(append.mock.calls[1][3]).toEqual(edges);
  });
  test('does not fabricate completed extraction before a persisted draft exists', async () => {
    delete record.draft; await writer.capture({} as PoolClient, context, record, source); expect(append).not.toHaveBeenCalled();
  });
  test('cross-tenant/source-hash mismatch cannot establish lineage', async () => {
    source.evidence.tenant_id = foreign.tenantId;
    await expect(writer.capture({} as PoolClient, context, record, source)).rejects.toThrow('scope mismatch'); expect(append).not.toHaveBeenCalled();
  });
});
