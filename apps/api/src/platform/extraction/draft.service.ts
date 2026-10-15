/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { AiProviderError } from './provider.port';
import { EvidenceService } from '../evidence/evidence.service';
import { EvidenceAccess, EvidenceContext, EvidenceError, EvidenceRecord, fail } from '../evidence/evidence.types';
import { contextValid, fingerprint, idempotencyKey, UUID } from '../evidence/file-safety';
import { DraftStore } from './draft.repository';
import { DraftConfirmation, DraftCorrection, DraftExtractor, DraftOperation, DraftProfile, DraftRecord, ReviewedDraft, VerifiedDraftTarget } from './draft.types';
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const object = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const strict = (value: unknown, allowed: string[]): value is Record<string, any> => object(value) && Object.keys(value).every(key => allowed.includes(key));
export class DraftService {
  private active = 0;
  private readonly profiles: Map<string, DraftProfile>;
  constructor(private readonly store: DraftStore, private readonly evidence: EvidenceService,
    private readonly extractor: DraftExtractor, profiles: DraftProfile[], private readonly access: EvidenceAccess,
    private readonly target: VerifiedDraftTarget, private readonly now: () => number = Date.now) {
    this.profiles = new Map(profiles.map(profile => [profile.id, profile]));
    if (!profiles.length || this.profiles.size !== profiles.length || !target?.authorize || !target?.enqueue) throw new Error('Draft profiles and an authorized durable target are required.');
  }
  private async authorize(context: EvidenceContext, action: string, evidenceId: string) {
    contextValid(context); if (!UUID.test(evidenceId)) fail('INVALID_REQUEST');
    await this.access.check(context, action, evidenceId);
  }
  private command(context: EvidenceContext, route: string, key: string, body: unknown) {
    idempotencyKey(key); return { scope: fingerprint([context.tenantId, context.subject, 'POST', route, key]), hash: fingerprint(body) };
  }
  private timestamp() { return new Date(this.now()).toISOString(); }
  private clean(source: EvidenceRecord, record?: DraftRecord) {
    if (!source.accepted || source.evidence.quarantine_state !== 'CLEAN') fail('FILE_NOT_CLEAN', 409);
    if (record && (source.evidence.sha256 !== record.sourceHash || source.objectKey !== record.objectKey)) fail('REVISION_CONFLICT', 409);
  }
  private sourceState(source: EvidenceRecord, state: EvidenceRecord['evidence']['processing_state']) {
    source.evidence.processing_state = state; source.evidence.revision++; source.evidence.updated_at = this.timestamp();
  }
  private profile(id: string) { const profile = this.profiles.get(id); if (!profile) fail('INVALID_REQUEST'); return profile; }
  private async find(context: EvidenceContext, id: string, action: string) {
    contextValid(context); if (!UUID.test(id)) fail('INVALID_REQUEST');
    const record = await this.store.read(context, id); if (!record) fail('NOT_FOUND', 404);
    await this.authorize(context, action, record.evidenceId); return record;
  }
  async request(context: EvidenceContext, evidenceId: string, body: unknown, key: string): Promise<DraftOperation> {
    await this.authorize(context, 'extraction.request', evidenceId);
    if (!strict(body, ['schema_id', 'mode']) || typeof body.schema_id !== 'string' || body.mode !== 'OCR') fail('INVALID_REQUEST');
    this.profile(body.schema_id);
    const id = randomUUID(), at = this.timestamp(), command = this.command(context, '/evidence/' + evidenceId + '/extractions', key, body);
    return this.store.change(context, id, evidenceId, command, async (existing, source, _client, replay, cached) => {
      if (replay) return { record: existing, result: cached };
      this.clean(source);
      if (!['NOT_STARTED', 'FAILED'].includes(source.evidence.processing_state) || !['application/pdf', 'image/png', 'image/jpeg'].includes(source.evidence.media_type)) fail('INVALID_STATE', 409);
      this.sourceState(source, 'QUEUED');
      const operation: DraftOperation = { id: randomUUID(), tenant_id: context.tenantId, kind: 'EXTRACTION', state: 'PENDING', created_at: at, updated_at: at,
        resource_ref: { pack_id: body.schema_id.split('.')[0], type: 'extraction-draft', id } };
      const record: DraftRecord = { id, tenantId: context.tenantId, evidenceId, evidenceRevision: source.evidence.revision, sourceHash: source.evidence.sha256, objectKey: source.objectKey, mediaType: source.evidence.media_type,
        schemaId: body.schema_id, mode: 'OCR', createdAt: at, requestedBy: context.subject, operation, providerRuns: [], attempts: 0 };
      return { record, source, result: operation };
    });
  }
  async detail(context: EvidenceContext, id: string) {
    const record = await this.find(context, id, 'extraction.read'); if (!record.draft) fail('NOT_FOUND', 404);
    return record.draft;
  }
  async operation(context: EvidenceContext, id: string): Promise<DraftOperation | undefined> {
    contextValid(context); if (!UUID.test(id)) fail('INVALID_REQUEST');
    const record = await this.store.operation(context, id); if (!record) return;
    await this.authorize(context, 'operation.read', record.evidenceId);
    await this.authorize(context, 'extraction.read', record.evidenceId);
    return record.operation.id === id ? record.operation : record.confirmation.operation;
  }
  async processNext(context: EvidenceContext): Promise<DraftOperation | undefined> {
    contextValid(context);
    if (this.active >= 2) fail('QUOTA_EXCEEDED', 429, true);
    this.active++;
    try {
      const id = await this.store.candidate(context, this.timestamp()); if (!id) return;
      const before = await this.find(context, id, 'extraction.request'), token = randomUUID();
      const initiator = { tenantId: context.tenantId, subject: before.requestedBy };
      await this.authorize(initiator, 'extraction.request', before.evidenceId);
      const claim = await this.store.change(context, id, before.evidenceId, undefined, async (record, source) => {
        if (!record) fail('NOT_FOUND', 404);
        if (record.draft || !['PENDING', 'RUNNING'].includes(record.operation.state) ||
          record.lease && Date.parse(record.lease.until) > this.now() || record.nextAttemptAt && Date.parse(record.nextAttemptAt) > this.now()) return { record, result: { record, run: false } };
        if (source.evidence.revision !== record.evidenceRevision) {
          record.operation.state = 'FAILED'; record.operation.error = { code: 'REVISION_CONFLICT', message: 'Extraction source changed.', correlation_id: randomUUID(), retryable: false };
          delete record.lease; return { record, result: { record, run: false } };
        }
        if (source.evidence.quarantine_state !== 'CLEAN' || source.evidence.sha256 !== record.sourceHash || source.objectKey !== record.objectKey || record.attempts >= 3) {
          record.operation.state = 'FAILED'; record.operation.error = { code: source.evidence.quarantine_state === 'CLEAN' ? 'DEPENDENCY_UNAVAILABLE' : 'FILE_NOT_CLEAN',
            message: 'Extraction is blocked.', correlation_id: randomUUID(), retryable: false };
          delete record.lease; this.sourceState(source, source.evidence.quarantine_state === 'CLEAN' ? 'FAILED' : 'NOT_STARTED');
          return { record, source, result: { record, run: false } };
        }
        record.attempts++; record.lease = { token, until: new Date(this.now() + 120000).toISOString() }; delete record.nextAttemptAt;
        record.operation.state = 'RUNNING'; record.operation.updated_at = this.timestamp(); delete record.operation.error;
        this.sourceState(source, 'PROCESSING'); record.evidenceRevision = source.evidence.revision;
        return { record, source, result: { record, run: true } };
      });
      if (!claim.run) return claim.record.operation;
      let result: Awaited<ReturnType<DraftExtractor['extract']>>, failure: unknown;
      try {
        result = await this.evidence.withCleanBytes(context, before.evidenceId, 'extraction.request', async (bytes, recheck) => {
          const guard = async () => { await recheck(); await this.authorize(initiator, 'extraction.request', before.evidenceId); };
          await guard();
          const output = await this.extractor.extract(initiator, before.evidenceId, before.schemaId, bytes, before.mediaType, before.mode, guard);
          await guard(); this.profile(before.schemaId).validateFields(output.fields);
          if (!output.runs.length || output.fields.some(field => field.source_refs.some(ref => ref.evidence_id !== before.evidenceId))) fail('DRAFT_INVALID', 422);
          return output;
        });
        await this.authorize(context, 'extraction.request', before.evidenceId);
        await this.authorize(initiator, 'extraction.request', before.evidenceId);
      } catch (error) { failure = error; }
      return this.store.change(context, id, before.evidenceId, undefined, async (record, source) => {
        if (!record || record.lease?.token !== token || Date.parse(record.lease.until) <= this.now()) fail('REVISION_CONFLICT', 409);
        const ownsSource = source.evidence.revision === claim.record.evidenceRevision;
        if (source.evidence.quarantine_state !== 'CLEAN' || source.evidence.sha256 !== record.sourceHash || source.objectKey !== record.objectKey || !ownsSource) {
          failure = new EvidenceError(source.evidence.quarantine_state === 'CLEAN' ? 'REVISION_CONFLICT' : 'FILE_NOT_CLEAN', 409);
        }
        if (failure) {
          (record.failures ||= []).push({ attempt: record.attempts, at: this.timestamp(), code: failure instanceof AiProviderError || failure instanceof EvidenceError ? failure.code : 'UNAVAILABLE',
            ...(failure instanceof AiProviderError && failure.runId ? { providerRunId: failure.runId } : {}) });
          const retryable = (failure instanceof AiProviderError || failure instanceof EvidenceError) && failure.retryable && record.attempts < 3;
          record.operation.state = retryable ? 'PENDING' : 'FAILED';
          record.operation.error = { code: failure instanceof EvidenceError ? failure.code : 'DEPENDENCY_UNAVAILABLE', message: 'Extraction is blocked.', correlation_id: randomUUID(), retryable };
          if (retryable) record.nextAttemptAt = new Date(this.now() + Math.max(1000 * 2 ** (record.attempts - 1), failure instanceof AiProviderError ? (failure.retryAfterSeconds || 0) * 1000 : 0) + Math.floor(Math.random() * 250)).toISOString();
          if (ownsSource) this.sourceState(source, source.evidence.quarantine_state === 'CLEAN' ? retryable ? 'QUEUED' : 'FAILED' : 'NOT_STARTED');
        } else {
          const at = this.timestamp(); record.original = copy(result.fields); record.providerRuns = copy(result.runs);
          if (result.sourceText) record.sourceText = copy(result.sourceText);
          record.draft = { id, tenant_id: context.tenantId, evidence_id: before.evidenceId, schema_id: before.schemaId, revision: 1,
            state: 'REVIEW_REQUIRED', fields: copy(result.fields), extractor: copy(result.runs[result.runs.length - 1].extractor), created_at: at, updated_at: at, corrections: [] };
          record.operation.state = 'SUCCEEDED'; record.operation.result_ref = { ...record.operation.resource_ref };
          this.sourceState(source, 'REVIEW_REQUIRED');
        }
        if (ownsSource) record.evidenceRevision = source.evidence.revision;
        record.operation.updated_at = this.timestamp(); delete record.lease;
        return { record, ...(ownsSource ? { source } : {}), result: record.operation };
      });
    } finally { this.active--; }
  }
  async correct(context: EvidenceContext, id: string, body: unknown, key: string): Promise<ReviewedDraft> {
    const before = await this.find(context, id, 'extraction.correct');
    if (!strict(body, ['expected_revision', 'corrections']) || !Number.isSafeInteger(body.expected_revision) || body.expected_revision < 1 ||
      !Array.isArray(body.corrections) || body.corrections.length < 1 || body.corrections.length > 100) fail('INVALID_REQUEST');
    const paths = new Set<string>();
    for (const input of body.corrections) {
      if (!strict(input, ['field_path', 'previous_value', 'new_value', 'reason']) || typeof input.field_path !== 'string' || paths.has(input.field_path) ||
        typeof input.new_value !== 'string' || !input.new_value || input.new_value.length > 2000 || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500 ||
        input.previous_value !== undefined && (typeof input.previous_value !== 'string' || !input.previous_value || input.previous_value.length > 2000)) fail('INVALID_REQUEST');
      paths.add(input.field_path);
    }
    return this.store.change<ReviewedDraft>(context, id, before.evidenceId, this.command(context, '/extraction-drafts/' + id + '/corrections', key, body), async (record, source, _client, replay, cached) => {
      if (replay) return { record, result: cached };
      this.clean(source, record);
      if (!record.draft || record.draft.state !== 'REVIEW_REQUIRED') fail('INVALID_STATE', 409);
      if (record.draft.revision !== body.expected_revision) fail('REVISION_CONFLICT', 409);
      const revision = record.draft.revision + 1, at = this.timestamp();
      for (const input of body.corrections) {
        const field = record.draft.fields.find(field => field.path === input.field_path); if (!field) fail('INVALID_REQUEST');
        if (field.status === 'EXTRACTED' ? input.previous_value !== field.value : input.previous_value !== undefined) fail('REVISION_CONFLICT', 409);
        const correction: DraftCorrection = { ...input, id: randomUUID(), actor_subject: context.subject, created_at: at, revision };
        record.draft.corrections.push(correction); field.value = input.new_value; field.status = 'EXTRACTED'; delete field.confidence;
        field.source_refs = [{ location_status: 'UNKNOWN', evidence_id: record.evidenceId, reason: 'MISSING_SOURCE' }];
      }
      record.draft.revision = revision; record.draft.updated_at = at;
      this.profile(record.schemaId).validateFields(record.draft.fields);
      return { record, result: record.draft };
    });
  }
  async confirm(context: EvidenceContext, id: string, body: unknown, key: string): Promise<DraftConfirmation> {
    const before = await this.find(context, id, 'extraction.confirm');
    if (!strict(body, ['expected_revision', 'reviewed_field_paths']) || !Number.isSafeInteger(body.expected_revision) || body.expected_revision < 1 ||
      !Array.isArray(body.reviewed_field_paths) || body.reviewed_field_paths.length < 1 || body.reviewed_field_paths.length > 5000 ||
      body.reviewed_field_paths.some(path => typeof path !== 'string' || !path || path.length > 200) || new Set(body.reviewed_field_paths).size !== body.reviewed_field_paths.length) fail('INVALID_REQUEST');
    const command = this.command(context, '/extraction-drafts/' + id + '/confirmations', key, body);
    return this.evidence.withCleanBytes(context, before.evidenceId, 'extraction.request', async (_bytes, recheck) => {
      if (!before.draft) fail('INVALID_STATE', 409);
      const payload = this.profile(before.schemaId).payload(before.draft.fields);
      await this.target.authorize(context, before.schemaId, payload); await this.authorize(context, 'extraction.confirm', before.evidenceId); await recheck();
      return this.store.change(context, id, before.evidenceId, command, async (record, source, client, replay, cached) => {
        if (replay) return { record, result: cached };
        this.clean(source, record);
        if (!record.draft || record.draft.state !== 'REVIEW_REQUIRED') fail('INVALID_STATE', 409);
        if (record.draft.revision !== body.expected_revision || record.draft.revision !== before.draft.revision) fail('REVISION_CONFLICT', 409);
        const approved = new Set(body.reviewed_field_paths), valid = new Set(record.draft.fields.map(field => field.path));
        if (body.reviewed_field_paths.some(path => !valid.has(path)) || this.profile(record.schemaId).requiredPaths(record.draft.fields).some(path => !approved.has(path))) fail('DRAFT_INVALID', 422);
        const at = this.timestamp(), confirmationId = randomUUID();
        const confirmation: DraftConfirmation = { id: confirmationId, draft_id: id, confirmed_revision: record.draft.revision, schema_id: record.schemaId,
          actor_subject: context.subject, confirmed_at: at, verified_payload_ref: { pack_id: record.schemaId.split('.')[0], type: this.profile(record.schemaId).verifiedResourceType, id: confirmationId },
          operation: { id: randomUUID(), tenant_id: context.tenantId, kind: 'DRAFT_CONFIRMATION', state: 'PENDING', created_at: at, updated_at: at,
            resource_ref: { pack_id: record.schemaId.split('.')[0], type: 'extraction-draft', id } } };
        // Write reviewed state first; outbox FK and enqueue are part of this same transaction.
        record.confirmation = confirmation; record.verifiedPayload = copy(payload); record.draft.state = 'CONFIRMED'; record.draft.revision++; record.draft.updated_at = at;
        await this.target.enqueue(client, context, confirmation, payload);
        this.sourceState(source, 'CONFIRMED'); record.evidenceRevision = source.evidence.revision;
        return { record, source, result: confirmation };
      });
    });
  }
}
