/* SPDX-License-Identifier: MIT */
import { PoolClient } from 'pg';
import { DatabaseService } from '../../../database/database.service';
import { contextValid, fingerprint } from '../../../platform/evidence/file-safety';
import { EvidenceContext, fail } from '../../../platform/evidence/evidence.types';
import { ActionProposal, Command, ExplanationJob, MediationStore } from './mediation.types';
export class PostgresMediationStore implements MediationStore {
  constructor(private readonly db: Pick<DatabaseService, 'query' | 'transaction'>) {}
  async transaction<T>(ctx: EvidenceContext, work: (client: PoolClient, version: string) => Promise<T>, requireEnabled = true): Promise<T> {
    contextValid(ctx);
    return this.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL statement_timeout='15s'"); await client.query("SET LOCAL lock_timeout='5s'");
      const control = (await client.query('SELECT enabled,revision::text FROM openresolve_ai_controls WHERE tenant_id=$1 FOR SHARE', [ctx.tenantId])).rows[0];
      if (!control || requireEnabled && !control.enabled) fail('DEPENDENCY_UNAVAILABLE', 503);
      return work(client, control.revision);
    });
  }
  async job(ctx: EvidenceContext, id: string, client?: PoolClient): Promise<ExplanationJob | undefined> {
    const sql = 'SELECT data FROM openresolve_ai_explanations WHERE tenant_id=$1 AND id=$2', params = [ctx.tenantId, id];
    return (client ? await client.query(sql, params) : await this.db.query(sql, params)).rows[0]?.data;
  }
  async operation(ctx: EvidenceContext, id: string): Promise<ExplanationJob | undefined> {
    return (await this.db.query("SELECT data FROM openresolve_ai_explanations WHERE tenant_id=$1 AND data->'operation'->>'id'=$2", [ctx.tenantId, id])).rows[0]?.data;
  }
  async candidate(ctx: EvidenceContext, now: string): Promise<string | undefined> {
    return (await this.db.query(`SELECT id FROM openresolve_ai_explanations WHERE tenant_id=$1 AND data->'operation'->>'state' IN ('PENDING','RUNNING')
      AND (data->'lease'->>'until' IS NULL OR (data->'lease'->>'until')::timestamptz<=$2::timestamptz)
      AND (data->>'nextAttemptAt' IS NULL OR (data->>'nextAttemptAt')::timestamptz<=$2::timestamptz) ORDER BY created_at,id LIMIT 1`, [ctx.tenantId, now])).rows[0]?.id;
  }
  async lock(client: PoolClient, ctx: EvidenceContext, namespace: 'job' | 'proposal', id: string) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [fingerprint(['ai-mediation', ctx.tenantId, namespace, id])]);
  }
  async saveJob(client: PoolClient, job: ExplanationJob) {
    await client.query(`INSERT INTO openresolve_ai_explanations(tenant_id,id,data,created_at) VALUES($1,$2,$3::jsonb,$4)
      ON CONFLICT(tenant_id,id) DO UPDATE SET data=EXCLUDED.data`, [job.tenantId, job.id, JSON.stringify(job), job.createdAt]);
    await this.history(client, job.tenantId, job.id, 'EXPLANATION', job);
  }
  async proposal(ctx: EvidenceContext, id: string, client: PoolClient): Promise<ActionProposal | undefined> {
    return (await client.query('SELECT data FROM openresolve_ai_proposals WHERE tenant_id=$1 AND id=$2', [ctx.tenantId, id])).rows[0]?.data;
  }
  async saveProposal(client: PoolClient, proposal: ActionProposal) {
    await client.query(`INSERT INTO openresolve_ai_proposals(tenant_id,id,explanation_id,data) VALUES($1,$2,$3,$4::jsonb)
      ON CONFLICT(tenant_id,id) DO UPDATE SET data=EXCLUDED.data`, [proposal.tenantId, proposal.id, proposal.explanationId, JSON.stringify(proposal)]);
    await this.history(client, proposal.tenantId, proposal.id, 'PROPOSAL', proposal);
  }
  private async history(client: PoolClient, tenant: string, id: string, kind: string, value: unknown) {
    await client.query('INSERT INTO openresolve_ai_history(tenant_id,resource_id,kind,snapshot,sha256) VALUES($1,$2,$3,$4::jsonb,$5)', [tenant, id, kind, JSON.stringify(value), fingerprint(value)]);
  }
  async command<T>(client: PoolClient, ctx: EvidenceContext, command: Command, work: () => Promise<T>): Promise<T> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [fingerprint(['ai-command', ctx.tenantId, command.scope])]);
    const existing = (await client.query('SELECT request_hash,response FROM openresolve_ai_commands WHERE tenant_id=$1 AND scope_hash=$2', [ctx.tenantId, command.scope])).rows[0];
    if (existing) { if (existing.request_hash !== command.hash) fail('IDEMPOTENCY_CONFLICT', 409); return existing.response; }
    const result = await work();
    await client.query('INSERT INTO openresolve_ai_commands(tenant_id,scope_hash,request_hash,response) VALUES($1,$2,$3,$4::jsonb)', [ctx.tenantId, command.scope, command.hash, JSON.stringify(result)]);
    return result;
  }
}
