/* SPDX-License-Identifier: MIT */
import { PoolClient } from 'pg';
import { ExtractionField, ExtractionSuggestion } from '../../ai/extraction/extraction-provider';
import { EvidenceContext } from '../evidence/evidence.types';
import type { DocumentText } from './media-inspection';
export interface DraftCorrection {
  id: string; field_path: string; previous_value?: string; new_value: string; reason: string;
  actor_subject: string; created_at: string; revision: number;
}
export interface ReviewedDraft {
  id: string; tenant_id: string; evidence_id: string; schema_id: string; revision: number;
  state: 'REVIEW_REQUIRED' | 'CONFIRMED'; fields: ExtractionField[];
  extractor: { provider: string; model_version: string; prompt_version?: string; run_id: string };
  created_at: string; updated_at: string; corrections: DraftCorrection[];
}
export interface DraftOperation {
  id: string; tenant_id: string; kind: 'EXTRACTION' | 'DRAFT_CONFIRMATION';
  state: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'RECONCILIATION_REQUIRED';
  created_at: string; updated_at: string; resource_ref: { pack_id: string; type: string; id: string };
  result_ref?: { pack_id: string; type: string; id: string };
  error?: { code: string; message: string; correlation_id: string; retryable: boolean };
}
export interface DraftConfirmation {
  id: string; draft_id: string; confirmed_revision: number; schema_id: string;
  actor_subject: string; confirmed_at: string; verified_payload_ref: { pack_id: string; type: string; id: string };
  operation: DraftOperation;
}
export interface DraftRecord {
  id: string; tenantId: string; evidenceId: string; evidenceRevision: number; sourceHash: string; objectKey: string; mediaType: string;
  schemaId: string; mode: 'OCR' | 'STRUCTURED_PARSER'; createdAt: string; requestedBy: string;
  operation: DraftOperation; draft?: ReviewedDraft; original?: ExtractionField[];
  providerRuns: ExtractionSuggestion[]; attempts: number; nextAttemptAt?: string;
  lease?: { token: string; until: string };
  confirmation?: DraftConfirmation; verifiedPayload?: unknown;
  failures?: { attempt: number; at: string; code: string; providerRunId?: string }[];
  sourceText?: DocumentText;
}
export interface DraftExtractor {
  extract(context: EvidenceContext, evidenceId: string, schemaId: string, bytes: Buffer, media: string,
    mode: 'OCR' | 'STRUCTURED_PARSER', recheck: () => Promise<void>): Promise<{ fields: ExtractionField[]; runs: ExtractionSuggestion[]; sourceText?: DocumentText }>;
}
export interface DraftProfile {
  readonly id: string;
  readonly verifiedResourceType: string;
  validateFields(fields: ExtractionField[]): void;
  requiredPaths(fields: ExtractionField[]): string[];
  payload(fields: ExtractionField[]): unknown;
}
export interface VerifiedDraftTarget {
  // The owning pack checks tenant/PO/supplier/resource grants; missing target fails closed.
  authorize(context: EvidenceContext, schemaId: string, payload: unknown): Promise<void>;
  // Persist a durable, deduplicated pack handoff in this transaction; never perform remote I/O here.
  enqueue(client: PoolClient, context: EvidenceContext, confirmation: DraftConfirmation, payload: unknown): Promise<void>;
}
