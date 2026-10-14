/* SPDX-License-Identifier: MIT */
import { ExtractionField, ExtractionFieldDefinition } from '../../../ai/extraction/extraction-provider';
import { DraftProfile } from '../../../platform/extraction/draft.types';
import { fail } from '../../../platform/evidence/evidence.types';
import { UUID } from '../../../platform/evidence/file-safety';
import { dateValue, exactDecimal, Exact, lineAmounts, reconcile, reconcileInvoice, text } from '../../../invoices/parsers/invoice-xml-validation';
import { CanonicalInvoiceData } from '../../../invoices/interfaces/invoice.interface';

const headers = [
  ['purchase_order_id', 'TEXT', 'Referenced purchase-order UUID, only if explicitly written; otherwise MISSING.'],
  ['seller_tax_code', 'TEXT', 'Seller tax identifier as printed, preserve leading zeros.'],
  ['buyer_tax_code', 'TEXT', 'Buyer tax identifier as printed, preserve leading zeros.'],
  ['invoice_number', 'TEXT', 'Invoice identifier as printed.'],
  ['invoice_date', 'DATE', 'Invoice issue date in YYYY-MM-DD.'],
  ['currency', 'CURRENCY', 'Three-letter uppercase currency code explicitly stated in the document.'],
  ['subtotal', 'DECIMAL', 'Declared invoice subtotal; copy the stated value, no arithmetic.'],
  ['tax_amount', 'DECIMAL', 'Declared total VAT; copy the stated value, no arithmetic.'],
  ['total_amount', 'DECIMAL', 'Declared invoice total; copy the stated value, no arithmetic.'],
] as const;
const lineFields = [
  ['description', 'TEXT', 'Printed item description'], ['sku', 'TEXT', 'Printed item code, or MISSING'],
  ['quantity', 'DECIMAL', 'Printed quantity'], ['unit_price', 'DECIMAL', 'Printed unit price'],
  ['tax_rate', 'DECIMAL', 'Printed VAT fraction between 0 and 1; 8% is 0.08'],
  ['line_subtotal', 'DECIMAL', 'Declared line subtotal; do not calculate'],
  ['tax_amount', 'DECIMAL', 'Declared line tax amount; do not calculate'],
  ['line_total', 'DECIMAL', 'Declared line total; do not calculate'],
] as const;
export const MAX_OCR_LINES = 10;
export function invoiceFields(lines: number): ExtractionFieldDefinition[] {
  if (!Number.isSafeInteger(lines) || lines < 1 || lines > MAX_OCR_LINES) fail('DRAFT_INVALID', 422);
  return [...headers.map(([path, kind, description]) => ({ path: '/' + path, kind, description })),
    ...Array.from({ length: lines }, (_, index) => lineFields.map(([path, kind, description]) => ({
      path: '/lines/' + index + '/' + path, kind, description: 'Line ' + (index + 1) + ': ' + description + '.' }))).flat()];
}
export class InvoiceDraftProfile implements DraftProfile {
  readonly id = 'openresolve.invoice-draft.v1';
  readonly verifiedResourceType = 'verified-invoice';
  private count(fields: ExtractionField[]): number {
    const indices = fields.map(field => /^\/lines\/([0-9]+)\//.exec(field.path)).filter(Boolean).map(match => Number(match[1]));
    if (!indices.length) fail('DRAFT_INVALID', 422);
    return Math.max(...indices) + 1;
  }
  validateFields(fields: ExtractionField[]): void {
    if (!Array.isArray(fields) || fields.length > 100 || fields.some(field => !field || typeof field.path !== 'string')) fail('DRAFT_INVALID', 422);
    const expected = invoiceFields(this.count(fields)), unique = new Map(fields.map(field => [field.path, field]));
    if (unique.size !== fields.length || fields.length !== expected.length) fail('DRAFT_INVALID', 422);
    for (const definition of expected) {
      const field = unique.get(definition.path);
      if (!field || field.kind !== definition.kind || !['EXTRACTED', 'MISSING'].includes(field.status) ||
        field.status === 'MISSING' && field.value !== undefined || field.status === 'EXTRACTED' &&
        (typeof field.value !== 'string' || !field.value || field.value.length > 2000) ||
        !Array.isArray(field.source_refs) || !field.source_refs.length) fail('DRAFT_INVALID', 422);
    }
  }
  requiredPaths(fields: ExtractionField[]): string[] {
    this.validateFields(fields); return invoiceFields(this.count(fields)).map(field => field.path).filter(path => !path.endsWith('/sku'));
  }
  payload(fields: ExtractionField[]): unknown {
    this.validateFields(fields);
    const values = new Map(fields.filter(field => field.status === 'EXTRACTED').map(field => [field.path, field.value]));
    for (const path of this.requiredPaths(fields)) if (!values.has(path)) fail('DRAFT_INVALID', 422);
    const get = (path: string) => values.get(path);
    const decimal = (path: string, precision: number, scale: number, positive = false) => {
      const value = get(path); if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value || '')) fail('INVALID_DECIMAL', 422);
      try { return exactDecimal(value, precision, scale, positive); } catch { fail('INVALID_DECIMAL', 422); }
    };
    if (!UUID.test(get('/purchase_order_id') || '')) fail('DRAFT_INVALID', 422);
    const currency = get('/currency'); if (!/^[A-Z]{3}$/.test(currency || '')) fail('DRAFT_INVALID', 422);
    try {
      const lines = Array.from({ length: this.count(fields) }, (_, index) => {
        const path = '/lines/' + index + '/', quantity = decimal(path + 'quantity', 18, 4, true), unit_price = decimal(path + 'unit_price', 18, 4), tax_rate = decimal(path + 'tax_rate', 7, 4);
        if (new Exact(tax_rate).gt('1')) fail('DRAFT_INVALID', 422);
        const result = { description: text(get(path + 'description'), 500), quantity, unit_price, tax_rate,
          line_subtotal: decimal(path + 'line_subtotal', 18, 2), tax_amount: decimal(path + 'tax_amount', 18, 2), line_total: decimal(path + 'line_total', 18, 2),
          ...(get(path + 'sku') !== undefined ? { sku: text(get(path + 'sku'), 100) } : {}) };
        const computed = lineAmounts(quantity, unit_price, tax_rate);
        reconcile(result.line_subtotal, new Exact(computed.lineSubtotal)); reconcile(result.tax_amount, new Exact(computed.taxAmount)); reconcile(result.line_total, new Exact(computed.lineTotal));
        return result;
      });
      const result = { purchase_order_id: get('/purchase_order_id'), seller_tax_code: text(get('/seller_tax_code'), 30), buyer_tax_code: text(get('/buyer_tax_code'), 30),
        invoice_number: text(get('/invoice_number'), 100), invoice_date: dateValue(get('/invoice_date')), currency, lines,
        subtotal: decimal('/subtotal', 18, 2), tax_amount: decimal('/tax_amount', 18, 2), total_amount: decimal('/total_amount', 18, 2) };
      const canonical: CanonicalInvoiceData = { sellerTaxCode: result.seller_tax_code, buyerTaxCode: result.buyer_tax_code,
        invoiceNumber: result.invoice_number, invoiceDate: result.invoice_date, currency, subtotal: result.subtotal, taxAmount: result.tax_amount, totalAmount: result.total_amount,
        items: lines.map(line => ({ description: line.description, quantity: line.quantity, unitPrice: line.unit_price, taxRate: line.tax_rate,
          lineSubtotal: line.line_subtotal, taxAmount: line.tax_amount, lineTotal: line.line_total, ...(line.sku ? { sku: line.sku } : {}) })) };
      reconcileInvoice(canonical); return result;
    } catch (error) { if (error instanceof Error && 'code' in error) throw error; fail('DRAFT_INVALID', 422); }
  }
}
