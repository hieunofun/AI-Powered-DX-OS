/* SPDX-License-Identifier: MIT */
import { PoolClient } from 'pg';
import { EvidenceContext, fail } from '../../../platform/evidence/evidence.types';
import { fingerprint } from '../../../platform/evidence/file-safety';
import { MappingDecision, ReviewedMappingTarget } from './mapping.types';
export interface MappingTransactionAuthorization {
  // Verify current actor grant and tenant/PO/item ownership + frozen facts/catalog revision in this transaction.
  // Lock the owning PO/current catalog consistently with catalog writers; the earlier suggestion is not a grant.
  check(client: PoolClient, context: EvidenceContext, decision: MappingDecision): Promise<void>;
}
export class PostgresMappingOutbox implements ReviewedMappingTarget {
  constructor(private readonly authorization: MappingTransactionAuthorization) {
    if (!authorization?.check) throw new Error('Transactional mapping ownership and current authority are required.');
  }
  async enqueue(client: PoolClient, context: EvidenceContext, decision: MappingDecision) {
    await this.authorization.check(client, context, decision);
    const hash = fingerprint(decision);
    const existing = (await client.query('SELECT payload_hash FROM openresolve_mapping_outbox WHERE tenant_id=$1 AND decision_id=$2', [context.tenantId, decision.id])).rows[0];
    if (existing) { if (existing.payload_hash !== hash) fail('IDEMPOTENCY_CONFLICT', 409); return; }
    await client.query('INSERT INTO openresolve_mapping_outbox(tenant_id,decision_id,payload_hash,payload) VALUES($1,$2,$3,$4::jsonb)', [context.tenantId, decision.id, hash, JSON.stringify(decision)]);
  }
}
