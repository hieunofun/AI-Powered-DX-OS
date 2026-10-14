/* SPDX-License-Identifier: MIT */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import PDFDocument from 'pdfkit';
import { groundedFields, imageBudget, inspectPdf } from './media-inspection';
import { invoiceSuggestion } from '../../../test/ocr.fixtures';
import { key } from '../../../test/evidence.fixtures';
const fixture = (name: string) => readFileSync(resolve(__dirname, '../../../../../infra/ocr/fixtures/vn-reviewed-v1/sources', name));
async function generated(pages: number, size: [number, number] = [595, 842]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ autoFirstPage: false }), chunks: Buffer[] = [];
    pdf.on('data', chunk => chunks.push(chunk)); pdf.on('end', () => resolve(Buffer.concat(chunks))); pdf.on('error', reject);
    for (let i = 0; i < pages; i++) pdf.addPage({ size }).text('Synthetic page ' + (i + 1)); pdf.end();
  });
}
describe('bounded PDF and image inspection (actual PDF.js parser)', () => {
  test('reads immutable page text from a genuine text PDF', async () => {
    const result = await inspectPdf(fixture('dev-digital.pdf'));
    expect(result.parser).toBe('pdfjs-dist@6.4.299'); expect(result.pages).toHaveLength(1);
    expect(result.pages[0].text).toContain('OCR-DEV-001');
  });
  test('image-only PDF has no invented text spans', async () => {
    const result = await inspectPdf(fixture('held-scanned.pdf'));
    expect(result.pages).toHaveLength(1); expect(result.pages[0].text.trim()).toBe('');
    const fields = invoiceSuggestion(key()).fields; expect(groundedFields(fields, key(), result)).toEqual(fields);
  });
  test('rejects malformed PDF and independently terminates a timed-out parser', async () => {
    await expect(inspectPdf(Buffer.from('%PDF-1.7 invalid'))).rejects.toMatchObject({ code: 'DRAFT_INVALID' });
    await expect(inspectPdf(fixture('dev-digital.pdf'), 1)).rejects.toMatchObject({ code: 'DRAFT_INVALID' });
  });
  test('enforces page count and page pixel budgets before AI dispatch', async () => {
    await expect(inspectPdf(await generated(31))).rejects.toMatchObject({ code: 'DRAFT_INVALID' });
    await expect(inspectPdf(await generated(1, [20000, 20000]))).rejects.toMatchObject({ code: 'DRAFT_INVALID' });
  });
  test.each([['dev-png.png', 'image/png'], ['held-jpeg.jpg', 'image/jpeg']] as const)('accepts genuine bounded %s headers', (file, media) => {
    expect(() => imageBudget(fixture(file), media)).not.toThrow();
  });
  test('rejects oversized PNG dimensions without decompression', () => {
    const bytes = Buffer.from(fixture('dev-png.png')); bytes.writeUInt32BE(100000, 16);
    expect(() => imageBudget(bytes, 'image/png')).toThrow();
    expect(() => imageBudget(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg')).toThrow();
  });
  test('uses actual unique page text and Unicode codepoint offsets; never guesses a bbox', () => {
    const id = key(), fields = invoiceSuggestion(id).fields.filter(field => field.path === '/invoice_number');
    const document = { parser: 'pdfjs-dist@6.4.299' as const, pages: [{ page: 2, text: 'Á😀 Chứng từ SYN-26 kết thúc' }] };
    const result = groundedFields(fields, id, document)[0].source_refs[0];
    expect(result.location_status).toBe('KNOWN');
    if (result.location_status !== 'KNOWN') throw new Error('Expected grounded source');
    expect(Array.from(document.pages[0].text).slice(result.text_span.start, result.text_span.end).join('')).toBe('SYN-26');
    expect(result.bbox).toBeUndefined(); expect(result.page).toBe(2);
  });
  test('duplicate or absent values retain UNKNOWN rather than picking a convenient page', () => {
    const id = key(), fields = invoiceSuggestion(id).fields.filter(field => field.path === '/invoice_number');
    for (const text of ['SYN-26 and SYN-26', 'No invoice number']) {
      expect(groundedFields(fields, id, { parser: 'pdfjs-dist@6.4.299', pages: [{ page: 1, text }] })[0].source_refs[0].location_status).toBe('UNKNOWN');
    }
  });
});
