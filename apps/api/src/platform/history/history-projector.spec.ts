/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { fingerprint } from '../evidence/file-safety';
import { historyEntry, historyFixture } from '../../../test/history.fixtures';
describe('cold projector (source/identity/SQL doubles; no production adapter claim)', () => {
  let f: ReturnType<typeof historyFixture>; beforeEach(() => { f = historyFixture(); });
  it('durably deduplicates live replay and independent backfill while preserving the original source snapshot/hash', async () => {
    const first = await f.projector.processPage(f.ctx, 'case.history'); expect(first.inserted).toBe(1); expect(first.checkpoint.after).toBe('1');
    expect((await f.createProjector().processPage(f.ctx, 'case.history')).inserted).toBe(0);
    const job = randomUUID(), backfill = await f.projector.processPage(f.ctx, 'case.history', job); expect(backfill.inserted).toBe(0); expect(backfill.replayed).toBe(1);
    expect((await f.projector.processPage(f.ctx, 'case.history', job)).replayed).toBe(0); expect(f.store.rows.size).toBe(1);
    expect([...f.store.rows.values()][0].record.nativeHash).toBe(fingerprint(f.entries[0]));
  });
  it('freezes a backfill watermark while new live events arrive', async () => {
    f.entries.push(historyEntry(f.ctx.tenantId, '2')); const job = randomUUID();
    const first = await f.projector.processPage(f.ctx, 'case.history', job, 1); expect(first.checkpoint.after).toBe('1'); expect(first.checkpoint.through).toBe('2');
    f.entries.push(historyEntry(f.ctx.tenantId, '3'));
    const second = await f.createProjector().processPage(f.ctx, 'case.history', job, 1); expect(second.checkpoint.after).toBe('2'); expect(second.checkpoint.state).toBe('SUCCEEDED');
    expect(f.store.rows.size).toBe(2); await f.projector.processPage(f.ctx, 'case.history'); expect(f.store.rows.size).toBe(3);
  });
  it('refuses changed same-ID source payloads instead of replacing cold history', async () => {
    await f.projector.processPage(f.ctx, 'case.history'); const original = [...f.store.rows.values()][0].record;
    f.entries[0].snapshot.payload.invoice_total = '1'; f.entries[0].snapshot.sha256 = fingerprint(f.entries[0].snapshot.payload);
    await expect(f.projector.processPage(f.ctx, 'case.history', randomUUID())).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect([...f.store.rows.values()][0].record).toEqual(original);
  });
  it('rolls back rows and cursor together, then safely retries after service recreation', async () => {
    f.store.failAfterWrite = true; await expect(f.projector.processPage(f.ctx, 'case.history')).rejects.toThrow('Fixture exception');
    expect(f.store.rows.size).toBe(0); expect(f.store.jobs.size).toBe(0); f.store.failAfterWrite = false;
    expect((await f.createProjector().processPage(f.ctx, 'case.history')).inserted).toBe(1);
  });
  it('rejects accidentally shared hot/cold databases before reading source pages', async () => {
    f.store.dbName = 'hot_fixture'; await expect(f.projector.processPage(f.ctx, 'case.history')).rejects.toMatchObject({ code: 'INVALID_STATE' }); expect(f.source.withCommittedPage).not.toHaveBeenCalled();
  });
  it('current worker revocation at the final boundary prevents cold rows and cursor from committing', async () => {
    f.store.onBeforeCommit = () => { f.state.active = false; };
    await expect(f.projector.processPage(f.ctx, 'case.history')).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(f.store.rows.size).toBe(0); expect(f.store.jobs.size).toBe(0);
  });
  it('rejects a reset source epoch rather than silently rewinding checkpoints', async () => {
    await f.projector.processPage(f.ctx, 'case.history'); f.epoch.value = randomUUID();
    await expect(f.projector.processPage(f.ctx, 'case.history')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' }); expect(f.store.rows.size).toBe(1);
  });
  it('concurrent workers serialize or fail the stale cursor without duplicate rows', async () => {
    const outcomes = await Promise.allSettled([f.projector.processPage(f.ctx, 'case.history'), f.createProjector().processPage(f.ctx, 'case.history')]);
    expect(outcomes.some(outcome => outcome.status === 'fulfilled')).toBe(true); expect(f.store.rows.size).toBe(1); expect(f.store.jobs.size).toBe(1);
    for (const result of outcomes) if (result.status === 'rejected') expect(result.reason.code).toBe('REVISION_CONFLICT');
  });
});
