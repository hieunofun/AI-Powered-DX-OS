/* SPDX-License-Identifier: MIT */
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { Worker } from 'node:worker_threads';
import { EvidenceContext, EvidenceRegistration, fail } from './evidence.types';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/;
const SHA = /^[a-f0-9]{64}$/;
export const checksum = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export function contextValid(context: EvidenceContext): void {
  if (!context || typeof context.tenantId !== 'string' || !UUID.test(context.tenantId) || typeof context.subject !== 'string' || !context.subject || context.subject.length > 200) {
    fail('TENANT_CONTEXT_REQUIRED');
  }
}
export function idempotencyKey(key: string): void {
  if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(key)) fail('INVALID_REQUEST');
}
export function byteLimit(media: string): number { return media === 'application/xml' ? 5242880 : 20971520; }
const object = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function only(value: object, allowed: string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
export function registration(input: unknown): EvidenceRegistration {
  if (!object(input) || !only(input, ['filename', 'media_type', 'size_bytes', 'sha256', 'source', 'retention_class']) ||
    typeof input.filename !== 'string' || !input.filename || input.filename.length > 255 ||
    !['application/xml', 'application/pdf', 'image/png', 'image/jpeg'].includes(input.media_type) ||
    !Number.isSafeInteger(input.size_bytes) || input.size_bytes < 1 || typeof input.sha256 !== 'string' || input.sha256.length !== 64 || !SHA.test(input.sha256) ||
    !['STANDARD', 'RESTRICTED'].includes(input.retention_class) || !object(input.source) ||
    !only(input.source, ['kind', 'source_id', 'observed_at']) || !['USER_UPLOAD', 'CONNECTOR'].includes(input.source.kind) ||
    (input.source.source_id !== undefined && (typeof input.source.source_id !== 'string' || !input.source.source_id || input.source.source_id.length > 200)) ||
    (input.source.observed_at !== undefined && (typeof input.source.observed_at !== 'string' || !input.source.observed_at.endsWith('Z') || !Number.isFinite(Date.parse(input.source.observed_at))))) {
    fail('INVALID_REQUEST');
  }
  if (input.size_bytes > byteLimit(input.media_type)) fail('FILE_TOO_LARGE', 413);
  return { filename: input.filename, media_type: input.media_type, size_bytes: input.size_bytes,
    sha256: input.sha256, source: { kind: input.source.kind,
      ...(input.source.source_id !== undefined ? { source_id: input.source.source_id } : {}),
      ...(input.source.observed_at !== undefined ? { observed_at: input.source.observed_at } : {}) }, retention_class: input.retention_class };
}
export function fingerprint(value: unknown): string {
  function canonical(item: any): any {
    if (Array.isArray(item)) return item.map(canonical);
    if (object(item)) return Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])]));
    return item;
  }
  return checksum(Buffer.from(JSON.stringify(canonical(value))));
}
export async function boundedBytes(source: AsyncIterable<Buffer>, maximum: number, timeoutMs = 15000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0, timer: NodeJS.Timeout;
  const iterator = source[Symbol.asyncIterator]();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Evidence stream deadline exceeded.')), timeoutMs);
  });
  try {
    for (;;) {
      const item = await Promise.race([iterator.next(), timeout]);
      if (item.done) break;
      if (!Buffer.isBuffer(item.value)) fail('INVALID_REQUEST');
      total += item.value.length;
      if (total > maximum) fail('FILE_TOO_LARGE', 413);
      chunks.push(item.value);
    }
    return Buffer.concat(chunks, total);
  } finally {
    clearTimeout(timer);
    if (iterator.return) void iterator.return().catch(() => undefined);
  }
}
const xmlWorker = `
const { parentPort, workerData } = require('node:worker_threads');
try {
  const { XMLValidator } = require(workerData.validator);
  const text = workerData.text;
  const visible = text.replace(/<!--[\\s\\S]*?-->|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>/g, '');
  if (/&(?!(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)/.test(visible)) throw new Error();
  for (const match of visible.matchAll(/&#(x[0-9a-fA-F]+|[0-9]+);/g)) {
    const code = match[1].startsWith('x') ? parseInt(match[1].slice(1), 16) : Number(match[1]);
    if (![9,10,13].includes(code) && !(code >= 32 && code <= 0xd7ff || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff)) throw new Error();
  }
  let position = 0, depth = 0, elements = 0;
  while ((position = text.indexOf('<', position)) !== -1) {
    if (text.startsWith('<!--', position) || text.startsWith('<![CDATA[', position)) {
      const comment = text.startsWith('<!--', position), end = text.indexOf(comment ? '-->' : ']]>', position + (comment ? 4 : 9));
      if (end === -1) throw new Error(); position = end + 3; continue;
    }
    let end = position + 1, quote = '';
    for (; end < text.length; end++) {
      const char = text[end];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end === text.length) throw new Error();
    const tag = text.slice(position + 1, end).trim();
    if (!tag.startsWith('?')) {
      if (tag.startsWith('!')) throw new Error();
      if (tag.startsWith('/')) depth--;
      else { elements++; depth++; if (depth > 64 || elements > 10000) throw new Error(); if (tag.endsWith('/')) depth--; }
      if (depth < 0) throw new Error();
    }
    position = end + 1;
  }
  parentPort.postMessage(depth === 0 && XMLValidator.validate(text) === true);
} catch { parentPort.postMessage(false); }
`;
async function safeXml(text: string): Promise<void> {
  const valid = await new Promise<boolean>(resolve => {
    const worker = new Worker(xmlWorker, { eval: true, workerData: { text, validator: require.resolve('fast-xml-parser') },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 } });
    let ended = false;
    const finish = (value: boolean) => { if (ended) return; ended = true; clearTimeout(timer); void worker.terminate(); resolve(value); };
    const timer = setTimeout(() => finish(false), 2000);
    worker.once('message', value => finish(value === true));
    worker.once('error', () => finish(false)); worker.once('exit', () => finish(false));
  });
  if (!valid) fail('DRAFT_INVALID', 422);
}
function invalidXmlControls(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
  }
  return false;
}
export async function validateContent(bytes: Buffer, metadata: EvidenceRegistration, contentType: string): Promise<void> {
  if (!bytes.length) fail('INVALID_REQUEST');
  if (bytes.length > byteLimit(metadata.media_type)) fail('FILE_TOO_LARGE', 413);
  if (contentType.split(';')[0].trim().toLowerCase() !== metadata.media_type) fail('UNSUPPORTED_MEDIA_TYPE', 415);
  const magic = metadata.media_type === 'application/pdf' ? /^%PDF-[12]\.\d/.test(bytes.subarray(0, 8).toString('ascii')) :
    metadata.media_type === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) :
    metadata.media_type === 'image/jpeg' ? bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) : true;
  if (!magic) fail('UNSUPPORTED_MEDIA_TYPE', 415);
  if (metadata.media_type === 'application/xml') {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('UNSUPPORTED_MEDIA_TYPE', 415); }
    const declaration = /^\s*<\?xml\s+([^?]*)\?>/.exec(text);
    const encoding = declaration && /\bencoding\s*=\s*['"]([^'"]+)['"]/i.exec(declaration[1]);
    if (encoding && encoding[1].toUpperCase() !== 'UTF-8') fail('UNSUPPORTED_MEDIA_TYPE', 415);
    if (!text.trimStart().startsWith('<') || invalidXmlControls(text) || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) fail('DRAFT_INVALID', 422);
    await safeXml(text);
  }
  if (bytes.length !== metadata.size_bytes || checksum(bytes) !== metadata.sha256) fail('CHECKSUM_MISMATCH', 422);
}
export function storageKey(context: EvidenceContext, id: string, revision: number, token: string): string {
  contextValid(context);
  if (!UUID.test(id) || !UUID.test(token) || !Number.isSafeInteger(revision) || revision < 1) fail('INVALID_REQUEST');
  return 'tenant/' + context.tenantId + '/evidence/' + id + '/revision/' + revision + '/content/' + token;
}
