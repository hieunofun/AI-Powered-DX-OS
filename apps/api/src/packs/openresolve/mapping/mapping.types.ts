/* SPDX-License-Identifier: MIT */
import { ProviderFailure } from '../../../ai/extraction/extraction-provider';
import { PoolClient } from 'pg';
import { EvidenceContext } from '../../../platform/evidence/evidence.types';
export interface MappingCandidate {
  id: string; tenantId: string; purchaseOrderId: string; sku: string | null; description: string;
}
export interface MappingSnapshot {
  tenantId: string; confirmationId: string; evidenceId: string; sourceHash: string; factsHash: string;
  purchaseOrderId: string; catalogRevision: string;
  line: { path: string; sku: string | null; description: string };
  candidates: MappingCandidate[];
}
export interface ItemMappingSuggestion {
  state: 'REVIEW_REQUIRED'; resolution: 'MATCH' | 'AMBIGUOUS' | 'UNKNOWN';
  candidates: { po_item_id: string; confidence?: number; reason: string }[];
  method: 'DETERMINISTIC' | 'GEMINI' | 'DETERMINISTIC_FALLBACK';
  profile_version: 'reviewed-item-mapping-v1';
  provenance?: { provider: 'gemini'; model_version: string; prompt_version: string; run_id: string };
  usage?: { input_tokens: number; reserved_tokens: number; reported_total_tokens?: number };
  provider_failure?: { code: ProviderFailure; retryable: boolean; run_id?: string };
}
export interface MappingProvider {
  suggest(snapshot: MappingSnapshot, disclosure: 'SYNTHETIC' | 'APPROVED_PAID', recheck: () => Promise<void>): Promise<ItemMappingSuggestion>;
}
export interface MappingOperation {
  id: string; tenant_id: string; kind: 'ITEM_MAPPING'; state: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  created_at: string; updated_at: string; resource_ref: { pack_id: 'openresolve'; type: 'item-mapping-suggestion'; id: string };
  error?: { code: string; message: string; correlation_id: string; retryable: boolean };
}
export interface MappingDecision {
  id: string; mapping_id: string; confirmation_id: string; purchase_order_id: string; line_path: string; selected_po_item_id: string | null;
  actor_subject: string; reason: string; decided_at: string; origin: 'SUGGESTION' | 'MANUAL' | 'REJECTED';
  source_sha256: string; facts_sha256: string; catalog_revision: string;
  dispatch_state: 'PENDING' | 'NONE';
}
export interface MappingRecord {
  id: string; tenantId: string; evidenceId: string; requestedBy: string; createdAt: string;
  snapshot: MappingSnapshot; operation: MappingOperation; revision: number;
  attempts: number; lease?: { token: string; until: string }; suggestion?: ItemMappingSuggestion; decision?: MappingDecision;
}
export interface ReviewedMappingTarget {
  // Durable handoff in the caller's transaction; never change finalized matches or approve payment here.
  enqueue(client: PoolClient, context: EvidenceContext, decision: MappingDecision): Promise<void>;
}
