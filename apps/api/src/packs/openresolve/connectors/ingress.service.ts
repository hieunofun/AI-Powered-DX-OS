/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { EvidenceService } from '../../../platform/evidence/evidence.service';
import { EvidenceContext, EvidenceError, fail } from '../../../platform/evidence/evidence.types';
import { checksum, contextValid, fingerprint, idempotencyKey, UUID } from '../../../platform/evidence/file-safety';
import { CurrentTenantAuthority } from '../../../platform/lineage/verified-evidence-access';
import { IngressStore } from './ingress.repository';
import { ConnectorCaseRequest, ConnectorCaseTarget, ConnectorLineageSink, ExternalOrderMapping, SourceKind, SourceRegistry } from './ingress.types';
import { parseSourceEvent, sourceWitness } from './ingress-validation';
import { reconcileObservation } from './ingress-reconciliation';
export class ConnectorIngressService {
  private active = 0;
  constructor(private readonly store: IngressStore, private readonly registry: SourceRegistry, private readonly authority: Pick<CurrentTenantAuthority, 'authorize'>,
    private readonly evidence: EvidenceService, private readonly mapping: ExternalOrderMapping, private readonly cases: ConnectorCaseTarget, private readonly lineage: ConnectorLineageSink,
    private readonly now: () => number = Date.now) {
    if (!registry?.resolve || !authority?.authorize || !mapping?.snapshot || !cases?.enqueue || !lineage?.capture) throw new Error('Current source/resource authority, registered PO mappings, durable case target and lineage are required.');
  }
  private at() { return new Date(this.now()).toISOString(); }
  private sourceRef(id: string) { return { pack_id: 'openresolve', type: 'connector-source', id }; }
  async receive(context: EvidenceContext, sourceId: string, kind: SourceKind, bytes: Buffer, key: string, correlationId?: string) {
    contextValid(context); idempotencyKey(key);
    if (correlationId !== undefined && !UUID.test(correlationId)) fail('INVALID_REQUEST');
    const source = await this.registry.resolve(context, sourceId, kind);
    if (!source || source.tenantId !== context.tenantId || source.id !== sourceId || source.principal !== context.subject || !source.active || source.kind !== kind) fail('FORBIDDEN', 403);
    const parsed = parseSourceEvent(bytes, kind, this.now());
    const route = '/connectors/' + kind + '/' + sourceId + '/events';
    return this.store.accept(context, source, parsed, bytes, { scope: fingerprint([context.tenantId, context.subject, 'POST', route, key]), hash: parsed.contentHash }, this.at(), correlationId);
  }
  private async find(context: EvidenceContext, id: string) {
    contextValid(context); if (!UUID.test(id)) fail('INVALID_REQUEST');
    const record = await this.store.read(context, id); if (!record) fail('NOT_FOUND', 404);
    await this.authority.authorize(context, 'connector.read', this.sourceRef(record.sourceId)); return record;
  }
  async detail(context: EvidenceContext, id: string) {
    const record = await this.find(context, id);
    return { id: record.id, tenant_id: record.tenantId, source_id: record.sourceId, source_kind: record.kind, simulated: record.simulated,
      source_event_id: record.event.source_event_id, schema_id: record.event.schema_id, observed_at: record.event.observed_at, received_at: record.receivedAt,
      raw_sha256: record.rawHash, content_sha256: record.contentHash, operation: record.operation,
      ...(record.originalObservationId ? { original_observation_id: record.originalObservationId } : {}),
      ...(record.evidenceId ? { evidence_id: record.evidenceId, evidence_sha256: record.evidenceSha256 } : {}),
      ...(record.outcome ? { outcome: { purchase_order_id: record.outcome.purchaseOrderId, source_version: record.outcome.sourceVersion,
        case_dispatch: record.outcome.caseDispatch, ...(record.outcome.reason ? { reason: record.outcome.reason, severity: record.outcome.severity } : {}) } } : {}) };
  }
  async operation(context: EvidenceContext, id: string) {
    contextValid(context); if (!UUID.test(id)) fail('INVALID_REQUEST');
    const record = await this.store.operation(context, id); if (!record) return;
    await this.authority.authorize(context, 'connector.read', this.sourceRef(record.sourceId)); return record.operation;
  }
  async processNext(context: EvidenceContext) {
    contextValid(context); await this.authority.authorize(context, 'connector.process');
    if (this.active >= 2) fail('QUOTA_EXCEEDED', 429, true); this.active++;
    try {
      const id = await this.store.candidate(context, this.at()); if (!id) return;
      const before = await this.store.read(context, id); if (!before) fail('NOT_FOUND', 404);
      const initiator = { tenantId: context.tenantId, subject: before.requestedBy }, token = randomUUID();
      const guard = async () => {
        await this.registry.resolve(initiator, before.sourceId, before.kind);
        await this.authority.authorize(context, 'connector.process', this.sourceRef(before.sourceId));
      };
      await guard();
      const claimed = await this.store.change(context, id, async record => {
        if (!['PENDING', 'RUNNING'].includes(record.operation.state) || record.lease && Date.parse(record.lease.until) > this.now() ||
          record.nextAttemptAt && Date.parse(record.nextAttemptAt) > this.now()) return false;
        if (record.attempts >= 3) { record.operation.state = 'FAILED'; record.operation.updated_at = this.at(); delete record.lease; return false; }
        record.attempts++; record.lease = { token, until: new Date(this.now() + 120000).toISOString() }; delete record.nextAttemptAt;
        record.operation.state = 'RUNNING'; record.operation.updated_at = this.at(); delete record.operation.error; return true;
      });
      if (!claimed) return (await this.store.read(context, id)).operation;
      try {
        await guard();
        if (before.witnessVersion !== 'source-witness-xml-v1') fail('DEPENDENCY_UNAVAILABLE', 503);
        const raw = await this.store.bytes(context, before), witness = sourceWitness(raw), witnessHash = checksum(witness), command = 'connector-witness-' + id;
        const registered = before.evidenceId ? { evidence: await this.evidence.detail(context, before.evidenceId) } : await this.evidence.register(context, { filename: (before.simulated ? 'SIMULATED-' : '') + 'source-event-' + id + '.xml', media_type: 'application/xml',
          size_bytes: witness.length, sha256: witnessHash, source: { kind: 'CONNECTOR', source_id: before.sourceId, observed_at: before.event.observed_at }, retention_class: 'STANDARD' }, command);
        if (registered.evidence.sha256 !== witnessHash || registered.evidence.media_type !== 'application/xml' || registered.evidence.size_bytes !== witness.length) fail('CHECKSUM_MISMATCH', 422);
        await this.store.change(context, id, async record => {
          if (record.lease?.token !== token || Date.parse(record.lease.until) <= this.now()) fail('REVISION_CONFLICT', 409);
          if (record.evidenceId && (record.evidenceId !== registered.evidence.id || record.evidenceSha256 !== witnessHash)) fail('REVISION_CONFLICT', 409);
          record.evidenceId = registered.evidence.id; record.evidenceSha256 = witnessHash;
        });
        if (registered.evidence.quarantine_state === 'PENDING_UPLOAD') {
          const stream = { async *[Symbol.asyncIterator]() { yield witness; } };
          await this.evidence.upload(context, registered.evidence.id, stream, 'application/xml', command + '-upload');
        }
        await guard();
        await this.evidence.processNextScan(context, registered.evidence.id);
        const current = await this.evidence.detail(context, registered.evidence.id);
        if (current.quarantine_state !== 'CLEAN') {
          if (current.quarantine_state === 'PENDING_SCAN' || current.quarantine_state === 'SCAN_FAILED') fail('DEPENDENCY_UNAVAILABLE', 503, true);
          fail('FILE_NOT_CLEAN', 409);
        }
        return await this.evidence.withCleanBytes(context, registered.evidence.id, 'evidence.download', async (bytes, recheck) => {
          if (checksum(bytes) !== witnessHash || !bytes.equals(witness)) fail('CHECKSUM_MISMATCH', 422);
          await guard(); await recheck();
          return this.store.change(context, id, async (record, client) => {
            if (record.lease?.token !== token || Date.parse(record.lease.until) <= this.now()) fail('REVISION_CONFLICT', 409);
            await guard(); await recheck();
            const source = await this.registry.resolve(initiator, record.sourceId, record.kind);
            const order = await this.mapping.snapshot(initiator, source, record.event.data.external_order_id, client);
            await this.authority.authorize(context, 'connector.process', { pack_id: 'openresolve', type: 'purchase-order', id: order.purchaseOrderId });
            const protectedSource = (await client.query('SELECT data FROM platform_evidence_records WHERE tenant_id=$1 AND id=$2 FOR SHARE', [context.tenantId, record.evidenceId])).rows[0]?.data;
            if (!protectedSource || protectedSource.evidence.quarantine_state !== 'CLEAN' || protectedSource.evidence.sha256 !== witnessHash) fail('FILE_NOT_CLEAN', 409);
            const previous = record.kind === 'RECEIVING_SENSOR' ? await this.store.previousSensor(client, context, record) : undefined;
            record.outcome = reconcileObservation(context, record, order, previous);
            const original = record.originalObservationId ? await this.store.read(context, record.originalObservationId) : undefined;
            let request: ConnectorCaseRequest;
            if (record.outcome.reason) {
              request = { reason: record.outcome.reason, severity: record.outcome.severity, subject_ref: { pack_id: 'openresolve', type: 'purchase-order', id: order.purchaseOrderId }, evidence_ids: [record.evidenceId] };
              await this.cases.enqueue(client, context, record, request);
            }
            await this.lineage.capture(client, context, record, protectedSource.evidence, order, request, original);
            record.operation.state = 'SUCCEEDED'; record.operation.updated_at = this.at(); delete record.operation.error; delete record.lease; return record.operation;
          });
        });
      } catch (cause) {
        return this.store.change(context, id, async record => {
          if (record.lease?.token !== token || Date.parse(record.lease.until) <= this.now()) fail('REVISION_CONFLICT', 409);
          const code = cause instanceof EvidenceError ? cause.code : 'DEPENDENCY_UNAVAILABLE';
          const retryable = record.attempts < 3 && (!(cause instanceof EvidenceError) || cause.retryable || cause.getStatus() >= 500);
          (record.failures ||= []).push({ attempt: record.attempts, at: this.at(), code });
          record.operation.state = retryable ? 'PENDING' : 'FAILED'; record.operation.updated_at = this.at();
          record.operation.error = { code, message: 'Connector processing is blocked.', correlation_id: randomUUID(), retryable };
          if (retryable) record.nextAttemptAt = new Date(this.now() + 1000 * 2 ** (record.attempts - 1) + Math.floor(Math.random() * 250)).toISOString();
          delete record.lease; return record.operation;
        });
      }
    } finally { this.active--; }
  }
}
