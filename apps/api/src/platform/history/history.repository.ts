/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { EvidenceContext, fail } from '../evidence/evidence.types';
import { contextValid, fingerprint } from '../evidence/file-safety';
import { ColdHistoryRecord, ColdHistoryStore, CommittedHistoryPage, HistoryCheckpoint } from './history.types';
import { sequence, streamName, utc, validatePage } from './history-validation';
export class PostgresColdHistoryStore implements ColdHistoryStore {
  // Writer and reader MUST be separately composed pools. Production reader is SELECT-only;
  // neither pool may point at the source database. The projector verifies actual DB names.
  constructor(private readonly writer: Pick<DatabaseService, 'query' | 'transaction'>, private readonly reader: Pick<DatabaseService, 'query'>) {}
  async databaseName() { return (await this.writer.query('SELECT current_database() AS name')).rows[0].name as string; }
  async checkpoint(ctx: EvidenceContext, stream: string, jobId: string): Promise<HistoryCheckpoint | undefined> {
    contextValid(ctx); streamName(stream);
    return (await this.writer.query('SELECT data FROM platform_history_projection_jobs WHERE tenant_id=$1 AND stream=$2 AND job_id=$3', [ctx.tenantId, stream, jobId])).rows[0]?.data;
  }
  async apply(ctx: EvidenceContext, checkpoint: HistoryCheckpoint, expectedAfter: string, page: CommittedHistoryPage, guard: (client: PoolClient) => Promise<void>) {
    contextValid(ctx); streamName(checkpoint.stream); sequence(expectedAfter);
    if (checkpoint.tenantId !== ctx.tenantId || !utc(checkpoint.updatedAt)) fail('INVALID_STATE', 409);
    validatePage(ctx, checkpoint.epoch, expectedAfter, checkpoint.through, 100, page);
    return this.writer.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL statement_timeout='15s'"); await client.query("SET LOCAL lock_timeout='5s'");
      // All live/backfill jobs share this stream lock, preserving allocation/commit
      // order of cold capture_sequence. Source sequence alone cannot freeze late backfills.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [fingerprint(['cold-history', ctx.tenantId, checkpoint.stream])]);
      const current: HistoryCheckpoint = (await client.query('SELECT data FROM platform_history_projection_jobs WHERE tenant_id=$1 AND stream=$2 AND job_id=$3 FOR UPDATE', [ctx.tenantId, checkpoint.stream, checkpoint.jobId])).rows[0]?.data;
      if ((current?.after || '0') !== expectedAfter || current && (current.epoch !== checkpoint.epoch || current.mode !== checkpoint.mode ||
        current.mode === 'BACKFILL' && current.through !== checkpoint.through)) fail('REVISION_CONFLICT', 409);
      await guard(client); let inserted = 0, replayed = 0;
      for (const entry of page.entries) {
        const nativeHash = fingerprint(entry), id = randomUUID(), record: ColdHistoryRecord = { id, tenantId: ctx.tenantId, stream: checkpoint.stream,
          epoch: checkpoint.epoch, capturedAt: checkpoint.updatedAt, nativeHash, entry };
        const ref = entry.case_metric.ref, caseKey = [ref.pack_id, ref.type, ref.id].join('/');
        const result = await client.query(`INSERT INTO platform_history_snapshots(tenant_id,stream,id,epoch,source_sequence,event_id,captured_at,native_hash,case_key,data)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
        [ctx.tenantId, checkpoint.stream, id, checkpoint.epoch, entry.sequence, entry.event.id, checkpoint.updatedAt, nativeHash, caseKey, JSON.stringify(record)]);
        if (!result.rows.length) {
          const existing = (await client.query('SELECT native_hash,epoch FROM platform_history_snapshots WHERE tenant_id=$1 AND stream=$2 AND event_id=$3', [ctx.tenantId, checkpoint.stream, entry.event.id])).rows[0];
          if (!existing || existing.native_hash !== nativeHash || existing.epoch !== checkpoint.epoch) fail('IDEMPOTENCY_CONFLICT', 409); replayed++; continue;
        }
        inserted++;
        const from = { ref: { pack_id: 'platform', type: 'history-snapshot', id }, version: 'cold-1', sha256: nativeHash };
        const targets = [{ ref: entry.snapshot.ref, version: entry.snapshot.version, sha256: entry.snapshot.sha256 }, ...entry.evidence];
        for (let ordinal = 0; ordinal < targets.length; ordinal++) await client.query('INSERT INTO platform_history_lineage VALUES($1,$2,$3,$4::jsonb)',
          [ctx.tenantId, id, ordinal, JSON.stringify({ from, to: targets[ordinal], relation: 'DERIVED_FROM', created_at: checkpoint.updatedAt })]);
      }
      const saved: HistoryCheckpoint = { ...checkpoint, after: page.scannedThrough, state: page.scannedThrough === page.through ? 'SUCCEEDED' : 'RUNNING' };
      await client.query(`INSERT INTO platform_history_projection_jobs VALUES($1,$2,$3,$4::jsonb)
        ON CONFLICT(tenant_id,stream,job_id) DO UPDATE SET data=EXCLUDED.data`, [ctx.tenantId, checkpoint.stream, checkpoint.jobId, JSON.stringify(saved)]);
      await client.query(`INSERT INTO platform_history_projection_runs(tenant_id,stream,job_id,previous_cursor,scanned_through,source_through,inserted,replayed,captured_at,epoch)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [ctx.tenantId, checkpoint.stream, checkpoint.jobId, expectedAfter, page.scannedThrough, page.through, inserted, replayed, checkpoint.updatedAt, checkpoint.epoch]);
      await guard(client); return { checkpoint: saved, inserted, replayed };
    });
  }
  async watermark(ctx: EvidenceContext, stream: string) {
    contextValid(ctx); streamName(stream);
    return (await this.reader.query('SELECT COALESCE(MAX(capture_sequence),0)::text AS value FROM platform_history_snapshots WHERE tenant_id=$1 AND stream=$2', [ctx.tenantId, stream])).rows[0].value as string;
  }
  async latestCases(ctx: EvidenceContext, stream: string, through: string, afterCase: string | undefined, limit: number) {
    contextValid(ctx); streamName(stream); sequence(through);
    return (await this.reader.query(`SELECT case_key,data FROM (SELECT DISTINCT ON(case_key) case_key,data,source_sequence
      FROM platform_history_snapshots WHERE tenant_id=$1 AND stream=$2 AND capture_sequence<=$3::bigint
      ORDER BY case_key,source_sequence DESC) latest WHERE ($4::text IS NULL OR case_key>$4) ORDER BY case_key LIMIT $5`, [ctx.tenantId, stream, through, afterCase || null, limit]))
      .rows.map(row => ({ caseKey: row.case_key as string, record: row.data as ColdHistoryRecord }));
  }
  async events(ctx: EvidenceContext, stream: string, through: string, after: string, limit: number) {
    contextValid(ctx); streamName(stream); sequence(through); sequence(after);
    return (await this.reader.query('SELECT capture_sequence::text AS captured_sequence,data FROM platform_history_snapshots WHERE tenant_id=$1 AND stream=$2 AND capture_sequence>$3::bigint AND capture_sequence<=$4::bigint ORDER BY platform_history_snapshots.capture_sequence LIMIT $5',
      [ctx.tenantId, stream, after, through, limit])).rows.map(row => ({ captureSequence: row.captured_sequence as string, record: row.data as ColdHistoryRecord }));
  }
}
