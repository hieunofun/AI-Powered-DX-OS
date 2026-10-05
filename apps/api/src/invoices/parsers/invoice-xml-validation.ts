import Decimal from 'decimal.js';
import { CanonicalInvoiceData } from '../interfaces/invoice.interface';
import { IngestionError } from '../domain/ingestion-error';

// Isolated context: existing modules configure Decimal globally at precision 30.
export const Exact = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP });
export type XmlNode = Record<string, unknown>;

export function node(value: unknown): XmlNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IngestionError('UNSUPPORTED_XML_FORMAT', 'Required supported-profile structure is missing or repeated.');
  }
  return value as XmlNode;
}
export function shape(value: XmlNode, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key) &&
      !(key === '#text' && typeof value[key] === 'string' && !(value[key] as string).trim()))) {
    throw new IngestionError('UNSUPPORTED_INVOICE_FEATURE', 'The XML contains fields outside the supported profile.');
  }
}
export function text(value: unknown, max = 100): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || Array.from(value).some(c => {
    const code = c.charCodeAt(0);
    return code < 32 && ![9, 10, 13].includes(code);
  })) {
    throw new IngestionError('UNSUPPORTED_XML_FORMAT', 'A required text field is missing, repeated or too long.');
  }
  return value;
}
export function exactDecimal(value: unknown, precision: number, scale: number, positive = false): string {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value) || value.length > 100) {
    throw new IngestionError('INVALID_DECIMAL', 'Financial fields must be unsigned plain decimal strings.');
  }
  const parts = value.split('.');
  if ((parts[1]?.length || 0) > scale || parts[0].replace(/^0+/, '').length > precision - scale) {
    throw new IngestionError('DECIMAL_PRECISION_EXCEEDED', 'A financial value exceeds the supported database precision or scale.');
  }
  const decimal = new Exact(value);
  if (positive && decimal.lte('0')) throw new IngestionError('INVALID_DECIMAL', 'Quantity must be greater than zero.');
  return decimal.toFixed(scale);
}
export function reconcile(actual: string, expected: Decimal): void {
  if (!new Exact(actual).eq(expected)) {
    throw new IngestionError('TOTAL_MISMATCH', 'Declared line or invoice totals do not match the supported calculation rules.');
  }
}
export function vatFraction(value: unknown): string {
  const percent = text(value).replace(/%$/, '');
  exactDecimal(percent, 9, 2);
  if (new Exact(percent).gt('100')) throw new IngestionError('INVALID_TAX_RATE', 'VAT percentage must be between 0 and 100.');
  return exactDecimal(new Exact(percent).div('100').toFixed(4), 7, 4);
}
export function dateValue(value: unknown): string {
  const date = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000') ||
      !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new IngestionError('INVALID_INVOICE_DATE', 'Invoice date must be a valid YYYY-MM-DD date.');
  }
  return date;
}
export function currencyValue(value: unknown): string {
  const currency = text(value, 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new IngestionError('UNSUPPORTED_XML_FORMAT', 'Currency must be a three-letter code.');
  return currency;
}
export function lineAmounts(quantity: string, price: string, rate: string) {
  const subtotal = new Exact(new Exact(quantity).times(price).toFixed(2));
  const tax = new Exact(subtotal.times(rate).toFixed(2));
  return { lineSubtotal: exactDecimal(subtotal.toFixed(2), 18, 2),
    taxAmount: exactDecimal(tax.toFixed(2), 18, 2), lineTotal: exactDecimal(subtotal.plus(tax).toFixed(2), 18, 2) };
}
export function reconcileInvoice(data: CanonicalInvoiceData): void {
  const subtotal = data.items.reduce((sum, item) => sum.plus(item.lineSubtotal), new Exact('0'));
  const tax = data.items.reduce((sum, item) => sum.plus(item.taxAmount), new Exact('0'));
  reconcile(data.subtotal, subtotal); reconcile(data.taxAmount, tax); reconcile(data.totalAmount, subtotal.plus(tax));
}
