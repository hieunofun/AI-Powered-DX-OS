/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { EvidenceService } from '../../../platform/evidence/evidence.service';
import { EvidenceAccess, EvidenceContext, EvidenceError, fail } from '../../../platform/evidence/evidence.types';
import { contextValid, fingerprint, idempotencyKey, UUID } from '../../../platform/evidence/file-safety';
import { MappingStore } from './mapping.repository';
import { MappingDecision, MappingOperation, MappingRecord, ReviewedMappingTarget } from './mapping.types';
import { ReviewedMappingSource } from './reviewed-mapping.source';
import { ReviewedMappingEngine, validateMappingSnapshot } from './mapping-engine';
const strict = (value: unknown, allowed: string[]): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)));
export interface MappingDisclosurePolicy { resolve(context: EvidenceContext, evidenceId: string): Promise<'SYNTHETIC' | 'APPROVED_PAID'>; }
export class ReviewedMappingService {
  private active = 0;
  constructor(private readonly store: MappingStore, private readonly source: ReviewedMappingSource, private readonly evidence: EvidenceService,
    private readonly access: EvidenceAccess, private readonly engine: ReviewedMappingEngine, private readonly disclosure: MappingDisclosurePolicy,
    private readonly target: ReviewedMappingTarget, private readonly now: () => number = Date.now) {
    if (!source?.snapshot || !access?.check || !disclosure?.resolve || !target?.enqueue) throw new Error('Current authorized mapping source, disclosure and durable target are required.');
  }
  private at() { return new Date(this.now()).toISOString(); }
  private command(context: EvidenceContext, route: string, key: string, body: unknown) {
    idempotencyKey(key); return { scope: fingerprint([context.tenantId, context.subject, 'POST', route, key]), hash: fingerprint(body) };
  }
  private async find(context: EvidenceContext, id: string, action: string) {
    contextValid(context); if (!UUID.test(id)) fail('INVALID_REQUEST');
    const record = await this.store.read(context, id); if (!record) fail('NOT_FOUND', 404);
    await this.access.check(context, action, record.evidenceId); return record;
  }
  async request(context: EvidenceContext, confirmationId: string, body: unknown, key: string): Promise<MappingOperation> {
    contextValid(context);
    if (!UUID.test(confirmationId) || !strict(body, ['line_path']) || typeof body.line_path !== 'string') fail('INVALID_REQUEST');
    const snapshot = await this.source.snapshot(context, confirmationId, body.line_path); validateMappingSnapshot(context, snapshot);
    if (snapshot.confirmationId !== confirmationId || snapshot.line.path !== body.line_path) fail('NOT_FOUND', 404);
    await this.access.check(context, 'mapping.request', snapshot.evidenceId);
    const id = randomUUID(), at = this.at();
    return this.store.change(context, id, snapshot.evidenceId, this.command(context, '/verified-invoices/' + confirmationId + '/item-mapping-suggestions', key, body), async (existing, _client, replay, cached) => {
      if (replay) return { record: existing, result: cached };
      const operation: MappingOperation = { id: randomUUID(), tenant_id: context.tenantId, kind: 'ITEM_MAPPING', state: 'PENDING', created_at: at, updated_at: at,
        resource_ref: { pack_id: 'openresolve', type: 'item-mapping-suggestion', id } };
      const record: MappingRecord = { id, tenantId: context.tenantId, evidenceId: snapshot.evidenceId, requestedBy: context.subject, createdAt: at, snapshot, operation, revision: 1, attempts: 0 };
      return { record, result: operation };
    });
  }
  async detail(context: EvidenceContext, id: string) {
    const record = await this.find(context, id, 'mapping.read');
    return { id: record.id, tenant_id: record.tenantId, confirmation_id: record.snapshot.confirmationId, line_path: record.snapshot.line.path, revision: record.revision,
      operation: record.operation, ...(record.suggestion ? { suggestion: record.suggestion } : {}), ...(record.decision ? { decision: record.decision } : {}) };
  }
  async operation(context: EvidenceContext, id: string): Promise<MappingOperation | undefined> {
    contextValid(context); if (!UUID.test(id)) fail('INVALID_REQUEST');
    const record = await this.store.operation(context, id); if (!record) return;
    await this.access.check(context, 'mapping.read', record.evidenceId); await this.access.check(context, 'operation.read', record.evidenceId); return record.operation;
  }
  private async current(context: EvidenceContext, record: MappingRecord, action = 'mapping.request') {
    await this.access.check(context, action, record.evidenceId);
    const source = await this.evidence.detail(context, record.evidenceId);
    if (source.quarantine_state !== 'CLEAN' || source.sha256 !== record.snapshot.sourceHash) fail('FILE_NOT_CLEAN', 409);
    const latest = await this.source.snapshot(context, record.snapshot.confirmationId, record.snapshot.line.path);
    validateMappingSnapshot(context, latest);
    if (fingerprint(latest) !== fingerprint(record.snapshot)) fail('REVISION_CONFLICT', 409);
  }
  async processNext(context: EvidenceContext): Promise<MappingOperation | undefined> {
    contextValid(context); if (this.active >= 2) fail('QUOTA_EXCEEDED', 429, true); this.active++;
    try {
      const id = await this.store.candidate(context, this.at()); if (!id) return;
      const before = await this.find(context, id, 'mapping.request'), token = randomUUID(), initiator = { tenantId: context.tenantId, subject: before.requestedBy };
      await this.access.check(initiator, 'mapping.request', before.evidenceId);
      const claim = await this.store.change(context, id, before.evidenceId, undefined, async record => {
        if (!record) fail('NOT_FOUND', 404);
        if (record.suggestion || record.decision || !['PENDING', 'RUNNING'].includes(record.operation.state) || record.lease && Date.parse(record.lease.until) > this.now()) return { record, result: false };
        if (record.attempts >= 3) {
          record.operation.state = 'FAILED'; record.operation.error = { code: 'DEPENDENCY_UNAVAILABLE', message: 'Mapping attempts exhausted.', correlation_id: randomUUID(), retryable: false };
          delete record.lease; return { record, result: false };
        }
        record.attempts++; record.lease = { token, until: new Date(this.now() + 120000).toISOString() }; record.operation.state = 'RUNNING'; record.operation.updated_at = this.at();
        return { record, result: true };
      });
      if (!claim) return (await this.store.read(context, id)).operation;
      let suggestion: MappingRecord['suggestion'], failure: unknown;
      try {
        suggestion = await this.evidence.withCleanBytes(context, before.evidenceId, 'extraction.request', async (_bytes, recheck) => {
          const guard = async () => { await recheck(); await this.current(initiator, before); await this.access.check(context, 'mapping.request', before.evidenceId); };
          await guard();
          const result = await this.engine.suggest(initiator, before.snapshot, await this.disclosure.resolve(initiator, before.evidenceId), guard);
          await guard(); return result;
        });
      } catch (cause) { failure = cause; }
      return this.store.change(context, id, before.evidenceId, undefined, async record => {
        if (!record || record.lease?.token !== token || Date.parse(record.lease.until) <= this.now()) fail('REVISION_CONFLICT', 409);
        if (failure) {
          record.operation.state = 'FAILED'; record.operation.error = { code: failure instanceof EvidenceError ? failure.code : 'DEPENDENCY_UNAVAILABLE',
            message: 'Reviewed mapping is blocked.', correlation_id: randomUUID(), retryable: false };
        } else { record.suggestion = suggestion; record.operation.state = 'SUCCEEDED'; record.revision++; }
        delete record.lease; record.operation.updated_at = this.at(); return { record, result: record.operation };
      });
    } finally { this.active--; }
  }
  async confirm(context: EvidenceContext, id: string, body: unknown, key: string): Promise<MappingDecision> {
    const before = await this.find(context, id, 'mapping.confirm');
    if (!strict(body, ['expected_revision', 'selected_po_item_id', 'reason']) || !Number.isSafeInteger(body.expected_revision) || body.expected_revision < 1 ||
      body.selected_po_item_id !== null && (typeof body.selected_po_item_id !== 'string' || !UUID.test(body.selected_po_item_id)) ||
      typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 500) fail('INVALID_REQUEST');
    const commit = () => this.store.change<MappingDecision>(context, id, before.evidenceId, this.command(context, '/item-mapping-suggestions/' + id + '/confirmations', key, body), async (record, client, replay, cached) => {
      if (replay) return { record, result: cached };
      if (!record.suggestion || record.decision || record.operation.state !== 'SUCCEEDED') fail('INVALID_STATE', 409);
      if (record.revision !== body.expected_revision) fail('REVISION_CONFLICT', 409);
      await this.current(context, record, 'mapping.confirm'); await this.access.check(context, 'mapping.confirm', record.evidenceId);
      if (body.selected_po_item_id !== null && !record.snapshot.candidates.some(candidate => candidate.id === body.selected_po_item_id)) fail('NOT_FOUND', 404);
      const decision: MappingDecision = { id: randomUUID(), mapping_id: id, confirmation_id: record.snapshot.confirmationId, purchase_order_id: record.snapshot.purchaseOrderId, line_path: record.snapshot.line.path,
        selected_po_item_id: body.selected_po_item_id, actor_subject: context.subject, reason: body.reason, decided_at: this.at(),
        origin: body.selected_po_item_id === null ? 'REJECTED' : record.suggestion.candidates.some(candidate => candidate.po_item_id === body.selected_po_item_id) ? 'SUGGESTION' : 'MANUAL',
        source_sha256: record.snapshot.sourceHash, facts_sha256: record.snapshot.factsHash, catalog_revision: record.snapshot.catalogRevision,
        dispatch_state: body.selected_po_item_id === null ? 'NONE' : 'PENDING' };
      await client.query('INSERT INTO openresolve_mapping_decisions(tenant_id,id,mapping_id,data) VALUES($1,$2,$3,$4::jsonb)', [context.tenantId, decision.id, id, JSON.stringify(decision)]);
      if (decision.selected_po_item_id !== null) await this.target.enqueue(client, context, decision);
      record.decision = decision; record.revision++; return { record, result: decision };
    });
    if (before.decision) return commit();
    // Verify actual bytes before taking the SQL source lock: corruption revocation uses that same lock.
    return this.evidence.withCleanBytes(context, before.evidenceId, 'evidence.download', async (_bytes, recheck) => { await recheck(); return commit(); });
  }
}
