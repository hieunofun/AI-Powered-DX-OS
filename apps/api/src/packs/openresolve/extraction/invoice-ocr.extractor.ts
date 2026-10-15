/* SPDX-License-Identifier: MIT */
import { ExtractionInput, ExtractionProvider, ExtractionSuggestion } from '../../../ai/extraction/extraction-provider';
import { DraftExtractor } from '../../../platform/extraction/draft.types';
import { EvidenceContext, fail } from '../../../platform/evidence/evidence.types';
import { invoiceFields, InvoiceDraftProfile, MAX_OCR_LINES } from './invoice-draft.profile';
import { groundedFields, imageBudget, inspectPdf } from '../../../platform/extraction/media-inspection';
export interface DocumentDisclosure {
  resolve(context: EvidenceContext, evidenceId: string): Promise<'SYNTHETIC' | 'APPROVED_PAID'>;
}
export class InvoiceOcrExtractor implements DraftExtractor {
  constructor(private readonly provider: ExtractionProvider, private readonly disclosure: DocumentDisclosure) {}
  async extract(context: EvidenceContext, evidenceId: string, schemaId: string, bytes: Buffer, media: string, mode: 'OCR' | 'STRUCTURED_PARSER', recheck: () => Promise<void>) {
    if (schemaId !== new InvoiceDraftProfile().id || mode !== 'OCR' || !['application/pdf', 'image/png', 'image/jpeg'].includes(media)) fail('INVALID_REQUEST');
    const input: Omit<ExtractionInput, 'fields'> = { evidenceId, schemaId, bytes, mediaType: media as ExtractionInput['mediaType'], disclosure: await this.disclosure.resolve(context, evidenceId) };
    await recheck();
    const sourceText = media === 'application/pdf' ? await inspectPdf(bytes) : (imageBudget(bytes, media as 'image/png' | 'image/jpeg'), undefined);
    await recheck();
    const count = await this.provider.extract({ ...input, fields: [{ path: '/line_count', kind: 'DECIMAL',
      description: 'Count explicitly printed invoice item rows, excluding totals. Return an integer; do not infer hidden rows. If not an invoice or count is ambiguous return MISSING.' }] });
    if (count.evidence_id !== evidenceId || count.schema_id !== schemaId || count.fields.length !== 1) fail('DRAFT_INVALID', 422);
    const field = count.fields.find(field => field.path === '/line_count');
    if (!field || field.status !== 'EXTRACTED' || !/^[1-9][0-9]*$/.test(field.value || '') || Number(field.value) > MAX_OCR_LINES) fail('DRAFT_INVALID', 422);
    await recheck();
    const detail: ExtractionSuggestion = await this.provider.extract({ ...input, fields: invoiceFields(Number(field.value)) });
    await recheck();
    if (detail.evidence_id !== evidenceId || detail.schema_id !== schemaId || detail.fields.some(field => field.source_refs.some(ref => ref.evidence_id !== evidenceId))) fail('DRAFT_INVALID', 422);
    new InvoiceDraftProfile().validateFields(detail.fields);
    return { fields: groundedFields(detail.fields, evidenceId, sourceText), runs: [count, detail], ...(sourceText ? { sourceText } : {}) };
  }
}
