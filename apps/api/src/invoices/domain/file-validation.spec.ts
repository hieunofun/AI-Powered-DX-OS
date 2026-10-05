import { randomUUID } from 'crypto';
import { normalizeInvoiceNumber, normalizeTaxCode } from './normalization';
import { fileLimit, objectKey, sha256, validateFile } from './file-validation';

function file(bytes: string | Buffer, mimetype: string, originalname = '../../invoice.exe'): Express.Multer.File {
  return { buffer: Buffer.from(bytes), mimetype, originalname } as Express.Multer.File;
}
describe('Invoice identity and raw file security', () => {
  it.each(['INV-001', 'inv-001', 'INV 001', 'INV_001', ' ＩＮＶ－００１ ', 'INV\t001'])('canonicalizes %s', value => {
    expect(normalizeInvoiceNumber(value)).toBe('INV001');
  });
  it('preserves meaningful punctuation', () => expect(normalizeInvoiceNumber('inv/001.2')).toBe('INV/001.2'));
  it('rejects empty identity', () => expect(() => normalizeInvoiceNumber(' _ - ')).toThrow());
  it('normalizes tax formatting but preserves underscore and slash', () => {
    expect(normalizeTaxCode(' ０１０１２３４５６７ - ００１ ')).toBe('0101234567001');
    expect(normalizeTaxCode('ab_c/d')).toBe('AB_C/D');
  });
  it('hashes original bytes using known SHA-256 vector', () => {
    expect(sha256(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('creates keys only from UUIDs and UTC date', () => {
    const ingestion = randomUUID(), id = randomUUID();
    expect(objectKey(ingestion, id, 'XML', new Date('2026-10-05T00:00:00Z'))).toBe(`invoices/2026/10/${ingestion}/${id}.xml`);
    expect(() => objectKey('../../traversal', id, 'XML')).toThrow();
  });
  it('accepts signature despite misleading filename extension', () => {
    expect(() => validateFile(file('%PDF-1.4\n%%EOF', 'application/pdf'), 'PDF')).not.toThrow();
    expect(() => validateFile(file('\ufeff \n<invoice/>', 'application/vnd.invoice+xml'), 'XML')).not.toThrow();
  });
  it('rejects valid extension with invalid signature', () => expect(() => validateFile(file('not PDF', 'application/pdf', 'invoice.pdf'), 'PDF')).toThrow());
  it('requires compatible MIME even with valid signature', () => expect(() => validateFile(file('%PDF-1.4', 'text/plain'), 'PDF')).toThrow());
  it('rejects empty and binary XML', () => {
    expect(() => validateFile(file('', 'application/xml'), 'XML')).toThrow();
    expect(() => validateFile(file('<xml>\0</xml>', 'application/xml'), 'XML')).toThrow();
  });
  it.each(['XML', 'PDF'] as const)('enforces configured %s byte limit', kind => {
    const name = `INVOICE_${kind}_MAX_BYTES`, previous = process.env[name];
    process.env[name] = '8';
    try { expect(() => validateFile(file('123456789', kind === 'XML' ? 'application/xml' : 'application/pdf'), kind)).toThrow(); }
    finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
  });
  it('fails closed on unbounded configuration', () => {
    const previous = process.env.INVOICE_XML_MAX_BYTES; process.env.INVOICE_XML_MAX_BYTES = 'Infinity';
    try { expect(() => fileLimit('XML')).toThrow(); }
    finally { if (previous === undefined) delete process.env.INVOICE_XML_MAX_BYTES; else process.env.INVOICE_XML_MAX_BYTES = previous; }
  });
});
