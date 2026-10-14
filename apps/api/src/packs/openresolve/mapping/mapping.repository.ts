/* SPDX-License-Identifier: MIT */
import { PoolClient } from 'pg';
import { DatabaseService } from '../../../database/database.service';
import { CommandIdentity } from '../../../platform/evidence/evidence.repository';
import { EvidenceContext, fail } from '../../../platform/evidence/evidence.types';
import { fingerprint } from '../../../platform/evidence/file-safety';
import { MappingRecord } from './mapping.types';
export interface MappingStore {
  read(context: EvidenceContext, id: string): Promise<MappingRecord | undefined>;
  operation(context: EvidenceContext, id: string): Promise<MappingRecord | undefined>;
  candidate(context: EvidenceContext, at: string): Promise<string | undefined>;
  change<T>(context: EvidenceContext, id: string, evidenceId: string, command: CommandIdentity | undefined,
    work: (record: MappingRecord | undefined, client: PoolClient, replay: boolean, cached?: T) => Promise<{ record: MappingRecord; result: T }>): Promise<T>;
}
export class PostgresMappingStore implements MappingStore {
  constructor(private readonly db: Pick<DatabaseService, 'query' | 'transaction'>) {}
  async read(context: EvidenceContext, id: string) {
    return (await this.db.query('SELECT data FROM openresolve_mapping_records WHERE tenant_id=$1 AND id=$2', [context.tenantId, id])).rows[0]?.data;
  }
  async operation(context: EvidenceContext, id: string) {
    return (await this.db.query("SELECT data FROM openresolve_mapping_records WHERE tenant_id=$1 AND data->'operation'->>'id'=$2", [context.tenantId, id])).rows[0]?.data;
  }
  async candidate(context: EvidenceContext, at: string) {
    return (await this.db.query(`SELECT id FROM openresolve_mapping_records WHERE tenant_id=$1 AND data->'operation'->>'state' IN ('PENDING','RUNNING')
      AND (data->'lease'->>'until' IS NULL OR (data->'lease'->>'until')::timestamptz<=$2) ORDER BY created_at,id LIMIT 1`, [context.tenantId, at])).rows[0]?.id;
  }
  async change<T>(context: EvidenceContext, requestedId: string, requestedEvidenceId: string, command: CommandIdentity | undefined,
    work: (record: MappingRecord | undefined, client: PoolClient, replay: boolean, cached?: T) => Promise<{ record: MappingRecord; result: T }>): Promise<T> {
    return this.db.transaction(async client => {
      let id = requestedId, replay = false, cached: T;
      if (command) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['mapping-command:' + command.scope]);
        const saved = (await client.query('SELECT record_id,request_hash,response FROM openresolve_mapping_commands WHERE tenant_id=$1 AND scope_hash=$2', [context.tenantId, command.scope])).rows[0];
        if (saved) { if (saved.request_hash !== command.hash) fail('IDEMPOTENCY_CONFLICT', 409); id = saved.record_id; replay = true; cached = saved.response; }
      }
      const existing = (await client.query('SELECT evidence_id FROM openresolve_mapping_records WHERE tenant_id=$1 AND id=$2', [context.tenantId, id])).rows[0];
      const evidenceId = existing?.evidence_id || requestedEvidenceId;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['evidence-record:' + context.tenantId + ':' + evidenceId]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['mapping-record:' + context.tenantId + ':' + id]);
      const source = (await client.query('SELECT data FROM platform_evidence_records WHERE tenant_id=$1 AND id=$2 FOR SHARE', [context.tenantId, evidenceId])).rows[0]?.data;
      if (!source) fail('NOT_FOUND', 404);
      const current = (await client.query('SELECT data FROM openresolve_mapping_records WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [context.tenantId, id])).rows[0]?.data;
      const result = await work(current, client, replay, cached), record = result.record;
      if (record.id !== id || record.tenantId !== context.tenantId || record.evidenceId !== evidenceId) throw new Error('Mapping transaction scope mismatch.');
      if (!replay && record.operation.state !== 'FAILED') {
        if (!source.accepted || source.evidence.quarantine_state !== 'CLEAN' || source.evidence.sha256 !== record.snapshot.sourceHash) fail('FILE_NOT_CLEAN', 409);
        const facts = (await client.query(`SELECT data FROM platform_extraction_records WHERE tenant_id=$1 AND evidence_id=$2 AND data->'confirmation'->>'id'=$3 FOR SHARE`,
          [context.tenantId, evidenceId, record.snapshot.confirmationId])).rows[0]?.data;
        if (!facts || facts.draft?.state !== 'CONFIRMED' || fingerprint(facts.verifiedPayload) !== record.snapshot.factsHash) fail('REVISION_CONFLICT', 409);
      }
      await client.query(`INSERT INTO openresolve_mapping_records(tenant_id,id,evidence_id,created_at,data) VALUES($1,$2,$3,$4,$5::jsonb)
        ON CONFLICT(tenant_id,id) DO UPDATE SET data=EXCLUDED.data`, [context.tenantId, id, evidenceId, record.createdAt, JSON.stringify(record)]);
      if (command && !replay) await client.query('INSERT INTO openresolve_mapping_commands(tenant_id,scope_hash,request_hash,record_id,response) VALUES($1,$2,$3,$4,$5::jsonb)',
        [context.tenantId, command.scope, command.hash, id, JSON.stringify(result.result)]);
      return result.result;
    });
  }
}
