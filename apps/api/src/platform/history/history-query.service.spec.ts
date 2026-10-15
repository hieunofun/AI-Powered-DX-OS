/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { historyEntry, historyFixture } from '../../../test/history.fixtures';
import { HistoryQueryService } from './history-query.service';
describe('cold history reads (SQL/current resource/retention authority doubles)', () => {
  let f: ReturnType<typeof historyFixture>, service: HistoryQueryService, time: number;
  beforeEach(async () => {
    f = historyFixture(); time = Date.now(); f.entries.push(historyEntry(f.ctx.tenantId, '2'));
    await f.projector.processPage(f.ctx, 'case.history'); service = new HistoryQueryService(f.store, f.access, 'history-private-test-cursor-key-at-least32bytes', () => time);
  });
  it('reports only visible latest cases with exact duration totals and honest simulated scope', async () => {
    const result = await service.cases(f.ctx, 'case.history');
    expect(result.metrics).toMatchObject({ scope: 'AUTHORIZED_VISIBLE_PAGE', case_count: 2, completed_duration_count: 2, total_duration_ms: '120000', p95_duration_ms: 60000, data_origin: 'SIMULATED' });
    expect(result.items[0].lineage).toHaveLength(2); expect(result.complete).toBe(true);
    expect(JSON.stringify(result)).not.toContain('captureSequence'); expect(JSON.stringify(result)).not.toContain('scannedThrough');
  });
  it('freezes cold insertion watermark across event pages while the source advances', async () => {
    const first = await service.events(f.ctx, 'case.history', { limit: '1' }); expect(first.items).toHaveLength(1);
    f.entries.push(historyEntry(f.ctx.tenantId, '3')); await f.projector.processPage(f.ctx, 'case.history');
    const second = await service.events(f.ctx, 'case.history', { limit: '1', cursor: first.next_cursor }); expect(second.items).toHaveLength(1); expect(second.complete).toBe(true);
    expect((await service.events(f.ctx, 'case.history')).items).toHaveLength(3); expect(second.items[0].snapshot.version).toBe('2');
  });
  it('chooses latest numeric source versions per case without counting repeated events as new cases', async () => {
    const caseId = f.entries[0].case_metric.ref.id; f.entries.push(historyEntry(f.ctx.tenantId, '10', caseId)); await f.projector.processPage(f.ctx, 'case.history');
    const result = await service.cases(f.ctx, 'case.history'); expect(result.metrics.case_count).toBe(2);
    expect(result.items.find(row => row.case_metric.ref.id === caseId).snapshot.version).toBe('10');
  });
  it('omits currently denied resources from both data and aggregate counts', async () => {
    const hidden = f.entries[1].snapshot.ref.id;
    f.access.inspect.mockImplementation(async (_ctx, _stream, entry) => ({ allowed: entry.snapshot.ref.id !== hidden, currentRetention: entry.retention, allowExpired: false }));
    const result = await service.cases(f.ctx, 'case.history'); expect(result.metrics.case_count).toBe(1); expect(result.metrics.total_duration_ms).toBe('60000'); expect(JSON.stringify(result)).not.toContain(hidden);
  });
  it('a legal hold preserves expired data without granting normal read; an explicit expired-history grant permits it', async () => {
    let expiredPermission = false;
    f.access.inspect.mockImplementation(async (_ctx, _stream, entry) => ({ allowed: true, currentRetention: { ...entry.retention, retain_until: '2020-01-01T00:00:00Z', legal_hold: true }, allowExpired: expiredPermission }));
    expect((await service.cases(f.ctx, 'case.history')).metrics.case_count).toBe(0); expect(f.store.rows.size).toBe(2);
    expiredPermission = true; expect((await service.cases(f.ctx, 'case.history')).metrics.case_count).toBe(2); expect(f.store.rows.size).toBe(2);
  });
  it('uses current restricted-policy decisions rather than the original STANDARD snapshot as a grant', async () => {
    f.access.inspect.mockImplementation(async (_ctx, _stream, entry) => ({ allowed: false, currentRetention: { ...entry.retention, retention_class: 'RESTRICTED' }, allowExpired: false }));
    const result = await service.cases(f.ctx, 'case.history'); expect(result.items).toEqual([]); expect(result.metrics.case_count).toBe(0); expect(result.metrics.data_origin).toBe('EMPTY');
  });
  it('does not return partial aggregates when current authority is unavailable or membership is revoked during a read', async () => {
    f.access.inspect.mockRejectedValueOnce(new Error('Authority unavailable')); await expect(service.cases(f.ctx, 'case.history')).rejects.toThrow('Authority unavailable');
    f.access.inspect.mockImplementation(async (_ctx, _stream, entry) => { f.state.active = false; return { allowed: true, currentRetention: entry.retention, allowExpired: false }; });
    await expect(service.cases(f.ctx, 'case.history')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('binds opaque cursors to active tenant, principal, mode, limit and expiry', async () => {
    const first = await service.events(f.ctx, 'case.history', { limit: '1' }), cursor = first.next_cursor;
    expect(cursor).not.toContain(f.ctx.tenantId); expect(cursor).not.toContain(f.entries[0].snapshot.ref.id);
    await expect(service.events({ ...f.ctx, subject: 'another-authorized-reader' }, 'case.history', { limit: '1', cursor })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(service.cases(f.ctx, 'case.history', { limit: '1', cursor })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(service.events(f.ctx, 'case.history', { limit: '2', cursor })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    f.access.check.mockResolvedValue(undefined); await expect(service.events({ ...f.ctx, tenantId: randomUUID() }, 'case.history', { limit: '1', cursor })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    time += 900001; await expect(service.events(f.ctx, 'case.history', { limit: '1', cursor })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
  it('rejects cursor ciphertext tampering and unknown/filter authority parameters', async () => {
    const first = await service.events(f.ctx, 'case.history', { limit: '1' }), cursor = first.next_cursor;
    const altered = cursor.slice(0, 20) + (cursor[20] === 'A' ? 'B' : 'A') + cursor.slice(21);
    await expect(service.events(f.ctx, 'case.history', { limit: '1', cursor: altered })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    for (const query of [{ tenant_id: randomUUID() }, { limit: '101' }, { limit: '01' }, { limit: ['1'] }, { include_restricted: 'true' }]) await expect(service.cases(f.ctx, 'case.history', query)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
  it('detects corruption of persisted snapshots instead of reporting altered values', async () => {
    [...f.store.rows.values()][0].record.entry.snapshot.payload.invoice_total = '1';
    await expect(service.events(f.ctx, 'case.history')).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
  });
});
