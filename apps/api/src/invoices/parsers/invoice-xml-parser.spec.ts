import { readFileSync } from 'fs';
import { resolve } from 'path';
import { InvoiceXmlParserService } from './invoice-xml-parser.service';
import { exactDecimal } from './invoice-xml-validation';
import { SmartProcureInvoiceV1Parser } from './smartprocure-invoice-v1.parser';
import { MatbaoInvoiceV200Parser } from './matbao-invoice-v200.parser';
import { IngestionError } from '../domain/ingestion-error';

const fixture = (name: string) => readFileSync(resolve(__dirname, '../../../../../infra/invoice/fixtures', name));
describe('Supported XML profile and exact financial validation', () => {
  const parser = new InvoiceXmlParserService(new SmartProcureInvoiceV1Parser(), new MatbaoInvoiceV200Parser());
  const valid = fixture('valid-vn-einvoice.xml').toString();
  function expectCode(xml: string | Buffer, code: string) {
    try { parser.parse(Buffer.isBuffer(xml) ? xml : Buffer.from(xml)); throw new Error('Expected rejection'); }
    catch (error) { expect(error).toBeInstanceOf(IngestionError); expect(error.errorCode).toBe(code); }
  }
  it('maps seller/buyer, preserves number, normalizes VAT and exact rounding boundary', () => {
    const invoice = parser.parse(Buffer.from(valid));
    expect(invoice).toMatchObject({ sellerTaxCode: '0101234567-001', buyerTaxCode: '0312345678',
      invoiceNumber: 'INV-001', invoiceDate: '2026-10-05', currency: 'VND',
      subtotal: '201.26', taxAmount: '16.12', totalAmount: '217.38' });
    expect(invoice.items[0]).toEqual({ sku: 'INK-85A', description: 'Mực in HP 85A', quantity: '1.2500',
      unitPrice: '0.8040', taxRate: '0.1000', lineSubtotal: '1.01', taxAmount: '0.10', lineTotal: '1.11' });
    expect(invoice.items[1].taxRate).toBe('0.0800');
    expect(invoice.items[1].unitPrice).toBe('100.1234');
  });
  it('accepts UTF-8 BOM and whitespace', () => expect(parser.parse(Buffer.from('\ufeff  \n' + valid.replace(/<\?xml.*?\?>/, ''))).items).toHaveLength(2));
  it.each([['malformed.xml', 'MALFORMED_XML'], ['unsupported-format.xml', 'UNSUPPORTED_XML_FORMAT'],
    ['xxe.xml', 'UNSAFE_XML']])('rejects %s with %s', (file, code) => expectCode(fixture(file), code));
  it('rejects external HTTP entity and internal expansion declarations before parsing', () => {
    expectCode('<!DOCTYPE x SYSTEM "http://127.0.0.1:12345/private">' + valid, 'UNSAFE_XML');
    expectCode('<!ENTITY a "expansion">' + valid, 'UNSAFE_XML');
  });
  it('rejects binary/null bytes', () => expectCode(Buffer.from('<xml>\0</xml>'), 'UNSUPPORTED_MEDIA_TYPE'));
  it('rejects invalid UTF-8', () => expectCode(Buffer.from([60, 255, 62]), 'UNSUPPORTED_MEDIA_TYPE'));
  it('rejects unsupported encoding', () => expectCode(valid.replace('UTF-8', 'UTF-16'), 'UNSUPPORTED_XML_FORMAT'));
  it.each(['Discount', 'Allowance', 'Surcharge', 'RoundingRule'])('rejects unsupported %s instead of discarding it', feature => {
    expectCode(valid.replace('</TongTien>\n</Smart', `</TongTien><${feature}>0</${feature}>\n</Smart`), 'UNSUPPORTED_INVOICE_FEATURE');
  });
  it('rejects repeated required fields', () => expectCode(valid.replace('<MST>0312345678</MST>', '<MST>a</MST><MST>b</MST>'), 'UNSUPPORTED_XML_FORMAT'));
  it('rejects nested scalar fields', () => expectCode(valid.replace('INV-001', '<Unexpected>INV-001</Unexpected>'), 'UNSUPPORTED_XML_FORMAT'));
  it.each([['1.2500', '1.25001'], ['100.1234', '100.12345'], ['201.26', '201.260'], ['10%', '10.001%']])(
    'rejects excess scale %s -> %s', (from, to) => expectCode(valid.replace(from, to), 'DECIMAL_PRECISION_EXCEEDED'));
  it('rejects invalid numeric notation', () => expectCode(valid.replace('1.2500', '1.25e0'), 'INVALID_DECIMAL'));
  it('rejects zero quantity', () => expectCode(valid.replace('1.2500', '0.0000'), 'INVALID_DECIMAL'));
  it('rejects overflow without rounding', () => expect(() => exactDecimal('100000000000000.0000', 18, 4)).toThrow(IngestionError));
  it.each([['1.01', '1.00'], ['0.10', '0.11'], ['1.11', '1.12'], ['201.26', '201.25'],
    ['16.12', '16.13'], ['217.38', '217.37']])('reconciles declared total %s', (from, to) => expectCode(valid.replace(from, to), 'TOTAL_MISMATCH'));
  it('rejects nonexistent date', () => expectCode(valid.replace('2026-10-05', '2026-02-30'), 'INVALID_INVOICE_DATE'));
  it('rejects mixed content rather than losing financial concepts', () => expectCode(valid.replace('<NguoiBan>', '<NguoiBan>ignored'), 'UNSUPPORTED_INVOICE_FEATURE'));
  it('decodes standard XML character references without enabling DTD entities', () => {
    const data = parser.parse(Buffer.from(valid.replace('Mực in HP 85A', 'Mực &amp; giấy')));
    expect(data.items[0].description).toBe('Mực & giấy');
  });
  it('rejects null-byte character references', () => expectCode(valid.replace('INV-001', 'INV&#0;001'), 'MALFORMED_XML'));
  it('rejects undeclared entities', () => expectCode(valid.replace('INV-001', 'INV&unknown;001'), 'MALFORMED_XML'));
});
