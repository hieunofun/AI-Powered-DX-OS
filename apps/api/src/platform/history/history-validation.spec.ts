/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { fingerprint } from '../evidence/file-safety';
import { historyEntry } from '../../../test/history.fixtures';
import { retention, sequence, utc, validateEntry, validatePage } from './history-validation';
const ctx = { tenantId: randomUUID(), subject: 'archive-worker' };
describe('cold history source contract (explicit immutable source fixtures)', () => {
  it('preserves BIGINT cursors beyond JS safe integers without rounding', () => {
    expect(sequence('9007199254740993')).toBe('9007199254740993'); expect(sequence('9223372036854775807')).toBe('9223372036854775807');
  });
  it.each([1, null, '01', '-1', '1e3', '9223372036854775808'])('rejects invalid cursor %j', value => { expect(() => sequence(value)).toThrow(); });
  it('checks actual UTC calendar and millisecond profile without rewriting timestamps', () => {
    expect(utc('2024-02-29T00:00:00Z')).toBe(true); expect(utc('2026-01-01T00:00:00.123Z')).toBe(true);
    for (const at of ['2026-02-31T00:00:00Z', '2026-01-01T00:00:00+07:00', 'invalid']) expect(utc(at)).toBe(false);
  });
  it('validates source/native tenant and immutable payload hashes', () => {
    const entry = historyEntry(ctx.tenantId); expect(validateEntry(ctx, entry)).toEqual(entry);
    expect(() => validateEntry({ ...ctx, tenantId: randomUUID() }, entry)).toThrow(); entry.snapshot.payload.invoice_total = '1';
    expect(() => validateEntry(ctx, entry)).toThrow(expect.objectContaining({ code: 'CHECKSUM_MISMATCH' }));
  });
  it('requires exact decimal strings rather than unsafe fractional JSON numbers', () => {
    const entry = historyEntry(ctx.tenantId); entry.snapshot.payload.invoice_total = 0.1; entry.snapshot.sha256 = fingerprint(entry.snapshot.payload);
    expect(() => validateEntry(ctx, entry)).toThrow();
  });
  it('bounds payload depth/size and rejects unknown authority fields', () => {
    const entry = historyEntry(ctx.tenantId); (entry.event as any).approved = true; expect(() => validateEntry(ctx, entry)).toThrow();
    delete (entry.event as any).approved; entry.snapshot.payload.content = 'x'.repeat(65537); entry.snapshot.sha256 = fingerprint(entry.snapshot.payload);
    expect(() => validateEntry(ctx, entry)).toThrow(expect.objectContaining({ code: 'FILE_TOO_LARGE' }));
  });
  it('rejects impossible case duration/classification and fabricated retention', () => {
    const entry = historyEntry(ctx.tenantId); entry.case_metric.finished_at = '2025-01-01T00:00:00Z'; expect(() => validateEntry(ctx, entry)).toThrow();
    expect(() => retention({ ...entry.retention, legal_hold: 'true' })).toThrow();
  });
  it('validates numeric order 2 then 10 and rejects reversed/non-progress/outside-prefix pages', () => {
    const epoch = randomUUID(), entries = [historyEntry(ctx.tenantId, '2'), historyEntry(ctx.tenantId, '10')];
    const page = { epoch, through: '10', scannedThrough: '10', entries }; expect(validatePage(ctx, epoch, '0', '10', 100, page)).toEqual(page);
    expect(() => validatePage(ctx, epoch, '0', '10', 100, { ...page, entries: [...entries].reverse() })).toThrow();
    expect(() => validatePage(ctx, epoch, '0', '10', 100, { ...page, scannedThrough: '0', entries: [] })).toThrow();
    expect(() => validatePage(ctx, epoch, '0', '10', 100, { ...page, scannedThrough: '11' })).toThrow();
  });
});
