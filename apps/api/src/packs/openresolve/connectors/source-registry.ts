/* SPDX-License-Identifier: MIT */
import { DatabaseService } from '../../../database/database.service';
import { EvidenceContext, fail } from '../../../platform/evidence/evidence.types';
import { contextValid, UUID } from '../../../platform/evidence/file-safety';
import { CurrentTenantAuthority } from '../../../platform/lineage/verified-evidence-access';
import { SourceKind, SourceRegistration, SourceRegistry } from './ingress.types';
export class PostgresSourceRegistry implements SourceRegistry {
  constructor(private readonly db: Pick<DatabaseService, 'query'>, private readonly authority: Pick<CurrentTenantAuthority, 'authorize'>) {
    if (!authority?.authorize) throw new Error('Current source/tenant service authorization is required.');
  }
  async resolve(context: EvidenceContext, sourceId: string, kind: SourceKind): Promise<SourceRegistration> {
    contextValid(context); if (!UUID.test(sourceId) || !['EXTERNAL_ORDER', 'RECEIVING_SENSOR'].includes(kind)) fail('INVALID_REQUEST');
    const row = (await this.db.query(`SELECT id,tenant_id AS "tenantId",principal,kind,active,simulated FROM openresolve_connector_sources WHERE tenant_id=$1 AND id=$2`, [context.tenantId, sourceId])).rows[0];
    if (!row || row.kind !== kind) fail('NOT_FOUND', 404);
    if (!row.active || row.principal !== context.subject) fail('FORBIDDEN', 403);
    await this.authority.authorize(context, 'connector.ingest', { pack_id: 'openresolve', type: 'connector-source', id: sourceId });
    return row;
  }
}
