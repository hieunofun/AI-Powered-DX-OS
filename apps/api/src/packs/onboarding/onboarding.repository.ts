/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { DataPort } from '../../platform/data/data.port';
import { EvidenceContext, fail } from '../../platform/evidence/evidence.types';
import { contextValid, fingerprint } from '../../platform/evidence/file-safety';
import { ONBOARDING_MANIFEST } from './onboarding.manifest';
import { caseView } from './onboarding-validation';
import { OnboardingCase, OnboardingCommand, OnboardingLineageSink, OnboardingStore } from './onboarding.types';
export class PostgresOnboardingStore implements OnboardingStore {
  constructor(private readonly db: Pick<DataPort, 'query' | 'transaction'>, private readonly lineage: OnboardingLineageSink) {
    if (!lineage?.capture) throw new Error('Transactional shared lineage is required.');
  }
  async transaction<T>(ctx: EvidenceContext, work: (client: PoolClient) => Promise<T>): Promise<T> {
    contextValid(ctx); return this.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'); await client.query("SET LOCAL statement_timeout='15s'"); await client.query("SET LOCAL lock_timeout='5s'");
      return work(client);
    });
  }
  async read(ctx: EvidenceContext, id: string, client?: PoolClient): Promise<OnboardingCase | undefined> {
    const sql = 'SELECT data FROM onboarding_cases WHERE tenant_id=$1 AND id=$2', args = [ctx.tenantId, id];
    return (client ? await client.query(sql, args) : await this.db.query(sql, args)).rows[0]?.data;
  }
  async operation(ctx: EvidenceContext, id: string): Promise<OnboardingCase | undefined> {
    return (await this.db.query("SELECT data FROM onboarding_cases WHERE tenant_id=$1 AND EXISTS(SELECT 1 FROM jsonb_array_elements(data->'operations') op WHERE op->>'id'=$2)", [ctx.tenantId, id])).rows[0]?.data;
  }
  async lock(client: PoolClient, ctx: EvidenceContext, id: string) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [fingerprint(['onboarding-case', ctx.tenantId, id])]);
  }
  async save(client: PoolClient, ctx: EvidenceContext, before: OnboardingCase | undefined, after: OnboardingCase) {
    if (after.tenantId !== ctx.tenantId || after.provisioningState !== 'NOT_PROVISIONED') fail('INVALID_STATE', 409);
    await client.query(`INSERT INTO onboarding_cases(tenant_id,id,data,created_at) VALUES($1,$2,$3::jsonb,$4)
      ON CONFLICT(tenant_id,id) DO UPDATE SET data=EXCLUDED.data`, [ctx.tenantId, after.id, JSON.stringify(after), after.createdAt]);
    await client.query('INSERT INTO onboarding_history(tenant_id,case_id,record,sha256,recorded_at) VALUES($1,$2,$3::jsonb,$4,$5)', [ctx.tenantId, after.id, JSON.stringify(after), fingerprint(after), after.updatedAt]);
    await this.lineage.capture(client, ctx, before, after);
    let type: string;
    if (!before) type = 'onboarding.case.created.v1';
    else if (after.checklist.length > before.checklist.length) type = 'onboarding.checklist.recorded.v1';
    else if (!before.request && after.request) type = 'onboarding.access.requested.v1';
    else if (!before.decision && after.decision) type = 'onboarding.access.decided.v1';
    else if (before.state !== 'COMPLETED' && after.state === 'COMPLETED') type = 'onboarding.case.completed.v1';
    if (!type) return;
    const declared: readonly string[] = ONBOARDING_MANIFEST.published_events; if (!declared.includes(type)) fail('FORBIDDEN', 403);
    const id = randomUUID(), snapshotId = randomUUID(), snapshot = caseView(after);
    await client.query('INSERT INTO onboarding_snapshots VALUES($1,$2,$3,$4::jsonb,$5,$6)', [ctx.tenantId, snapshotId, after.id, JSON.stringify(snapshot), fingerprint(snapshot), after.updatedAt]);
    const event = { id, type, tenant_id: ctx.tenantId, occurred_at: after.updatedAt, correlation_id: after.id,
      subject_ref: { pack_id: 'onboarding', type: 'case', id: after.id }, schema_id: 'onboarding.case.v1', payload_ref: { pack_id: 'onboarding', type: 'case-snapshot', id: snapshotId } };
    // Pending pack outbox; no claim that the absent owning #59 dispatcher consumed it.
    await client.query('INSERT INTO onboarding_event_outbox(tenant_id,id,case_id,event,snapshot_id) VALUES($1,$2,$3,$4::jsonb,$5)', [ctx.tenantId, id, after.id, JSON.stringify(event), snapshotId]);
  }
  async command<T>(client: PoolClient, ctx: EvidenceContext, command: OnboardingCommand, work: () => Promise<T>): Promise<T> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [fingerprint(['onboarding-command', ctx.tenantId, command.scope])]);
    const old = (await client.query('SELECT request_hash,response FROM onboarding_commands WHERE tenant_id=$1 AND scope_hash=$2', [ctx.tenantId, command.scope])).rows[0];
    if (old) { if (old.request_hash !== command.hash) fail('IDEMPOTENCY_CONFLICT', 409); return old.response; }
    const result = await work(); await client.query('INSERT INTO onboarding_commands(tenant_id,scope_hash,request_hash,response) VALUES($1,$2,$3,$4::jsonb)', [ctx.tenantId, command.scope, command.hash, JSON.stringify(result)]); return result;
  }
  async candidate(ctx: EvidenceContext, now: string) {
    return (await this.db.query(`SELECT id FROM onboarding_cases WHERE tenant_id=$1 AND data->'intent' IS NOT NULL
      AND COALESCE(data->'intent'->>'phase','DONE')<>'DONE' AND (data->'intent'->'lease'->>'until' IS NULL OR (data->'intent'->'lease'->>'until')::timestamptz<=$2::timestamptz)
      AND (data->'intent'->>'nextAttemptAt' IS NULL OR (data->'intent'->>'nextAttemptAt')::timestamptz<=$2::timestamptz)
      AND (data->'intent'->>'attempts')::integer<3 ORDER BY created_at,id LIMIT 1`, [ctx.tenantId, now])).rows[0]?.id as string | undefined;
  }
}
