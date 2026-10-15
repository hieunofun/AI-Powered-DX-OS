/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { EvidenceContext, fail } from '../../../platform/evidence/evidence.types';
import { contextValid, fingerprint, UUID } from '../../../platform/evidence/file-safety';
import { ConnectorCaseRequest, ConnectorCaseTarget, SourceObservation } from './ingress.types';
export interface ConnectorCaseAuthorization {
  // Verify current processor+original source grants, tenant/PO/mapping version and all witness ACL/CLEAN/hash facts in this transaction.
  check(client: PoolClient, context: EvidenceContext, observation: SourceObservation, request: ConnectorCaseRequest): Promise<void>;
}
export class PostgresConnectorCaseOutbox implements ConnectorCaseTarget {
  constructor(private readonly authorization: ConnectorCaseAuthorization) {
    if (!authorization?.check) throw new Error('Transactional source/tenant/resource authorization is required.');
  }
  async enqueue(client: PoolClient, context: EvidenceContext, observation: SourceObservation, request: ConnectorCaseRequest) {
    contextValid(context);
    if (observation.tenantId !== context.tenantId || !UUID.test(observation.correlationId || '')) fail('INVALID_STATE', 409);
    await this.authorization.check(client, context, observation, request);
    const hash = fingerprint(request);
    const existing = (await client.query('SELECT request_hash FROM openresolve_connector_case_outbox WHERE tenant_id=$1 AND observation_id=$2', [context.tenantId, observation.id])).rows[0];
    if (existing) { if (existing.request_hash !== hash) fail('IDEMPOTENCY_CONFLICT', 409); return; }
    const envelope = { id: randomUUID(), type: 'openresolve.source.discrepancy.v1', tenant_id: context.tenantId, occurred_at: observation.event.observed_at,
      correlation_id: observation.correlationId, ...(observation.originalObservationId ? { causation_id: observation.originalObservationId } : {}),
      subject_ref: request.subject_ref, schema_id: 'openresolve.source-case-intent.v1', payload_ref: { pack_id: 'openresolve', type: 'connector-case-intent', id: observation.id } };
    await client.query('INSERT INTO openresolve_connector_case_outbox(tenant_id,observation_id,request_hash,case_request,event_envelope) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)',
      [context.tenantId, observation.id, hash, JSON.stringify(request), JSON.stringify(envelope)]);
  }
}
