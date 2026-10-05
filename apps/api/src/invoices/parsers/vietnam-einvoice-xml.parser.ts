import { Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { CanonicalInvoiceData, CanonicalInvoiceItem } from '../interfaces/invoice.interface';
import { IngestionError } from '../domain/ingestion-error';
import { InvoiceXmlParser } from './invoice-xml-parser.interface';

// Isolated context: existing modules configure Decimal globally at precision 30.
const Exact = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP });
type Node = Record<string, unknown>;

function node(value: unknown): Node {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IngestionError('UNSUPPORTED_XML_FORMAT', 'Required supported-profile structure is missing or repeated.');
  }
  return value as Node;
}
function shape(value: Node, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key) &&
      !(key === '#text' && typeof value[key] === 'string' && !(value[key] as string).trim()))) {
    throw new IngestionError('UNSUPPORTED_INVOICE_FEATURE', 'The XML contains fields outside the supported profile.');
  }
}
function text(value: unknown, max = 100): string {
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
function reconcile(actual: string, expected: Decimal): void {
  if (!new Exact(actual).eq(expected)) {
    throw new IngestionError('TOTAL_MISMATCH', 'Declared line or invoice totals do not match the supported calculation rules.');
  }
}

/** SmartProcureInvoice v1 project profile, not a universal provider/TCT adapter. */
@Injectable()
export class VietnamEinvoiceXmlParser implements InvoiceXmlParser {
  readonly profile = 'SmartProcureInvoice v1';
  supports(document: Node): boolean {
    const root = document.SmartProcureInvoice;
    return !!root && typeof root === 'object' && !Array.isArray(root) && (root as Node)['@_version'] === '1';
  }
  parse(document: Node): CanonicalInvoiceData {
    shape(document, ['SmartProcureInvoice']);
    const root = node(document.SmartProcureInvoice);
    shape(root, ['@_version', 'NguoiBan', 'NguoiMua', 'ThongTinChung', 'DanhSachHangHoa', 'TongTien']);
    const seller = node(root.NguoiBan), buyer = node(root.NguoiMua), header = node(root.ThongTinChung);
    shape(seller, ['MST']); shape(buyer, ['MST']); shape(header, ['SHDon', 'NLap', 'DVTTe']);
    const date = text(header.NLap, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000') ||
        !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
      throw new IngestionError('INVALID_INVOICE_DATE', 'Invoice date must be a valid YYYY-MM-DD date.');
    }
    const currency = text(header.DVTTe, 3).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new IngestionError('UNSUPPORTED_XML_FORMAT', 'Currency must be a three-letter code.');
    const list = node(root.DanhSachHangHoa); shape(list, ['HangHoa']);
    const rawItems = Array.isArray(list.HangHoa) ? list.HangHoa : [list.HangHoa];
    if (!rawItems.length || rawItems.length > 1000) throw new IngestionError('UNSUPPORTED_XML_FORMAT', 'Invoice requires 1 to 1000 lines.');
    const items: CanonicalInvoiceItem[] = rawItems.map(raw => {
      const line = node(raw);
      shape(line, ['MHHDVu', 'THHDVu', 'SLuong', 'DGia', 'TSuat', 'ThTien', 'TienThue', 'TongTien']);
      const percent = text(line.TSuat, 100).replace(/%$/, '');
      exactDecimal(percent, 9, 2);
      if (new Exact(percent).gt('100')) throw new IngestionError('INVALID_TAX_RATE', 'VAT percentage must be between 0 and 100.');
      const item: CanonicalInvoiceItem = {
        ...(line.MHHDVu === undefined ? {} : { sku: text(line.MHHDVu, 100) }),
        description: text(line.THHDVu, 10000),
        quantity: exactDecimal(line.SLuong, 18, 4, true),
        unitPrice: exactDecimal(line.DGia, 18, 4),
        taxRate: exactDecimal(new Exact(percent).div('100').toFixed(4), 7, 4),
        lineSubtotal: exactDecimal(line.ThTien, 18, 2),
        taxAmount: exactDecimal(line.TienThue, 18, 2),
        lineTotal: exactDecimal(line.TongTien, 18, 2),
      };
      const subtotal = new Exact(new Exact(item.quantity).times(item.unitPrice).toFixed(2));
      const tax = new Exact(subtotal.times(item.taxRate).toFixed(2));
      reconcile(item.lineSubtotal, subtotal); reconcile(item.taxAmount, tax); reconcile(item.lineTotal, subtotal.plus(tax));
      return item;
    });
    const totals = node(root.TongTien); shape(totals, ['TgTCThue', 'TgTThue', 'TgTTTBSo']);
    const data: CanonicalInvoiceData = {
      sellerTaxCode: text(seller.MST, 50), buyerTaxCode: text(buyer.MST, 50),
      invoiceNumber: text(header.SHDon, 100), invoiceDate: date, currency, items,
      subtotal: exactDecimal(totals.TgTCThue, 18, 2),
      taxAmount: exactDecimal(totals.TgTThue, 18, 2),
      totalAmount: exactDecimal(totals.TgTTTBSo, 18, 2),
    };
    const subtotal = items.reduce((sum, item) => sum.plus(item.lineSubtotal), new Exact('0'));
    const tax = items.reduce((sum, item) => sum.plus(item.taxAmount), new Exact('0'));
    reconcile(data.subtotal, subtotal); reconcile(data.taxAmount, tax); reconcile(data.totalAmount, subtotal.plus(tax));
    return data;
  }
}
