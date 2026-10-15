/* SPDX-License-Identifier: MIT */
import { TextDecoder } from 'node:util';
import { exactDecimal, Exact } from '../../../invoices/parsers/invoice-xml-validation';
import { fail } from '../../../platform/evidence/evidence.types';
import { checksum, fingerprint } from '../../../platform/evidence/file-safety';
import { ExternalOrderData, ReceivingSensorData, SourceEvent, SourceKind } from './ingress.types';
const object = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const strict = (value: unknown, fields: string[]): value is Record<string, any> => object(value) && Object.keys(value).every(key => fields.includes(key));
function text(value: unknown, maximum = 100): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) fail('INVALID_REQUEST'); return value;
}
function integer(value: unknown, minimum: number): number { if (!Number.isSafeInteger(value) || (value as number) < minimum) fail('INVALID_REQUEST'); return value as number; }
function decimal(value: unknown, precision: number, scale: number, positive = false): string {
  try { return exactDecimal(value, precision, scale, positive); } catch { fail('INVALID_DECIMAL', 422); }
}
function observed(value: unknown, now: number): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) fail('INVALID_REQUEST');
  const timestamp = Date.parse(value);
  const normalized = value.includes('.') ? value.replace(/\.(\d{1,3})Z$/, (_all, part) => '.' + part.padEnd(3, '0') + 'Z') : value.replace('Z', '.000Z');
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== normalized || timestamp > now + 300000) fail('INVALID_REQUEST');
  // Historical/offline observations are retained; age is provenance, not a reason to silently drop accepted facts.
  return new Date(timestamp).toISOString();
}
export function parseSourceEvent(bytes: Buffer, kind: SourceKind, now: number): { event: SourceEvent; rawHash: string; contentHash: string } {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || !['EXTERNAL_ORDER', 'RECEIVING_SENSOR'].includes(kind)) fail('INVALID_REQUEST');
  if (bytes.length > 65536) fail('FILE_TOO_LARGE', 413);
  let value: any;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('INVALID_REQUEST'); }
  if (!strict(value, ['source_event_id', 'schema_id', 'observed_at', 'data']) ||
    value.schema_id !== (kind === 'EXTERNAL_ORDER' ? 'openresolve.external-order.v1' : kind === 'RECEIVING_SENSOR' ? 'openresolve.receiving-sensor.v1' : undefined)) fail('INVALID_REQUEST');
  const id = text(value.source_event_id, 100), timestamp = observed(value.observed_at, now); let data: ExternalOrderData | ReceivingSensorData;
  if (kind === 'EXTERNAL_ORDER') {
    const input = value.data;
    if (!strict(input, ['external_order_id', 'source_revision', 'supplier_ref', 'currency', 'lines']) || !Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 100 ||
      typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency) || input.currency.length !== 3) fail('INVALID_REQUEST');
    const items = new Set<string>();
    data = { external_order_id: text(input.external_order_id), source_revision: integer(input.source_revision, 1), supplier_ref: text(input.supplier_ref), currency: input.currency,
      lines: input.lines.map(item => {
        if (!strict(item, ['external_item_id', 'sku', 'description', 'ordered_quantity', 'unit_price', 'tax_rate'])) fail('INVALID_REQUEST');
        const externalId = text(item.external_item_id); if (items.has(externalId)) fail('INVALID_REQUEST'); items.add(externalId);
        const rate = decimal(item.tax_rate, 7, 4); if (new Exact(rate).gt('1')) fail('INVALID_DECIMAL', 422);
        return { external_item_id: externalId, sku: text(item.sku), description: text(item.description, 500),
          ordered_quantity: decimal(item.ordered_quantity, 18, 4, true), unit_price: decimal(item.unit_price, 18, 4), tax_rate: rate };
      }) };
  } else {
    const input = value.data;
    if (!strict(input, ['external_order_id', 'external_item_id', 'device_id', 'sequence', 'received_quantity', 'quality', 'is_final']) ||
      !['ACCEPTED', 'DAMAGED', 'UNKNOWN'].includes(input.quality) || typeof input.is_final !== 'boolean') fail('INVALID_REQUEST');
    data = { external_order_id: text(input.external_order_id), external_item_id: text(input.external_item_id), device_id: text(input.device_id), sequence: integer(input.sequence, 0),
      received_quantity: decimal(input.received_quantity, 18, 4), quality: input.quality, is_final: input.is_final };
  }
  return { event: { source_event_id: id, schema_id: value.schema_id, observed_at: timestamp, data }, rawHash: checksum(bytes), contentHash: fingerprint(value) };
}
// Lossless original JSON witness in a supported evidence XML container; the original raw bytes/hash are also retained in SQL.
// CLEAN applies to this actual serialized witness, not a source-authenticity claim or permission to execute its JSON text.
export function sourceWitness(bytes: Buffer): Buffer {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1) fail('INVALID_REQUEST');
  if (bytes.length > 65536) fail('FILE_TOO_LARGE', 413);
  return Buffer.from('<?xml version="1.0" encoding="UTF-8"?><source_event encoding="base64" raw_sha256="' + checksum(bytes) + '">' + bytes.toString('base64') + '</source_event>', 'utf8');
}
