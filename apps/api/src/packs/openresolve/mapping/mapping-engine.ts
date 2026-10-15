/* SPDX-License-Identifier: MIT */
import { AiProviderError } from '../../../ai/extraction/extraction-provider';
import { ItemResolver } from '../../../matching/domain/item-resolver';
import { normalizeDescription, normalizeSku } from '../../../matching/domain/normalization';
import { contextValid, UUID } from '../../../platform/evidence/file-safety';
import { EvidenceContext, fail } from '../../../platform/evidence/evidence.types';
import { ItemMappingSuggestion, MappingCandidate, MappingProvider, MappingSnapshot } from './mapping.types';
export const MAPPING_PROFILE = 'reviewed-item-mapping-v1' as const;
export const MAX_MAPPING_CANDIDATES = 40;
export function validateMappingSnapshot(context: EvidenceContext, snapshot: MappingSnapshot): void {
  contextValid(context);
  if (!snapshot || snapshot.tenantId !== context.tenantId) fail('NOT_FOUND', 404);
  if (![snapshot.confirmationId, snapshot.evidenceId, snapshot.purchaseOrderId].every(value => typeof value === 'string' && UUID.test(value)) ||
    ![snapshot.sourceHash, snapshot.factsHash, snapshot.catalogRevision].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && value.length === 64) ||
    !snapshot.line || typeof snapshot.line.path !== 'string' || !/^\/lines\/(0|[1-9][0-9]?)(?![\s\S])/.test(snapshot.line.path) ||
    !Array.isArray(snapshot.candidates) || snapshot.candidates.length > MAX_MAPPING_CANDIDATES) fail('INVALID_REQUEST');
  const identities = [snapshot.line, ...snapshot.candidates];
  if (identities.some(item => !item || typeof item.description !== 'string' || !item.description.trim() || item.description.length > 500 ||
    item.sku !== null && (typeof item.sku !== 'string' || !item.sku.trim() || item.sku.length > 100))) fail('INVALID_REQUEST');
  const ids = new Set<string>();
  for (const candidate of snapshot.candidates) {
    if (!candidate || candidate.tenantId !== context.tenantId || candidate.purchaseOrderId !== snapshot.purchaseOrderId) fail('NOT_FOUND', 404);
    if (!UUID.test(candidate.id) || ids.has(candidate.id)) fail('INVALID_REQUEST'); ids.add(candidate.id);
  }
}
function deterministic(snapshot: MappingSnapshot): ItemMappingSuggestion {
  const result = new ItemResolver(snapshot.candidates, snapshot.purchaseOrderId).resolve({ ...snapshot.line, poItemId: null });
  let candidates: MappingCandidate[] = result.item ? [result.item] : [];
  if (result.codes.includes('AMBIGUOUS_ITEM')) candidates = snapshot.candidates.filter(candidate => snapshot.line.sku !== null ?
    candidate.sku !== null && normalizeSku(candidate.sku) === normalizeSku(snapshot.line.sku) :
    normalizeDescription(candidate.description) === normalizeDescription(snapshot.line.description));
  return { state: 'REVIEW_REQUIRED', resolution: result.item ? 'MATCH' : candidates.length ? 'AMBIGUOUS' : 'UNKNOWN',
    candidates: candidates.map(candidate => ({ po_item_id: candidate.id, reason: result.item ? 'Exact catalog identity by ' + result.method : 'Duplicate exact catalog identity requires explicit choice' })),
    method: 'DETERMINISTIC', profile_version: MAPPING_PROFILE };
}
export class ReviewedMappingEngine {
  constructor(private readonly provider: MappingProvider) {}
  async suggest(context: EvidenceContext, snapshot: MappingSnapshot, disclosure: 'SYNTHETIC' | 'APPROVED_PAID', recheck: () => Promise<void>): Promise<ItemMappingSuggestion> {
    validateMappingSnapshot(context, snapshot); await recheck();
    const fallback = deterministic(snapshot);
    // Preserve exact/ambiguous deterministic behavior; a model may not break a duplicate-SKU tie.
    if (fallback.resolution !== 'UNKNOWN' || !snapshot.candidates.length) return fallback;
    let suggestion: ItemMappingSuggestion;
    try {
      suggestion = await this.provider.suggest(snapshot, disclosure, recheck);
      if (!suggestion || suggestion.state !== 'REVIEW_REQUIRED' || suggestion.method !== 'GEMINI' || suggestion.profile_version !== MAPPING_PROFILE ||
        !suggestion.provenance || suggestion.provenance.provider !== 'gemini' || typeof suggestion.provenance.model_version !== 'string' ||
        !/^gemini-[a-z0-9.-]{1,100}$/.test(suggestion.provenance.model_version) || !UUID.test(suggestion.provenance.run_id) ||
        typeof suggestion.provenance.prompt_version !== 'string' || !suggestion.provenance.prompt_version || suggestion.provenance.prompt_version.length > 100 ||
        !['MATCH', 'AMBIGUOUS', 'UNKNOWN'].includes(suggestion.resolution) ||
        !Array.isArray(suggestion.candidates) || suggestion.candidates.length > 3 || suggestion.resolution === 'MATCH' && suggestion.candidates.length !== 1 ||
        suggestion.resolution === 'AMBIGUOUS' && suggestion.candidates.length < 2 || suggestion.resolution === 'UNKNOWN' && suggestion.candidates.length !== 0) throw new AiProviderError('INVALID_OUTPUT');
      const seen = new Set<string>();
      for (const candidate of suggestion.candidates) {
        if (!candidate || !snapshot.candidates.some(allowed => allowed.id === candidate.po_item_id) || seen.has(candidate.po_item_id) ||
          typeof candidate.reason !== 'string' || !candidate.reason.trim() || candidate.reason.length > 500 ||
          candidate.confidence !== undefined && (typeof candidate.confidence !== 'number' || !Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1)) throw new AiProviderError('INVALID_OUTPUT');
        seen.add(candidate.po_item_id);
      }
      if (suggestion.resolution === 'MATCH') {
        const selected = snapshot.candidates.find(candidate => candidate.id === suggestion.candidates[0].po_item_id);
        const twins = snapshot.candidates.filter(candidate => normalizeDescription(candidate.description) === normalizeDescription(selected.description) &&
          (candidate.sku === null && selected.sku === null || candidate.sku !== null && selected.sku !== null && normalizeSku(candidate.sku) === normalizeSku(selected.sku)));
        if (twins.length > 1) suggestion = { ...suggestion, resolution: 'AMBIGUOUS', candidates: twins.map(candidate => ({ po_item_id: candidate.id, reason: 'Duplicate catalog identity requires explicit choice' })) };
      }
    } catch (error) {
      if (!(error instanceof AiProviderError)) throw error;
      suggestion = { ...fallback, method: 'DETERMINISTIC_FALLBACK', provider_failure: { code: error.code, retryable: error.retryable, ...(error.runId ? { run_id: error.runId } : {}) } };
    }
    // Authority failures never become an apparently successful fallback.
    await recheck(); return suggestion;
  }
}
