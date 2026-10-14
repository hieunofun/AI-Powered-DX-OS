/* SPDX-License-Identifier: MIT */
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { EvidenceContext, EvidenceRecord, fail } from './evidence.types';
export interface CommandIdentity { scope: string; hash: string; }
export interface EvidenceStore {
  commandHash(context: EvidenceContext, scope: string): Promise<string | undefined>;
  read(context: EvidenceContext, id: string): Promise<EvidenceRecord | undefined>;
  operation(context: EvidenceContext, operationId: string): Promise<EvidenceRecord | undefined>;
  page(context: EvidenceContext, limit: number, before?: { at: string; id: string }): Promise<EvidenceRecord[]>;
  candidate(context: EvidenceContext, now: string): Promise<string | undefined>;
  change<T>(context: EvidenceContext, id: string, command: CommandIdentity | undefined,
    work: (record: EvidenceRecord | undefined, replay: boolean) => { record: EvidenceRecord; result: T }): Promise<T>;
}
export class PostgresEvidenceStore implements EvidenceStore {
  constructor(private readonly db: Pick<DatabaseService, 'query' | 'transaction'>) {}
  async commandHash(context: EvidenceContext, scope: string): Promise<string | undefined> {
    const result = await this.db.query('SELECT request_hash FROM platform_evidence_commands WHERE tenant_id=$1 AND scope_hash=$2', [context.tenantId, scope]);
    return result.rows[0]?.request_hash;
  }
  async read(context: EvidenceContext, id: string): Promise<EvidenceRecord | undefined> {
    const result = await this.db.query('SELECT data FROM platform_evidence_records WHERE tenant_id=$1 AND id=$2', [context.tenantId, id]);
    return result.rows[0]?.data;
  }
  async operation(context: EvidenceContext, operationId: string): Promise<EvidenceRecord | undefined> {
    const result = await this.db.query("SELECT data FROM platform_evidence_records WHERE tenant_id=$1 AND data->'operation'->>'id'=$2", [context.tenantId, operationId]);
    return result.rows[0]?.data;
  }
  async page(context: EvidenceContext, limit: number, before?: { at: string; id: string }): Promise<EvidenceRecord[]> {
    const result = await this.db.query(`SELECT data FROM platform_evidence_records WHERE tenant_id=$1
      ${before ? 'AND (created_at,id)<($3::timestamptz,$4::uuid)' : ''} ORDER BY created_at DESC,id DESC LIMIT $2`,
    before ? [context.tenantId, limit, before.at, before.id] : [context.tenantId, limit]);
    return result.rows.map(row => row.data);
  }
  async candidate(context: EvidenceContext, now: string): Promise<string | undefined> {
    const result = await this.db.query(`SELECT id FROM platform_evidence_records WHERE tenant_id=$1
      AND data->>'accepted'='true' AND data->'evidence'->>'quarantine_state' IN ('PENDING_SCAN','SCAN_FAILED')
      AND data->'operation'->>'state' IN ('PENDING','RUNNING')
      AND (data->'lease'->>'until' IS NULL OR (data->'lease'->>'until')::timestamptz<=$2)
      AND (data->>'nextAttemptAt' IS NULL OR (data->>'nextAttemptAt')::timestamptz<=$2)
      ORDER BY created_at,id LIMIT 1`, [context.tenantId, now]);
    return result.rows[0]?.id;
  }
  async change<T>(context: EvidenceContext, requestedId: string, command: CommandIdentity | undefined,
    work: (record: EvidenceRecord | undefined, replay: boolean) => { record: EvidenceRecord; result: T }): Promise<T> {
    return this.db.transaction(async (client: PoolClient) => {
      let id = requestedId, replay = false;
      if (command) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['evidence-command:' + command.scope]);
        const existing = await client.query('SELECT request_hash,evidence_id FROM platform_evidence_commands WHERE tenant_id=$1 AND scope_hash=$2', [context.tenantId, command.scope]);
        if (existing.rows.length) {
          if (existing.rows[0].request_hash !== command.hash) fail('IDEMPOTENCY_CONFLICT', 409);
          id = existing.rows[0].evidence_id; replay = true;
        }
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['evidence-record:' + context.tenantId + ':' + id]);
      const existing = await client.query('SELECT data FROM platform_evidence_records WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [context.tenantId, id]);
      const value = work(existing.rows[0]?.data, replay);
      if (value.record.evidence.tenant_id !== context.tenantId || value.record.evidence.id !== id) throw new Error('Evidence transaction scope mismatch.');
      await client.query(`INSERT INTO platform_evidence_records(tenant_id,id,created_at,updated_at,data) VALUES($1,$2,$3,$4,$5::jsonb)
        ON CONFLICT(tenant_id,id) DO UPDATE SET updated_at=EXCLUDED.updated_at,data=EXCLUDED.data`,
      [context.tenantId, id, value.record.evidence.created_at, value.record.evidence.updated_at, JSON.stringify(value.record)]);
      if (command && !replay) await client.query('INSERT INTO platform_evidence_commands(tenant_id,scope_hash,request_hash,evidence_id) VALUES($1,$2,$3,$4)',
        [context.tenantId, command.scope, command.hash, id]);
      return value.result;
    });
  }
}
