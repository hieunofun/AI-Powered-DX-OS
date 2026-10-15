/* SPDX-License-Identifier: MIT */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { EvidenceContext, fail } from '../evidence/evidence.types';
import { contextValid, fingerprint, UUID } from '../evidence/file-safety';
import { ColdHistoryRecord, ColdHistoryStore, HistoryAccess } from './history.types';
import { retention, sequence, streamName, utc, validateEntry } from './history-validation';
interface Cursor {
  v: 1; tenant: string; subject: string; stream: string; mode: 'CASES' | 'EVENTS'; limit: number;
  after: string; through: string; createdAt: string; expiresAt: number;
}
export class HistoryQueryService {
  private readonly key: Buffer;
  constructor(private readonly cold: Pick<ColdHistoryStore, 'watermark' | 'latestCases' | 'events'>, private readonly access: HistoryAccess,
    secret: string, private readonly now: () => number = Date.now) {
    if (Buffer.byteLength(secret || '') < 32 || !access?.inspect || !access?.check) throw new Error('Private cursor key and current historical resource/retention authority are required.');
    this.key = createHash('sha256').update(secret).digest();
  }
  private encode(cursor: Cursor) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    return Buffer.concat([iv, cipher.update(JSON.stringify(cursor)), cipher.final(), cipher.getAuthTag()]).toString('base64url');
  }
  private decode(raw: unknown): Cursor {
    try {
      if (typeof raw !== 'string' || raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error('Invalid cursor');
      const bytes = Buffer.from(raw, 'base64url'); if (bytes.length < 29) throw new Error('Invalid cursor');
      const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16));
      return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8'));
    } catch { fail('INVALID_REQUEST'); }
  }
  private async cursor(ctx: EvidenceContext, stream: string, mode: Cursor['mode'], query: Record<string, unknown>): Promise<Cursor> {
    contextValid(ctx); streamName(stream);
    if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => !['limit', 'cursor'].includes(key)) ||
      query.limit !== undefined && (typeof query.limit !== 'string' || !/^[1-9][0-9]{0,2}$/.test(query.limit))) fail('INVALID_REQUEST');
    const limit = query.limit === undefined ? 25 : Number(query.limit); if (limit > 100) fail('INVALID_REQUEST');
    await this.access.check(ctx, mode === 'CASES' ? 'history.report' : 'history.read', stream);
    if (query.cursor !== undefined) {
      const cursor = this.decode(query.cursor);
      if (!cursor || cursor.v !== 1 || cursor.tenant !== ctx.tenantId || cursor.subject !== ctx.subject || cursor.stream !== stream || cursor.mode !== mode ||
        cursor.limit !== limit || !Number.isFinite(cursor.expiresAt) || cursor.expiresAt <= this.now() || cursor.expiresAt > this.now() + 900000 || !utc(cursor.createdAt) ||
        typeof cursor.after !== 'string' || cursor.after.length > 220) fail('INVALID_REQUEST');
      sequence(cursor.through); if (mode === 'EVENTS') sequence(cursor.after);
      else if (!/^[a-z][a-z0-9-]{0,79}\/[a-z][a-z0-9-]{0,79}\/[a-f0-9-]{36}$/i.test(cursor.after)) fail('INVALID_REQUEST');
      return cursor;
    }
    const through = sequence(await this.cold.watermark(ctx, stream));
    return { v: 1, tenant: ctx.tenantId, subject: ctx.subject, stream, mode, limit, after: mode === 'EVENTS' ? '0' : '', through,
      createdAt: new Date(this.now()).toISOString(), expiresAt: this.now() + 900000 };
  }
  private async visible(ctx: EvidenceContext, stream: string, row: ColdHistoryRecord) {
    if (!row || row.tenantId !== ctx.tenantId || row.stream !== stream || !UUID.test(row.id || '') || !utc(row.capturedAt)) fail('INVALID_STATE', 409);
    validateEntry(ctx, row.entry); if (row.nativeHash !== fingerprint(row.entry)) fail('CHECKSUM_MISMATCH', 422);
    const result = await this.access.inspect(ctx, stream, row.entry);
    if (!result || typeof result.allowed !== 'boolean' || typeof result.allowExpired !== 'boolean') fail('DEPENDENCY_UNAVAILABLE', 503);
    const current = retention(result.currentRetention);
    return result.allowed && (Date.parse(current.retain_until) > this.now() || result.allowExpired);
  }
  private view(row: ColdHistoryRecord) {
    const from = { ref: { pack_id: 'platform', type: 'history-snapshot', id: row.id }, version: 'cold-1', sha256: row.nativeHash };
    const targets = [{ ref: row.entry.snapshot.ref, version: row.entry.snapshot.version, sha256: row.entry.snapshot.sha256 }, ...row.entry.evidence];
    return { id: row.id, tenant_id: row.tenantId, stream: row.stream, captured_at: row.capturedAt, native_sha256: row.nativeHash,
      event: row.entry.event, snapshot: row.entry.snapshot, case_metric: row.entry.case_metric, evidence: row.entry.evidence,
      captured_retention: row.entry.retention, simulated: row.entry.simulated, lineage: targets.map(to => ({ from, to, relation: 'DERIVED_FROM' })) };
  }
  async events(ctx: EvidenceContext, stream: string, query: Record<string, unknown> = {}) {
    const cursor = await this.cursor(ctx, stream, 'EVENTS', query), rows = await this.cold.events(ctx, stream, cursor.through, cursor.after, cursor.limit + 1);
    const scanned = rows.slice(0, cursor.limit), selected: ColdHistoryRecord[] = [];
    for (const row of scanned) if (await this.visible(ctx, stream, row.record)) selected.push(row.record);
    const current: ColdHistoryRecord[] = []; for (const row of selected) if (await this.visible(ctx, stream, row)) current.push(row);
    await this.access.check(ctx, 'history.read', stream);
    return { items: current.map(row => this.view(row)), query_created_at: cursor.createdAt, complete: rows.length <= cursor.limit,
      ...(rows.length > cursor.limit ? { next_cursor: this.encode({ ...cursor, after: scanned[scanned.length - 1].captureSequence }) } : {}) };
  }
  async cases(ctx: EvidenceContext, stream: string, query: Record<string, unknown> = {}) {
    const cursor = await this.cursor(ctx, stream, 'CASES', query), rows = await this.cold.latestCases(ctx, stream, cursor.through, cursor.after || undefined, cursor.limit + 1);
    const scanned = rows.slice(0, cursor.limit), selected: ColdHistoryRecord[] = [];
    for (const row of scanned) if (await this.visible(ctx, stream, row.record)) selected.push(row.record);
    const current: ColdHistoryRecord[] = []; for (const row of selected) if (await this.visible(ctx, stream, row)) current.push(row);
    const counts = { ACTIVE: 0, COMPLETED: 0, ERROR: 0 }, errors = new Map<string, number>(), durations: number[] = []; let total = 0n;
    for (const row of current) {
      const metric = row.entry.case_metric; counts[metric.classification]++;
      if (metric.finished_at) { const duration = Date.parse(metric.finished_at) - Date.parse(metric.started_at); durations.push(duration); total += BigInt(duration); }
      if (metric.error_code) errors.set(metric.error_code, (errors.get(metric.error_code) || 0) + 1);
    }
    durations.sort((a, b) => a - b); const simulated = current.filter(row => row.entry.simulated).length;
    await this.access.check(ctx, 'history.report', stream);
    return { items: current.map(row => this.view(row)), query_created_at: cursor.createdAt, complete: rows.length <= cursor.limit,
      metrics: { scope: 'AUTHORIZED_VISIBLE_PAGE', case_count: current.length, classification_counts: counts,
        completed_duration_count: durations.length, total_duration_ms: String(total), p95_duration_ms: durations.length ? durations[Math.ceil(durations.length * 0.95) - 1] : null,
        errors: [...errors].sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => ({ code, count })),
        data_origin: !current.length ? 'EMPTY' : simulated === current.length ? 'SIMULATED' : simulated ? 'MIXED' : 'ACTUAL' },
      ...(rows.length > cursor.limit ? { next_cursor: this.encode({ ...cursor, after: scanned[scanned.length - 1].caseKey }) } : {}) };
  }
}
