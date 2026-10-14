/* SPDX-License-Identifier: MIT */
export const AI_EXTRACTION_PROVIDER = Symbol('AI_EXTRACTION_PROVIDER');
export type FieldKind = 'TEXT' | 'DECIMAL' | 'DATE' | 'CURRENCY';
export interface ExtractionFieldDefinition {
  path: string;
  kind: FieldKind;
  description: string;
}

// Server-only port. The future evidence worker must authorize the resource and
// verify CLEAN bytes before invoking it; this port is not a public request DTO.
export interface ExtractionInput {
  evidenceId: string;
  schemaId: string;
  bytes: Buffer;
  mediaType: 'application/pdf' | 'image/png' | 'image/jpeg' | 'text/plain';
  disclosure: 'SYNTHETIC' | 'APPROVED_PAID';
  fields: ExtractionFieldDefinition[];
}
export interface ExtractionField {
  path: string;
  kind: FieldKind;
  status: 'EXTRACTED' | 'MISSING';
  value?: string;
  confidence?: number;
  source_refs: { location_status: 'UNKNOWN'; evidence_id: string; reason: 'PROVIDER_NO_LOCATION' }[];
}
export interface ExtractionSuggestion {
  state: 'REVIEW_REQUIRED';
  evidence_id: string;
  schema_id: string;
  fields: ExtractionField[];
  extractor: { provider: 'gemini'; model_version: string; prompt_version: string; run_id: string };
  usage: { input_tokens: number; reserved_tokens: number };
}
export interface ExtractionProvider { extract(input: ExtractionInput): Promise<ExtractionSuggestion>; }
export type ProviderFailure = 'NOT_CONFIGURED' | 'INVALID_INPUT' | 'DISCLOSURE_DENIED' | 'TIMEOUT' |
  'RATE_LIMITED' | 'BUDGET_EXCEEDED' | 'INVALID_OUTPUT' | 'UNAVAILABLE' | 'REJECTED';
export class AiProviderError extends Error {
  readonly name = 'AiProviderError';
  runId?: string;
  constructor(readonly code: ProviderFailure, readonly retryable = false, readonly retryAfterSeconds?: number) {
    super('AI extraction failed: ' + code + '.');
  }
}
export class DisabledExtractionProvider implements ExtractionProvider {
  async extract(_input: ExtractionInput): Promise<ExtractionSuggestion> {
    throw new AiProviderError('NOT_CONFIGURED');
  }
}
