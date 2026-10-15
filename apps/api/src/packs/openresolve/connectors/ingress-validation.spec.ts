/* SPDX-License-Identifier: MIT */
import { parseSourceEvent, sourceWitness } from './ingress-validation';
import { checksum, validateContent } from '../../../platform/evidence/file-safety';
const now = Date.parse('2026-10-15T00:00:00.000Z');
const order = () => ({ source_event_id: 'erp-evt-1', schema_id: 'openresolve.external-order.v1', observed_at: '2026-10-15T00:00:00Z',
  data: { external_order_id: 'ERP-PO-1', source_revision: 1, supplier_ref: 'SUP-1', currency: 'VND', lines: [
    { external_item_id: 'ERP-LINE-1', sku: 'CE285A', description: 'Fictional cartridge', ordered_quantity: '2', unit_price: '99999999999999.9999', tax_rate: '0.1' }] } });
const sensor = () => ({ source_event_id: 'sensor-evt-1', schema_id: 'openresolve.receiving-sensor.v1', observed_at: '2026-10-15T00:00:00.000Z',
  data: { external_order_id: 'ERP-PO-1', external_item_id: 'ERP-LINE-1', device_id: 'counter-fictional-1', sequence: 1, received_quantity: '1', quality: 'ACCEPTED', is_final: true } });
const bytes = value => Buffer.from(JSON.stringify(value), 'utf8');
describe('two independent source contracts and exact witness', () => {
  test('order quantities/prices remain exact decimal strings and native source/version/time are retained', () => {
    const result = parseSourceEvent(bytes(order()), 'EXTERNAL_ORDER', now);
    expect(result.event.observed_at).toBe('2026-10-15T00:00:00.000Z');
    expect(result.event.data).toMatchObject({ source_revision: 1, lines: [{ ordered_quantity: '2.0000', unit_price: '99999999999999.9999', tax_rate: '0.1000' }] });
  });
  test('receiving sensor has its own schema and never becomes an authoritative inventory write', () => {
    const result = parseSourceEvent(bytes(sensor()), 'RECEIVING_SENSOR', now);
    expect(result.event.data).toMatchObject({ received_quantity: '1.0000', quality: 'ACCEPTED', is_final: true });
    expect(() => parseSourceEvent(bytes(sensor()), 'EXTERNAL_ORDER', now)).toThrow('INVALID_REQUEST');
    expect(() => parseSourceEvent(bytes(order()), 'RECEIVING_SENSOR', now)).toThrow('INVALID_REQUEST');
  });
  test('whitespace/reordered JSON keys retain different raw hashes but the same immutable logical payload identity', () => {
    const value = order(), original = parseSourceEvent(bytes(value), 'EXTERNAL_ORDER', now), reordered = parseSourceEvent(Buffer.from(JSON.stringify({ data: value.data, observed_at: value.observed_at, schema_id: value.schema_id, source_event_id: value.source_event_id }, null, 2)), 'EXTERNAL_ORDER', now);
    expect(reordered.rawHash).not.toBe(original.rawHash); expect(reordered.contentHash).toBe(original.contentHash);
  });
  test.each(['tenant_id', 'actor_subject', 'source_url', 'quarantine_state'])('rejects client authority or unsupported property %s', key => {
    expect(() => parseSourceEvent(bytes({ ...order(), [key]: 'injected' }), 'EXTERNAL_ORDER', now)).toThrow('INVALID_REQUEST');
  });
  test.each(['2026-02-30T00:00:00Z', '2026-10-15T00:00:00+07:00', '2026-10-15T00:06:00Z'])('rejects invalid/non-UTC/future timestamp %s', observed_at => {
    expect(() => parseSourceEvent(bytes({ ...order(), observed_at }), 'EXTERNAL_ORDER', now)).toThrow('INVALID_REQUEST');
  });
  test('historical/offline observations are retained rather than silently discarded', () => {
    expect(parseSourceEvent(bytes({ ...order(), observed_at: '2025-01-01T00:00:00Z' }), 'EXTERNAL_ORDER', now).event.observed_at).toBe('2025-01-01T00:00:00.000Z');
  });
  test.each([1.5, -1, Number.MAX_SAFE_INTEGER + 1])('rejects invalid source sequence %s', sequence => {
    const value = sensor(); value.data.sequence = sequence; expect(() => parseSourceEvent(bytes(value), 'RECEIVING_SENSOR', now)).toThrow('INVALID_REQUEST');
  });
  test.each([1, '1e3', '-1', '0.12345'])('rejects numeric/nonplain/negative/overprecision financial input %s', value => {
    const source = order(); source.data.lines[0].unit_price = value as string; expect(() => parseSourceEvent(bytes(source), 'EXTERNAL_ORDER', now)).toThrow('INVALID_DECIMAL');
  });
  test('duplicate external line IDs are rejected before mapping', () => {
    const value = order(); value.data.lines.push(value.data.lines[0]); expect(() => parseSourceEvent(bytes(value), 'EXTERNAL_ORDER', now)).toThrow('INVALID_REQUEST');
  });
  test('malformed UTF-8, invalid JSON and oversized input fail before processing', () => {
    for (const value of [Buffer.from([255]), Buffer.from('{broken'), Buffer.alloc(0)]) expect(() => parseSourceEvent(value, 'EXTERNAL_ORDER', now)).toThrow('INVALID_REQUEST');
    expect(() => parseSourceEvent(Buffer.alloc(65537), 'EXTERNAL_ORDER', now)).toThrow('FILE_TOO_LARGE');
  });
  test('supported XML evidence serialization losslessly retains original JSON and actual SHA', async () => {
    const raw = bytes({ ...order(), source_event_id: 'unsafe<&>" string' }), witness = sourceWitness(raw);
    expect(witness.toString()).toContain('raw_sha256="' + checksum(raw) + '"');
    const body = />([^<]+)<\/source_event>/.exec(witness.toString())[1]; expect(Buffer.from(body, 'base64')).toEqual(raw);
    await expect(validateContent(witness, { filename: 'source-event.xml', media_type: 'application/xml', size_bytes: witness.length, sha256: checksum(witness),
      source: { kind: 'CONNECTOR', source_id: 'fictional-external-source', observed_at: new Date(now).toISOString() }, retention_class: 'STANDARD' }, 'application/xml')).resolves.toBeUndefined();
  });
});
