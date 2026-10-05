import { createHash } from 'crypto';
import { TextDecoder } from 'util';
import { FileKind } from '../interfaces/invoice.interface';
import { IngestionError } from './ingestion-error';

export function fileLimit(kind: FileKind): number {
  const name = kind === 'XML' ? 'INVOICE_XML_MAX_BYTES' : 'INVOICE_PDF_MAX_BYTES';
  const value = process.env[name] || (kind === 'XML' ? '5242880' : '20971520');
  const limit = Number(value);
  // Absolute safety ceiling: a configuration mistake cannot enable unbounded uploads.
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(limit) || limit < 1 || limit > 104857600) {
    throw new Error(`${name} must be an integer between 1 and 104857600.`);
  }
  return limit;
}

export function xmlText(buffer: Buffer): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (Array.from(text).some(character => {
      const code = character.charCodeAt(0);
      return code < 32 && ![9, 10, 13].includes(code);
    }) || !text.trimStart().startsWith('<')) {
      throw new Error('binary');
    }
    return text;
  } catch {
    throw new IngestionError('UNSUPPORTED_MEDIA_TYPE', 'XML must contain UTF-8 XML text without binary or null bytes.', 415);
  }
}

export function validateFile(file: Express.Multer.File, kind: FileKind): void {
  if (!file.buffer.length) throw new IngestionError('EMPTY_FILE', 'Uploaded files must not be empty.', 400);
  if (file.buffer.length > fileLimit(kind)) throw new IngestionError('FILE_TOO_LARGE', `${kind} exceeds the configured byte limit.`, 413);
  const mime = file.mimetype.toLowerCase().split(';')[0].trim();
  if (kind === 'XML') {
    if (!(mime === 'application/xml' || mime === 'text/xml' || /^application\/[a-z0-9.+-]+\+xml$/.test(mime))) {
      throw new IngestionError('UNSUPPORTED_MEDIA_TYPE', 'An XML-compatible media type is required.', 415);
    }
    xmlText(file.buffer);
  } else if (mime !== 'application/pdf' || !/^%PDF-[12]\.\d/.test(file.buffer.subarray(0, 8).toString('ascii'))) {
    throw new IngestionError('UNSUPPORTED_MEDIA_TYPE', 'A PDF media type and PDF signature are required.', 415);
  }
}

export function sha256(buffer: Buffer): string { return createHash('sha256').update(buffer).digest('hex'); }

export function objectKey(ingestionId: string, fileId: string, kind: FileKind, date = new Date()): string {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(ingestionId) || !uuid.test(fileId)) throw new Error('Object keys require server UUIDs.');
  return `invoices/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${ingestionId}/${fileId}.${kind.toLowerCase()}`;
}
