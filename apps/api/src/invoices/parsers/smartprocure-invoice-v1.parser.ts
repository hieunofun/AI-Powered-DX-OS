import { Injectable } from '@nestjs/common';
import { CanonicalInvoiceData, CanonicalInvoiceItem } from '../interfaces/invoice.interface';
import { IngestionError } from '../domain/ingestion-error';
import { InvoiceXmlParser } from './invoice-xml-parser.interface';
import { XmlNode, Exact, node, shape, text, exactDecimal, reconcile,
  vatFraction, dateValue, currencyValue, lineAmounts, reconcileInvoice } from './invoice-xml-validation';

/** SmartProcureInvoice v1 project profile, not a universal provider/TCT adapter. */
@Injectable()
export class SmartProcureInvoiceV1Parser implements InvoiceXmlParser {
  readonly profile = 'SmartProcureInvoice v1';
  supports(document: XmlNode): boolean {
    const root = document.SmartProcureInvoice;
    return !!root && typeof root === 'object' && !Array.isArray(root) && (root as XmlNode)['@_version'] === '1';
  }
  parse(document: XmlNode): CanonicalInvoiceData {
    shape(document, ['SmartProcureInvoice']);
    const root = node(document.SmartProcureInvoice);
    shape(root, ['@_version', 'NguoiBan', 'NguoiMua', 'ThongTinChung', 'DanhSachHangHoa', 'TongTien']);
    const seller = node(root.NguoiBan), buyer = node(root.NguoiMua), header = node(root.ThongTinChung);
    shape(seller, ['MST']); shape(buyer, ['MST']); shape(header, ['SHDon', 'NLap', 'DVTTe']);
    const date = dateValue(header.NLap), currency = currencyValue(header.DVTTe);
    const list = node(root.DanhSachHangHoa); shape(list, ['HangHoa']);
    const rawItems = Array.isArray(list.HangHoa) ? list.HangHoa : [list.HangHoa];
    if (!rawItems.length || rawItems.length > 1000) throw new IngestionError('UNSUPPORTED_XML_FORMAT', 'Invoice requires 1 to 1000 lines.');
    const items: CanonicalInvoiceItem[] = rawItems.map(raw => {
      const line = node(raw);
      shape(line, ['MHHDVu', 'THHDVu', 'SLuong', 'DGia', 'TSuat', 'ThTien', 'TienThue', 'TongTien']);
      const item: CanonicalInvoiceItem = {
        ...(line.MHHDVu === undefined ? {} : { sku: text(line.MHHDVu, 100) }),
        description: text(line.THHDVu, 10000),
        quantity: exactDecimal(line.SLuong, 18, 4, true),
        unitPrice: exactDecimal(line.DGia, 18, 4),
        taxRate: vatFraction(line.TSuat),
        lineSubtotal: exactDecimal(line.ThTien, 18, 2),
        taxAmount: exactDecimal(line.TienThue, 18, 2),
        lineTotal: exactDecimal(line.TongTien, 18, 2),
      };
      const calculated = lineAmounts(item.quantity, item.unitPrice, item.taxRate);
      reconcile(item.lineSubtotal, new Exact(calculated.lineSubtotal));
      reconcile(item.taxAmount, new Exact(calculated.taxAmount)); reconcile(item.lineTotal, new Exact(calculated.lineTotal));
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
    reconcileInvoice(data);
    return data;
  }
}
