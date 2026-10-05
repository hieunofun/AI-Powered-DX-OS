import { Injectable } from '@nestjs/common';
import { CanonicalInvoiceData, CanonicalInvoiceItem } from '../interfaces/invoice.interface';
import { IngestionError } from '../domain/ingestion-error';
import { InvoiceXmlParser } from './invoice-xml-parser.interface';
import { XmlNode, Exact, node, shape, text, exactDecimal, reconcile, vatFraction,
  dateValue, currencyValue, lineAmounts, reconcileInvoice } from './invoice-xml-validation';

// Format reference only; no provider source code or sample business data copied.
// Matbao-invoice/MIFI's public ND123 example, published 2022-03-17:
// https://matbao.in/articles/cau-truc-hoa-don-theo-nd-123
// Buyer MST and grouped VAT paths cross-checked in the provider's published tables:
// https://matbao.in/articles/quyet-dinh-so-1510-qd-tct-bo-sung-quyet-dinh-1450-2020
function money(value: unknown): string {
  const raw = text(value);
  // This external layout prints padded money (e.g. 140000.0000). Strip only
  // insignificant zeros, never round; reject any nonzero precision beyond cents.
  if (!/^\d+(\.\d+)?$/.test(raw)) return exactDecimal(raw, 18, 2);
  const [integer, fraction = ''] = raw.split('.');
  if (fraction.length > 6) throw new IngestionError('DECIMAL_PRECISION_EXCEEDED', 'Provider money exceeds six lexical decimal places.');
  const significant = fraction.replace(/0+$/, '');
  return exactDecimal(integer + (significant ? `.${significant}` : ''), 18, 2);
}
function zeroDiscount(value: unknown): void {
  if (value !== undefined && !new Exact(exactDecimal(value, 21, 6)).isZero()) {
    throw new IngestionError('UNSUPPORTED_INVOICE_FEATURE', 'Discounts are not supported by this invoice profile.');
  }
}
function optionalTexts(value: XmlNode, keys: string[]): void {
  for (const key of keys) if (value[key] !== undefined) text(value[key], 1000);
}

/** Matbao-published PBan 2.0.0 ordinary VAT/B2B/VND subset, not universal TCT support. */
@Injectable()
export class MatbaoInvoiceV200Parser implements InvoiceXmlParser {
  readonly profile = 'Matbao-invoice/MIFI PBan 2.0.0 VAT subset';
  supports(document: XmlNode): boolean {
    try { return node(node(node(document.HDon).DLHDon).TTChung).PBan === '2.0.0'; }
    catch { return false; }
  }
  parse(document: XmlNode): CanonicalInvoiceData {
    shape(document, ['HDon']);
    const root = node(document.HDon);
    shape(root, ['DLHDon', 'DLQRCode', 'MCCQT', 'DSCKS']);
    if (root.DLQRCode !== undefined) text(root.DLQRCode, 1000);
    if (root.MCCQT !== undefined && root.MCCQT !== '') text(root.MCCQT, 100);
    if (root.DSCKS !== undefined) {
      const signatures = node(root.DSCKS); shape(signatures, ['NBan', 'NMua', 'CQT']);
      for (const owner of Object.keys(signatures).filter(key => key !== '#text')) {
        const signature = node(signatures[owner]); shape(signature, ['Signature']); node(signature.Signature);
      }
      // Signature subtrees are retained in the raw archive only. No verification,
      // certificate trust, tax-authority validation or nested invoice selection.
    }
    const data = node(root.DLHDon); shape(data, ['@_Id', 'TTChung', 'NDHDon']);
    if (data['@_Id'] !== undefined) text(data['@_Id']);
    const header = node(data.TTChung);
    shape(header, ['PBan', 'THDon', 'KHMSHDon', 'KHHDon', 'SHDon', 'NLap', 'DVTTe', 'HTTToan', 'MSTTCGP']);
    if (header.PBan !== '2.0.0' || header.KHMSHDon !== '1' || currencyValue(header.DVTTe) !== 'VND') {
      throw new IngestionError('UNSUPPORTED_INVOICE_FEATURE', 'This provider profile supports ordinary VAT invoices in VND only.');
    }
    text(header.THDon, 255); text(header.KHHDon, 6);
    optionalTexts(header, ['HTTToan', 'MSTTCGP']);
    const number = text(header.SHDon, 8);
    if (!/^\d{1,8}$/.test(number) || /^0+$/.test(number)) {
      throw new IngestionError('UNSUPPORTED_XML_FORMAT', 'Provider invoice number must be a positive one-to-eight-digit string.');
    }
    const content = node(data.NDHDon); shape(content, ['NBan', 'NMua', 'DSHHDVu', 'TToan']);
    const seller = node(content.NBan), buyer = node(content.NMua);
    shape(seller, ['Ten', 'MST', 'DChi', 'SDThoai', 'DCTDTu', 'Website']);
    shape(buyer, ['Ten', 'MST', 'DChi', 'HVTNMHang']);
    text(seller.Ten, 400); text(seller.DChi, 400);
    optionalTexts(seller, ['SDThoai', 'DCTDTu', 'Website']); optionalTexts(buyer, ['Ten', 'DChi', 'HVTNMHang']);
    const list = node(content.DSHHDVu); shape(list, ['HHDVu']);
    const rows = Array.isArray(list.HHDVu) ? list.HHDVu : [list.HHDVu];
    if (!rows.length || rows.length > 1000) throw new IngestionError('UNSUPPORTED_XML_FORMAT', 'Invoice requires 1 to 1000 lines.');
    const items: CanonicalInvoiceItem[] = rows.map((raw, index) => {
      const line = node(raw);
      shape(line, ['TChat', 'STT', 'MHHDVu', 'THHDVu', 'DVTinh', 'SLuong', 'DGia', 'TLCKhau', 'STCKhau', 'ThTien', 'TSuat']);
      if (line.TChat !== '1') throw new IngestionError('UNSUPPORTED_INVOICE_FEATURE', 'Only ordinary goods/service lines are supported.');
      if (line.STT !== undefined && line.STT !== String(index + 1)) {
        throw new IngestionError('UNSUPPORTED_XML_FORMAT', 'Provider line numbers must be sequential in document order.');
      }
      optionalTexts(line, ['DVTinh']); zeroDiscount(line.TLCKhau); zeroDiscount(line.STCKhau);
      const quantity = exactDecimal(line.SLuong, 18, 4, true), unitPrice = exactDecimal(line.DGia, 18, 4);
      const taxRate = vatFraction(line.TSuat), lineSubtotal = money(line.ThTien);
      const calculated = lineAmounts(quantity, unitPrice, taxRate);
      reconcile(lineSubtotal, new Exact(calculated.lineSubtotal));
      // The referenced layout has no line-tax/line-total tags. Derive them under
      // the documented half-up rule, then reconcile every declared VAT group.
      return { ...(line.MHHDVu === undefined ? {} : { sku: text(line.MHHDVu, 50) }),
        description: text(line.THHDVu, 500), quantity, unitPrice, taxRate, ...calculated };
    });
    const totals = node(content.TToan);
    shape(totals, ['THTTLTSuat', 'TgTCThue', 'TgTThue', 'TTCKTMai', 'TgTTTBSo', 'TgTTTBChu']);
    zeroDiscount(totals.TTCKTMai); optionalTexts(totals, ['TgTTTBChu']);
    const groups = node(totals.THTTLTSuat); shape(groups, ['LTSuat']);
    const rates = Array.isArray(groups.LTSuat) ? groups.LTSuat : [groups.LTSuat];
    const expected = new Map<string, { subtotal: InstanceType<typeof Exact>; tax: InstanceType<typeof Exact> }>();
    for (const line of items) {
      const group = expected.get(line.taxRate) || { subtotal: new Exact('0'), tax: new Exact('0') };
      group.subtotal = group.subtotal.plus(line.lineSubtotal); group.tax = group.tax.plus(line.taxAmount);
      expected.set(line.taxRate, group);
    }
    if (rates.length !== expected.size) throw new IngestionError('TOTAL_MISMATCH', 'Declared VAT groups do not match invoice lines.');
    for (const raw of rates) {
      const group = node(raw); shape(group, ['TSuat', 'ThTien', 'TThue']);
      const rate = vatFraction(group.TSuat), sum = expected.get(rate);
      if (!sum) throw new IngestionError('TOTAL_MISMATCH', 'Declared VAT groups are missing, duplicated or inconsistent.');
      reconcile(money(group.ThTien), sum.subtotal); reconcile(money(group.TThue), sum.tax); expected.delete(rate);
    }
    const invoice: CanonicalInvoiceData = {
      sellerTaxCode: text(seller.MST, 14), buyerTaxCode: text(buyer.MST, 14),
      invoiceNumber: number, invoiceDate: dateValue(header.NLap), currency: 'VND', items,
      subtotal: money(totals.TgTCThue), taxAmount: money(totals.TgTThue), totalAmount: money(totals.TgTTTBSo),
    };
    reconcileInvoice(invoice);
    return invoice;
  }
}
