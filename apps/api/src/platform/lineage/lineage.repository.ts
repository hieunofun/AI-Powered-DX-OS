/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { EvidenceContext, fail } from '../evidence/evidence.types';
import { contextValid, fingerprint, UUID } from '../evidence/file-safety';
import { LineageEdge, LineageStore, ResourceSnapshot } from './lineage.types';
export class PostgresLineageStore implements LineageStore {
  constructor(private readonly db: Pick<DatabaseService, 'query'>) {}
  async watermark(context: EvidenceContext, evidenceId: string) {
    const result = await this.db.query('SELECT COALESCE(MAX(sequence),0)::text AS watermark FROM platform_lineage_links WHERE tenant_id=$1 AND evidence_id=$2', [context.tenantId, evidenceId]);
    return result.rows[0].watermark;
  }
  async page(context: EvidenceContext, evidenceId: string, after: string, through: string, limit: number) {
    const result = await this.db.query(`SELECT sequence::text,link FROM platform_lineage_links WHERE tenant_id=$1 AND evidence_id=$2
      AND sequence>$3::bigint AND sequence<=$4::bigint ORDER BY platform_lineage_links.sequence LIMIT $5`, [context.tenantId, evidenceId, after, through, limit]);
    return result.rows;
  }
  private async snapshot(client: PoolClient, context: EvidenceContext, value: ResourceSnapshot) {
    if (!value || !value.ref || !UUID.test(value.ref.id) || ![value.ref.pack_id, value.ref.type, value.version].every(v => typeof v === 'string' && /^[a-zA-Z0-9._:-]{1,80}$/.test(v)) ||
      typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) || value.sha256.length !== 64 || JSON.stringify(value.metadata).length > 16384) fail('DRAFT_INVALID', 422);
    const key = fingerprint([value.ref, value.version]), hash = fingerprint(value);
    await client.query(`INSERT INTO platform_lineage_snapshots(tenant_id,resource_key,sha256,data)
      VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(tenant_id,resource_key) DO NOTHING`, [context.tenantId, key, hash, JSON.stringify(value)]);
    const existing = await client.query('SELECT sha256 FROM platform_lineage_snapshots WHERE tenant_id=$1 AND resource_key=$2', [context.tenantId, key]);
    if (existing.rows[0]?.sha256 !== hash) fail('REVISION_CONFLICT', 409);
    return key;
  }
  async append(client: PoolClient, context: EvidenceContext, evidenceId: string, edges: LineageEdge[]) {
    contextValid(context); if (!UUID.test(evidenceId) || edges.length > 1000) fail('INVALID_REQUEST');
    // Serialize sequence allocation through commit for each source, so a captured watermark cannot skip an earlier pending writer.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['lineage-source:' + context.tenantId + ':' + evidenceId]);
    for (const edge of edges) {
      if (!['DERIVED_FROM', 'CORRECTS', 'CONFIRMS', 'SUPPORTS', 'EVALUATED_BY'].includes(edge.relation) ||
        typeof edge.createdAt !== 'string' || !edge.createdAt.endsWith('Z') || !Number.isFinite(Date.parse(edge.createdAt))) fail('DRAFT_INVALID', 422);
      const from = await this.snapshot(client, context, edge.from), to = await this.snapshot(client, context, edge.to);
      const key = fingerprint([evidenceId, from, to, edge.relation]), hash = fingerprint([key, edge.createdAt]);
      const link = { id: randomUUID(), tenant_id: context.tenantId, from_ref: edge.from.ref, to_ref: edge.to.ref, relation: edge.relation, created_at: edge.createdAt };
      await client.query(`INSERT INTO platform_lineage_links(tenant_id,evidence_id,edge_key,sha256,from_key,to_key,link)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(tenant_id,evidence_id,edge_key) DO NOTHING`,
      [context.tenantId, evidenceId, key, hash, from, to, JSON.stringify(link)]);
      const existing = await client.query('SELECT sha256 FROM platform_lineage_links WHERE tenant_id=$1 AND evidence_id=$2 AND edge_key=$3', [context.tenantId, evidenceId, key]);
      if (existing.rows[0]?.sha256 !== hash) fail('REVISION_CONFLICT', 409);
    }
  }
}
