import { readFileSync } from 'fs';
import { resolve } from 'path';
import { InvoiceXmlParserService } from './invoice-xml-parser.service';
import { SmartProcureInvoiceV1Parser } from './smartprocure-invoice-v1.parser';
import { MatbaoInvoiceV200Parser } from './matbao-invoice-v200.parser';
import { IngestionError } from '../domain/ingestion-error';

describe('Verified Matbao/MIFI PBan 2.0.0 VAT layout', () => {
  const parser = new InvoiceXmlParserService(new SmartProcureInvoiceV1Parser(), new MatbaoInvoiceV200Parser());
  const valid = readFileSync(resolve(__dirname, '../../../../../infra/invoice/fixtures/valid-vietnam-provider-einvoice.xml')).toString();
  function expectCode(xml: string | Buffer, code: string) {
    try { parser.parse(Buffer.isBuffer(xml) ? xml : Buffer.from(xml)); throw new Error('Expected rejection'); }
    catch (error) {
      expect(error).toBeInstanceOf(IngestionError); expect(error.errorCode).toBe(code);
      expect(JSON.stringify(error.getResponse())).not.toMatch(/\/etc\/passwd|secret|stack|SignatureValue/);
    }
  }
  it('maps the externally verified layout, zero-padded money and grouped VAT to the same canonical strings', () => {
    const data = parser.parse(Buffer.from(valid));
    expect(data).toEqual({ sellerTaxCode: '0000000000-001', buyerTaxCode: '0000000001',
      invoiceNumber: '73', invoiceDate: '2022-02-14', currency: 'VND', subtotal: '201.26', taxAmount: '16.12', totalAmount: '217.38',
      items: [{ sku: 'TEST-INK', description: 'Mực in thử nghiệm', quantity: '1.2500', unitPrice: '0.8040', taxRate: '0.1000',
        lineSubtotal: '1.01', taxAmount: '0.10', lineTotal: '1.11' },
      { description: 'Giấy in thử nghiệm', quantity: '2.0000', unitPrice: '100.1234', taxRate: '0.0800',
        lineSubtotal: '200.25', taxAmount: '16.02', lineTotal: '216.27' }] });
  });
  it('accepts six decimal places only as lossless monetary padding', () => {
    expect(parser.parse(Buffer.from(valid.replace(/201\.2600/g, '201.260000'))).subtotal).toBe('201.26');
  });
  it('rejects nonzero excess money precision without quantizing', () => expectCode(valid.replace('201.2600', '201.2601'), 'DECIMAL_PRECISION_EXCEEDED'));
  it('bounds even zero-padded money scale', () => expectCode(valid.replace('201.2600', '201.2600000'), 'DECIMAL_PRECISION_EXCEEDED'));
  it.each([['1.2500', '1.25001'], ['100.1234', '100.12345'], ['10%', '10.001%'],
    ['201.2600', '10000000000000000.0000']])('preserves precision rejection %s', (from, to) => expectCode(valid.replace(from, to), 'DECIMAL_PRECISION_EXCEEDED'));
  it('rejects scientific notation', () => expectCode(valid.replace('1.2500', '1.25e0'), 'INVALID_DECIMAL'));
  it.each([['1.0100', '1.0200'], ['0.1000', '0.1100'], ['201.2600', '201.2500'],
    ['16.1200', '16.1300'], ['217.3800', '217.3900']])('reconciles line, VAT group and header value %s', (from, to) => expectCode(valid.replace(from, to), 'TOTAL_MISMATCH'));
  it('rejects duplicate or missing VAT groups', () => expectCode(valid.replace('<LTSuat><TSuat>8%', '<LTSuat><TSuat>10%'), 'TOTAL_MISMATCH'));
  it.each(['TLCKhau', 'STCKhau', 'TTCKTMai'])('rejects nonzero %s', field => {
    expectCode(valid.replace(new RegExp(`<${field}>[^<]+</${field}>`), `<${field}>1</${field}>`), 'UNSUPPORTED_INVOICE_FEATURE');
  });
  it.each(['TTHDLQuan', 'TTKhac', 'TGTKhac', 'Phi', 'RoundingRule'])('rejects unsupported concept %s', feature => {
    expectCode(valid.replace('</TToan>', `<${feature}>1</${feature}></TToan>`), 'UNSUPPORTED_INVOICE_FEATURE');
  });
  it('rejects adjustment/replacement headers', () => expectCode(valid.replace('</TTChung>', '<TTHDLQuan><TCHDon>2</TCHDon></TTHDLQuan></TTChung>'), 'UNSUPPORTED_INVOICE_FEATURE'));
  it('rejects non-ordinary line types', () => expectCode(valid.replace('<TChat>1', '<TChat>3'), 'UNSUPPORTED_INVOICE_FEATURE'));
  it('rejects foreign exchange', () => expectCode(valid.replace('VND', 'USD'), 'UNSUPPORTED_INVOICE_FEATURE'));
  it('requires sequential line numbers', () => expectCode(valid.replace('<STT>2', '<STT>1'), 'UNSUPPORTED_XML_FORMAT'));
  it('requires buyer tax code for this B2B subset', () => expectCode(valid.replace('<MST>0000000001</MST>', ''), 'UNSUPPORTED_XML_FORMAT'));
  it('rejects repeated business payloads', () => expectCode(valid.replace('</DLHDon>', '</DLHDon><DLHDon><TTChung><PBan>2.0.0</PBan></TTChung></DLHDon>'), 'UNSUPPORTED_XML_FORMAT'));
  it('does not guess unsupported profile versions', () => expectCode(valid.replace('2.0.0', '2.0.1'), 'UNSUPPORTED_XML_FORMAT'));
  it('uses only the direct business payload even when signatures contain another invoice', () => {
    const xml = valid.replace('</HDon>', '<DSCKS><NBan><Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><Object><HDon><DLHDon>ignored</DLHDon></HDon></Object></Signature></NBan></DSCKS></HDon>');
    expect(parser.parse(Buffer.from(xml)).invoiceNumber).toBe('73');
  });
  it('rejects DTD/external entities before either adapter can run', () => {
    expectCode(valid.replace('<HDon>', '<!DOCTYPE HDon [<!ENTITY x SYSTEM "file:///etc/passwd">]><HDon>'), 'UNSAFE_XML');
    expectCode(valid.replace('<HDon>', '<!DOCTYPE HDon SYSTEM "https://example.invalid/secret"><HDon>'), 'UNSAFE_XML');
  });
  it('rejects malformed provider XML', () => expectCode(valid.replace('</DLHDon>', ''), 'MALFORMED_XML'));
  it('rejects invalid UTF-8', () => expectCode(Buffer.concat([Buffer.from(valid), Buffer.from([255])]), 'UNSUPPORTED_MEDIA_TYPE'));
  it('rejects null bytes and undeclared entities', () => {
    expectCode(valid.replace('TEST-INK', 'TEST\0INK'), 'UNSUPPORTED_MEDIA_TYPE');
    expectCode(valid.replace('TEST-INK', 'TEST&secret;INK'), 'MALFORMED_XML');
  });
});
