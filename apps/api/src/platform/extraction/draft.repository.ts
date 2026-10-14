/* SPDX-License-Identifier: MIT */
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { CommandIdentity } from '../evidence/evidence.repository';
import { EvidenceContext, EvidenceRecord, fail } from '../evidence/evidence.types';
import { DraftRecord } from './draft.types';
import type { DraftLineageSink } from '../lineage/lineage.types';
export interface DraftStore {
  read(context: EvidenceContext, id: string): Promise<DraftRecord | undefined>;
  operation(context: EvidenceContext, id: string): Promise<DraftRecord | undefined>;
  candidate(context: EvidenceContext, at: string): Promise<string | undefined>;
  change<T>(context: EvidenceContext, id: string, evidenceId: string, command: CommandIdentity | undefined,
    work: (record: DraftRecord | undefined, source: EvidenceRecord, client: PoolClient, replay: boolean, cached?: T) => Promise<{ record: DraftRecord; source?: EvidenceRecord; result: T }>): Promise<T>;
}
export class PostgresDraftStore implements DraftStore {
  constructor(private readonly db: Pick<DatabaseService, 'query' | 'transaction'>, private readonly lineage?: DraftLineageSink) {}
  async read(context: EvidenceContext, id: string) {
    const result = await this.db.query('SELECT data FROM platform_extraction_records WHERE tenant_id=$1 AND id=$2', [context.tenantId, id]);
    return result.rows[0]?.data;
  }
  async operation(context: EvidenceContext, id: string) {
    const result = await this.db.query("SELECT data FROM platform_extraction_records WHERE tenant_id=$1 AND (data->'operation'->>'id'=$2 OR data->'confirmation'->'operation'->>'id'=$2)", [context.tenantId, id]);
    return result.rows[0]?.data;
  }
  async candidate(context: EvidenceContext, at: string) {
    const result = await this.db.query(`SELECT id FROM platform_extraction_records WHERE tenant_id=$1
      AND data->'operation'->>'state' IN ('PENDING','RUNNING') AND data->'draft' IS NULL
      AND (data->'lease'->>'until' IS NULL OR (data->'lease'->>'until')::timestamptz<=$2)
      AND (data->>'nextAttemptAt' IS NULL OR (data->>'nextAttemptAt')::timestamptz<=$2)
      ORDER BY created_at,id LIMIT 1`, [context.tenantId, at]);
    return result.rows[0]?.id;
  }
  async change<T>(context: EvidenceContext, requestedId: string, requestedEvidence: string, command: CommandIdentity | undefined,
    work: (record: DraftRecord | undefined, source: EvidenceRecord, client: PoolClient, replay: boolean, cached?: T) => Promise<{ record: DraftRecord; source?: EvidenceRecord; result: T }>): Promise<T> {
    return this.db.transaction(async client => {
      let id = requestedId, replay = false, cached: T;
      if (command) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['draft-command:' + command.scope]);
        const existing = await client.query('SELECT request_hash,record_id,response FROM platform_extraction_commands WHERE tenant_id=$1 AND scope_hash=$2', [context.tenantId, command.scope]);
        if (existing.rows.length) {
          if (existing.rows[0].request_hash !== command.hash) fail('IDEMPOTENCY_CONFLICT', 409);
          id = existing.rows[0].record_id; replay = true; cached = existing.rows[0].response;
        }
      }
      // Every mutation takes source before draft; evidence service uses the same source lock.
      const snapshot = await client.query('SELECT evidence_id FROM platform_extraction_records WHERE tenant_id=$1 AND id=$2', [context.tenantId, id]);
      const evidenceId = snapshot.rows[0]?.evidence_id || requestedEvidence;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['evidence-record:' + context.tenantId + ':' + evidenceId]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['draft-record:' + context.tenantId + ':' + id]);
      const raw = await client.query('SELECT data FROM platform_evidence_records WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [context.tenantId, evidenceId]);
      if (!raw.rows.length) fail('NOT_FOUND', 404);
      const current = await client.query('SELECT data FROM platform_extraction_records WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [context.tenantId, id]);
      const result = await work(current.rows[0]?.data, raw.rows[0].data, client, replay, cached);
      if (result.record.tenantId !== context.tenantId || result.record.id !== id || result.record.evidenceId !== evidenceId) throw new Error('Draft transaction scope mismatch.');
      await client.query(`INSERT INTO platform_extraction_records(tenant_id,id,evidence_id,created_at,data) VALUES($1,$2,$3,$4,$5::jsonb)
        ON CONFLICT(tenant_id,id) DO UPDATE SET data=EXCLUDED.data`, [context.tenantId, id, evidenceId, result.record.createdAt, JSON.stringify(result.record)]);
      if (result.source) {
        if (result.source.evidence.id !== evidenceId || result.source.evidence.tenant_id !== context.tenantId) throw new Error('Draft source scope mismatch.');
        await client.query('UPDATE platform_evidence_records SET updated_at=$3,data=$4::jsonb WHERE tenant_id=$1 AND id=$2',
          [context.tenantId, evidenceId, result.source.evidence.updated_at, JSON.stringify(result.source)]);
      }
      if (this.lineage && !replay) await this.lineage.capture(client, context, result.record, result.source || raw.rows[0].data);
      if (command && !replay) await client.query('INSERT INTO platform_extraction_commands(tenant_id,scope_hash,request_hash,record_id,response) VALUES($1,$2,$3,$4,$5::jsonb)',
        [context.tenantId, command.scope, command.hash, id, JSON.stringify(result.result)]);
      return result.result;
    });
  }
}
