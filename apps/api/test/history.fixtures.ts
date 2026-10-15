/* SPDX-License-Identifier: MIT */
// Explicit source/identity/persistence doubles; real hot/cold DB permissions need separate acceptance.
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { fingerprint } from '../src/platform/evidence/file-safety';
import { EvidenceContext, fail } from '../src/platform/evidence/evidence.types';
import { ColdHistoryRecord, ColdHistoryStore, CommittedHistoryPage, HistoryCheckpoint, HistoryEntry } from '../src/platform/history/history.types';
import { HistoryProjector } from '../src/platform/history/history-projector';
export function historyEntry(tenant: string, seq = '1', caseId: string = randomUUID()): HistoryEntry {
  const ref = { pack_id: 'openresolve', type: 'case', id: caseId }, payload = { id: caseId, state: 'RESOLVED', invoice_total: '550000.0000', source_version: seq };
  return { sequence: seq, event: { id: randomUUID(), type: 'openresolve.case.history.v1', tenant_id: tenant, occurred_at: '2026-01-02T00:00:00Z', correlation_id: randomUUID(),
    subject_ref: ref, schema_id: 'openresolve.case-history.v1', payload_ref: { pack_id: 'openresolve', type: 'case-snapshot', id: randomUUID() } },
  snapshot: { ref, version: seq, sha256: fingerprint(payload), payload }, case_metric: { ref, classification: 'COMPLETED', started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:01:00Z' },
  evidence: [{ ref: { pack_id: 'platform', type: 'evidence', id: randomUUID() }, version: 'blob-1', sha256: 'a'.repeat(64) }],
  retention: { retention_class: 'STANDARD', retain_until: '2099-01-01T00:00:00Z', legal_hold: false, policy_version: 'retention-1' }, simulated: true };
}
export class MemoryColdHistoryStore implements ColdHistoryStore {
  rows = new Map<string, { captureSequence: string; record: ColdHistoryRecord }>(); jobs = new Map<string, HistoryCheckpoint>();
  runs: unknown[] = []; nextCapture = 0n; dbName = 'cold_fixture'; failAfterWrite = false; onBeforeCommit?: () => void;
  private tail = Promise.resolve();
  async databaseName() { return this.dbName; }
  private key(ctx: EvidenceContext, stream: string, id: string) { return [ctx.tenantId, stream, id].join(':'); }
  async checkpoint(ctx: EvidenceContext, stream: string, jobId: string) { return structuredClone(this.jobs.get(this.key(ctx, stream, jobId))); }
  async apply(ctx: EvidenceContext, checkpoint: HistoryCheckpoint, expectedAfter: string, page: CommittedHistoryPage, guard: (client: PoolClient) => Promise<void>) {
    const previous = this.tail; let release: () => void; this.tail = new Promise<void>(resolve => { release = resolve; }); await previous;
    const backup = structuredClone({ rows: this.rows, jobs: this.jobs, runs: this.runs });
    try {
      const current = this.jobs.get(this.key(ctx, checkpoint.stream, checkpoint.jobId)); if ((current?.after || '0') !== expectedAfter) fail('REVISION_CONFLICT', 409);
      if (current && (current.epoch !== checkpoint.epoch || current.mode === 'BACKFILL' && current.through !== checkpoint.through)) fail('REVISION_CONFLICT', 409);
      await guard({} as PoolClient); let inserted = 0, replayed = 0;
      for (const entry of page.entries) {
        const key = this.key(ctx, checkpoint.stream, entry.event.id), old = this.rows.get(key), hash = fingerprint(entry);
        if (old) { if (old.record.nativeHash !== hash) fail('IDEMPOTENCY_CONFLICT', 409); replayed++; continue; }
        this.rows.set(key, { captureSequence: String(++this.nextCapture), record: { id: randomUUID(), tenantId: ctx.tenantId, stream: checkpoint.stream, epoch: checkpoint.epoch, capturedAt: checkpoint.updatedAt, nativeHash: hash, entry: structuredClone(entry) } }); inserted++;
      }
      const saved: HistoryCheckpoint = { ...checkpoint, after: page.scannedThrough, state: page.scannedThrough === page.through ? 'SUCCEEDED' : 'RUNNING' };
      this.jobs.set(this.key(ctx, checkpoint.stream, checkpoint.jobId), structuredClone(saved)); this.runs.push({ inserted, replayed, saved });
      if (this.onBeforeCommit) this.onBeforeCommit(); await guard({} as PoolClient);
      if (this.failAfterWrite) throw new Error('Fixture exception before cold commit'); return { checkpoint: saved, inserted, replayed };
    } catch (error) { Object.assign(this, backup); throw error; } finally { release(); }
  }
  async watermark(ctx: EvidenceContext, stream: string) { return this.list(ctx, stream).at(-1)?.captureSequence || '0'; }
  private list(ctx: EvidenceContext, stream: string) { return [...this.rows.values()].filter(row => row.record.tenantId === ctx.tenantId && row.record.stream === stream).sort((a, b) => BigInt(a.captureSequence) < BigInt(b.captureSequence) ? -1 : 1); }
  async events(ctx: EvidenceContext, stream: string, through: string, after: string, limit: number) { return structuredClone(this.list(ctx, stream).filter(row => BigInt(row.captureSequence) > BigInt(after) && BigInt(row.captureSequence) <= BigInt(through)).slice(0, limit)); }
  async latestCases(ctx: EvidenceContext, stream: string, through: string, afterCase: string, limit: number) {
    const latest = new Map<string, ColdHistoryRecord>();
    for (const row of this.list(ctx, stream).filter(row => BigInt(row.captureSequence) <= BigInt(through))) {
      const ref = row.record.entry.case_metric.ref, key = [ref.pack_id, ref.type, ref.id].join('/'), old = latest.get(key);
      if (!old || BigInt(row.record.entry.sequence) > BigInt(old.entry.sequence)) latest.set(key, row.record);
    }
    return structuredClone([...latest].sort(([a], [b]) => a.localeCompare(b)).filter(([key]) => !afterCase || key > afterCase).slice(0, limit).map(([caseKey, record]) => ({ caseKey, record })));
  }
}
export function historyFixture() {
  const ctx = { tenantId: randomUUID(), subject: 'fixture-archive-worker' }, epoch = { value: randomUUID() }, entries: HistoryEntry[] = [historyEntry(ctx.tenantId)];
  const store = new MemoryColdHistoryStore(), state = { active: true }, access = { check: jest.fn(async (context, action: string, stream: string) => {
    if (context.tenantId !== ctx.tenantId || !state.active || stream !== 'case.history' || !['history.project', 'history.read', 'history.report'].includes(action)) fail('FORBIDDEN', 403);
  }), inspect: jest.fn(async (_ctx, _stream, entry) => ({ allowed: true, currentRetention: entry.retention, allowExpired: false })) };
  const source = { databaseName: async () => 'hot_fixture', watermark: jest.fn(async () => ({ epoch: epoch.value, through: entries.reduce((max, entry) => BigInt(entry.sequence) > BigInt(max) ? entry.sequence : max, '0') })),
    withCommittedPage: jest.fn(async (context, stream, requestedEpoch, after, through, limit, use) => {
      await access.check(context, 'history.project', stream); if (requestedEpoch !== epoch.value) fail('REVISION_CONFLICT', 409);
      const pending = entries.filter(e => BigInt(e.sequence) > BigInt(after) && BigInt(e.sequence) <= BigInt(through)).sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1);
      const selected = pending.slice(0, limit), scannedThrough = pending.length > limit ? selected.at(-1).sequence : through;
      return use({ epoch: requestedEpoch, through, scannedThrough, entries: structuredClone(selected) });
    }) };
  const createProjector = () => new HistoryProjector(store, source, access);
  return { ctx, epoch, entries, store, state, access, source, createProjector, projector: createProjector() };
}
