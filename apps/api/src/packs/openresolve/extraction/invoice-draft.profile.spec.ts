/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ExtractionField, ExtractionSuggestion } from '../../../ai/extraction/extraction-provider';
import { InvoiceDraftProfile, invoiceFields } from './invoice-draft.profile';
import { InvoiceOcrExtractor } from './invoice-ocr.extractor';
const source = randomUUID(), po = randomUUID(), profile = new InvoiceDraftProfile();
const ctx = { tenantId: randomUUID(), subject: 'fixture-member' };
const pdfBytes = readFileSync(resolve(__dirname, '../../../../../../infra/ocr/fixtures/vn-reviewed-v1/sources/dev-digital.pdf'));
const values = { '/purchase_order_id': po, '/seller_tax_code': '0123456789', '/buyer_tax_code': '0987654321',
  '/invoice_number': 'SYN-26', '/invoice_date': '2026-10-15', '/currency': 'VND', '/subtotal': '1000000', '/tax_amount': '100000', '/total_amount': '1100000',
  '/lines/0/description': 'Fictional printer cartridge', '/lines/0/sku': 'CE285A', '/lines/0/quantity': '2', '/lines/0/unit_price': '500000',
  '/lines/0/tax_rate': '0.1', '/lines/0/line_subtotal': '1000000', '/lines/0/tax_amount': '100000', '/lines/0/line_total': '1100000' };
function fields(overrides: Record<string, string | undefined> = {}): ExtractionField[] {
  const all = { ...values, ...overrides };
  return invoiceFields(1).map(field => ({ path: field.path, kind: field.kind,
    status: all[field.path] === undefined ? 'MISSING' : 'EXTRACTED', ...(all[field.path] !== undefined ? { value: all[field.path] } : {}),
    source_refs: [{ location_status: 'UNKNOWN', evidence_id: source, reason: 'PROVIDER_NO_LOCATION' }] }));
}
function suggestion(inputFields: ExtractionField[]): ExtractionSuggestion {
  return { state: 'REVIEW_REQUIRED', evidence_id: source, schema_id: profile.id, fields: inputFields,
    extractor: { provider: 'gemini', model_version: 'fixture-model', prompt_version: 'fixture-prompt', run_id: randomUUID() }, usage: { input_tokens: 1, reserved_tokens: 2 } };
}
describe('reviewed invoice profile: deterministic validation', () => {
  test('normalizes decimal scales with exact legacy rounding and preserves tax-ID zeros', () => {
    expect(profile.payload(fields())).toMatchObject({ purchase_order_id: po, seller_tax_code: '0123456789', total_amount: '1100000.00',
      lines: [{ quantity: '2.0000', unit_price: '500000.0000', tax_rate: '0.1000', line_subtotal: '1000000.00' }] });
  });
  test('optional missing SKU does not authorize skipping required review fields', () => {
    expect(profile.requiredPaths(fields({ '/lines/0/sku': undefined }))).not.toContain('/lines/0/sku');
    expect(profile.requiredPaths(fields())).toContain('/lines/0/quantity');
    expect(profile.payload(fields({ '/lines/0/sku': undefined }))).toBeDefined();
  });
  test.each(['/purchase_order_id', '/total_amount', '/lines/0/quantity'])('missing required %s is never invented', path => {
    expect(() => profile.payload(fields({ [path]: undefined }))).toThrow();
  });
  test.each(['1e6', '-1', '01', '1,000,000', '1000000.001'])('rejects precision/format %s', value => {
    expect(() => profile.payload(fields({ '/subtotal': value }))).toThrow();
  });
  test.each([{ '/total_amount': '1000000' }, { '/lines/0/tax_rate': '1.01' }, { '/lines/0/quantity': '0' },
    { '/invoice_date': '2026-02-30' }, { '/currency': 'vnd' }, { '/lines/0/line_total': '999999' }])('invalid totals/tax/date/currency are blocked', override => {
    expect(() => profile.payload(fields(override))).toThrow();
  });
  test('validates amounts beyond Number.MAX_SAFE_INTEGER exactly', () => {
    const total = '9999999999999999.98';
    expect(profile.payload(fields({ '/lines/0/quantity': '100', '/lines/0/unit_price': '99999999999999.9998',
      '/lines/0/tax_rate': '0', '/lines/0/line_subtotal': total, '/lines/0/tax_amount': '0', '/lines/0/line_total': total,
      '/subtotal': total, '/tax_amount': '0', '/total_amount': total }))).toMatchObject({ total_amount: total });
  });
  test('duplicate paths, gaps, unregistered fields and unsupported row budgets fail closed', () => {
    const original = fields(); expect(() => profile.validateFields([...original, original[0]])).toThrow();
    expect(() => profile.validateFields(original.slice(1))).toThrow();
    expect(() => profile.validateFields([...original, { ...original[0], path: '/client_approval' }])).toThrow();
    expect(() => invoiceFields(11)).toThrow(); expect(() => invoiceFields(0)).toThrow();
  });
});
describe('two-stage OCR extraction', () => {
  function count(value = '1') { return suggestion([{ path: '/line_count', kind: 'DECIMAL', status: 'EXTRACTED', value,
    source_refs: [{ location_status: 'UNKNOWN', evidence_id: source, reason: 'PROVIDER_NO_LOCATION' }] }]); }
  test('captures both immutable run/provenance snapshots and guards each provider boundary', async () => {
    const extract = jest.fn().mockResolvedValueOnce(count()).mockResolvedValueOnce(suggestion(fields())), guard = jest.fn(async () => undefined);
    const worker = new InvoiceOcrExtractor({ extract }, { resolve: async () => 'SYNTHETIC' });
    const result = await worker.extract(ctx, source, profile.id, pdfBytes, 'application/pdf', 'OCR', guard);
    expect(result.runs).toHaveLength(2); expect(result.fields).toHaveLength(17); expect(guard).toHaveBeenCalledTimes(4);
    expect(extract.mock.calls[1][0].fields).toHaveLength(17);
  });
  test.each(['0', '1.5', '11', '1000'])('unsupported count %s never silently truncates rows', async value => {
    const extract = jest.fn().mockResolvedValue(count(value)), worker = new InvoiceOcrExtractor({ extract }, { resolve: async () => 'SYNTHETIC' });
    await expect(worker.extract(ctx, source, profile.id, pdfBytes, 'application/pdf', 'OCR', async () => undefined)).rejects.toMatchObject({ code: 'DRAFT_INVALID' });
    expect(extract).toHaveBeenCalledTimes(1);
  });
  test('revoked access after row count prevents detail-provider dispatch', async () => {
    const extract = jest.fn().mockResolvedValue(count()), guard = jest.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked'));
    await expect(new InvoiceOcrExtractor({ extract }, { resolve: async () => 'SYNTHETIC' }).extract(ctx, source, profile.id, pdfBytes, 'application/pdf', 'OCR', guard)).rejects.toThrow('revoked');
    expect(extract).toHaveBeenCalledTimes(1);
  });
});
