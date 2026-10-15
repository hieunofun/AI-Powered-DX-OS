/* SPDX-License-Identifier: MIT */
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { EvidenceAccess, EvidenceContext, EvidenceError, EvidenceOperation, EvidenceRecord, EvidenceScanner, EvidenceStorage, OperationReader, fail } from './evidence.types';
import { EvidenceSearch, EvidenceStore } from './evidence.repository';
import { boundedBytes, byteLimit, checksum, contextValid, fingerprint, idempotencyKey, registration, storageKey, UUID, validateContent } from './file-safety';
export class EvidenceService {
  private active = 0;
  constructor(private readonly store: EvidenceStore, private readonly storage: EvidenceStorage,
    private readonly scanner: EvidenceScanner, private readonly access: EvidenceAccess,
    private readonly cursorSecret: string, private readonly now: () => number = Date.now, private readonly extraOperations?: OperationReader) {
    if (Buffer.byteLength(cursorSecret || '') < 32) throw new Error('Evidence cursor secret must contain at least 32 bytes.');
  }
  private async authorize(context: EvidenceContext, action: string, id?: string, policy?: { retentionClass: 'STANDARD' | 'RESTRICTED' }): Promise<void> {
    contextValid(context);
    if (id && !UUID.test(id)) fail('INVALID_REQUEST');
    await this.access.check(context, action, id, policy);
  }
  private scope(context: EvidenceContext, method: string, route: string, key: string): string {
    idempotencyKey(key); return fingerprint([context.tenantId, context.subject, method, route, key]);
  }
  private touch(record: EvidenceRecord): void {
    record.evidence.revision++; record.evidence.updated_at = new Date(this.now()).toISOString();
    if (record.operation) record.operation.updated_at = record.evidence.updated_at;
  }
  private error(record: EvidenceRecord, code: string, retryable: boolean): void {
    record.operation.error = { code, message: 'Evidence processing is blocked.', correlation_id: randomUUID(), retryable };
  }
  private async slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= 2) fail('QUOTA_EXCEEDED', 429, true);
    this.active++;
    try { return await work(); } finally { this.active--; }
  }
  async register(context: EvidenceContext, body: unknown, key: string) {
    await this.authorize(context, 'evidence.register');
    const input = registration(body), id = randomUUID(), at = new Date(this.now()).toISOString();
    await this.authorize(context, 'evidence.register', undefined, { retentionClass: input.retention_class });
    const value = await this.store.change(context, id,
      { scope: this.scope(context, 'POST', '/evidence', key), hash: fingerprint(body) }, (existing, replay) => {
        if (replay) return { record: existing, result: existing };
        const record: EvidenceRecord = { evidence: { ...input, id, tenant_id: context.tenantId, revision: 1,
          filename: [...input.filename].filter(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join('').slice(0, 255) || 'evidence',
          quarantine_state: 'PENDING_UPLOAD', processing_state: 'NOT_STARTED', created_at: at, updated_at: at,
          created_by: context.subject, legal_hold: false }, expiresAt: new Date(Date.parse(at) + 900000).toISOString(),
          accepted: false, uploadAttempts: 0, scanAttempts: 0, history: [] };
        return { record, result: record };
      });
    await this.authorize(context, 'evidence.register', value.evidence.id);
    return { evidence: value.evidence, upload: { method: 'PUT' as const,
      href: '/platform/v1/evidence/' + value.evidence.id + '/content', expires_at: value.expiresAt } };
  }
  async detail(context: EvidenceContext, id: string) {
    await this.authorize(context, 'evidence.read', id);
    const record = await this.store.read(context, id); if (!record) fail('NOT_FOUND', 404);
    return record.evidence;
  }
  async operation(context: EvidenceContext, id: string) {
    contextValid(context); if (!UUID.test(id)) fail('INVALID_REQUEST');
    const record = await this.store.operation(context, id);
    if (!record) { const extra = await this.extraOperations?.read(context, id); if (!extra) fail('NOT_FOUND', 404); return extra; }
    await this.authorize(context, 'operation.read', record.evidence.id);
    return record.operation;
  }
  async page(context: EvidenceContext, limit = 25, cursor?: string, search: EvidenceSearch = {}) {
    await this.authorize(context, 'evidence.read');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_REQUEST');
    if (!search || Object.keys(search).some(key => !['q', 'retentionClass'].includes(key)) ||
      search.q !== undefined && (typeof search.q !== 'string' || !search.q.trim() || search.q.length > 128) ||
      search.retentionClass !== undefined && !['STANDARD', 'RESTRICTED'].includes(search.retentionClass)) fail('INVALID_REQUEST');
    const filter = 'evidence:' + fingerprint(search);
    let before: { at: string; id: string } | undefined;
    if (cursor) {
      if (cursor.length > 1024) fail('INVALID_REQUEST');
      const [payload, signature, extra] = cursor.split('.');
      const expected = createHmac('sha256', this.cursorSecret).update(payload || '').digest('base64url');
      if (extra || typeof signature !== 'string' || Buffer.byteLength(signature) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) fail('INVALID_REQUEST');
      let decoded: any;
      try { decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { fail('INVALID_REQUEST'); }
      if (decoded.tenant !== context.tenantId || decoded.subject !== context.subject || decoded.filter !== filter ||
        !UUID.test(decoded.id) || typeof decoded.at !== 'string' || !Number.isFinite(Date.parse(decoded.at))) fail('INVALID_REQUEST');
      before = { at: decoded.at, id: decoded.id };
    }
    const rows = await this.store.page(context, limit + 1, before, search), items = [];
    for (const row of rows.slice(0, limit)) {
      try { await this.authorize(context, 'evidence.read', row.evidence.id); items.push(row.evidence); }
      catch (cause) { if (!(cause instanceof EvidenceError) || cause.getStatus() !== 403 && cause.getStatus() !== 404) throw cause; }
    }
    for (const item of items) await this.authorize(context, 'evidence.read', item.id);
    await this.authorize(context, 'evidence.read');
    if (rows.length <= limit) return { items };
    const last = rows[limit - 1].evidence;
    const payload = Buffer.from(JSON.stringify({ tenant: context.tenantId, subject: context.subject, filter, at: last.created_at, id: last.id })).toString('base64url');
    return { items, next_cursor: payload + '.' + createHmac('sha256', this.cursorSecret).update(payload).digest('base64url') };
  }
  async upload(context: EvidenceContext, id: string, source: AsyncIterable<Buffer>, contentType: string, key: string): Promise<EvidenceOperation> {
    await this.authorize(context, 'evidence.upload', id);
    return this.slot(async () => {
      const before = await this.store.read(context, id); if (!before) fail('NOT_FOUND', 404);
      idempotencyKey(key);
      if ((contentType || '').split(';')[0].trim().toLowerCase() !== before.evidence.media_type) fail('UNSUPPORTED_MEDIA_TYPE', 415);
      const bytes = await boundedBytes(source, byteLimit(before.evidence.media_type));
      const scope = this.scope(context, 'PUT', '/evidence/' + id + '/content', key), hash = checksum(bytes);
      const previousHash = await this.store.commandHash(context, scope);
      if (previousHash && previousHash !== hash) fail('IDEMPOTENCY_CONFLICT', 409);
      await validateContent(bytes, before.evidence, contentType);
      const token = randomUUID(), at = new Date(this.now()).toISOString();
      const claim = await this.store.change(context, id,
        { scope, hash }, (record, replay) => {
          if (!record) fail('NOT_FOUND', 404);
          if (record.accepted) {
            if (!replay) fail('INVALID_STATE', 409);
            return { record, result: { record, write: false, pending: false } };
          }
          if (record.lease && Date.parse(record.lease.until) > this.now()) return { record, result: { record, write: false, pending: true } };
          if (Date.parse(record.expiresAt) <= this.now() && !record.operation) fail('INVALID_STATE', 409);
          if (record.uploadAttempts >= 3) fail('INVALID_STATE', 409);
          record.operation ||= { id: randomUUID(), tenant_id: context.tenantId, kind: 'EVIDENCE_UPLOAD', state: 'PENDING',
            created_at: at, updated_at: at, resource_ref: { pack_id: 'platform', type: 'evidence', id } };
          record.uploadAttempts++; record.operation.state = 'RUNNING'; delete record.operation.error;
          record.objectKey = storageKey(context, id, 1, token);
          (record.uploadHistory ||= []).push({ attempt: record.uploadAttempts, at, objectKey: record.objectKey, leaseToken: token });
          record.lease = { token, phase: 'UPLOAD', until: new Date(this.now() + 60000).toISOString() };
          this.touch(record);
          return { record, result: { record, write: true, pending: false } };
        });
      if (claim.pending) fail('RECONCILIATION_REQUIRED', 503, true, claim.record.operation.id);
      if (!claim.write) return claim.record.operation;
      try {
        await this.authorize(context, 'evidence.upload', id);
        await this.storage.put(context, claim.record.objectKey, bytes, before.evidence.media_type, before.evidence.sha256);
        await this.authorize(context, 'evidence.upload', id);
        const stored = await boundedBytes(await this.storage.read(context, claim.record.objectKey), byteLimit(before.evidence.media_type));
        await validateContent(stored, before.evidence, contentType);
        await this.authorize(context, 'evidence.upload', id);
        return await this.store.change(context, id, undefined, record => {
          if (!record || record.lease?.token !== token || Date.parse(record.lease.until) <= this.now()) fail('REVISION_CONFLICT', 409);
          record.accepted = true; record.evidence.quarantine_state = 'PENDING_SCAN'; record.operation.state = 'PENDING';
          delete record.lease; this.touch(record);
          return { record, result: record.operation };
        });
      } catch {
        await this.store.change(context, id, undefined, record => {
          if (record?.lease?.token === token) {
            record.operation.state = 'RECONCILIATION_REQUIRED'; this.error(record, 'RECONCILIATION_REQUIRED', true);
            delete record.lease; this.touch(record);
          }
          if (!record) fail('NOT_FOUND', 404);
          return { record, result: undefined };
        }).catch(() => undefined);
        fail('RECONCILIATION_REQUIRED', 503, true, claim.record.operation.id);
      }
    });
  }
  async processNextScan(context: EvidenceContext): Promise<EvidenceOperation | undefined> {
    await this.authorize(context, 'evidence.scan');
    return this.slot(async () => {
      const id = await this.store.candidate(context, new Date(this.now()).toISOString()); if (!id) return;
      await this.authorize(context, 'evidence.scan', id);
      const token = randomUUID();
      const claim = await this.store.change(context, id, undefined, record => {
        if (!record) fail('NOT_FOUND', 404);
        if (!record?.accepted || !['PENDING_SCAN', 'SCAN_FAILED'].includes(record.evidence.quarantine_state) ||
          !['PENDING', 'RUNNING'].includes(record.operation.state) || record.lease && Date.parse(record.lease.until) > this.now() ||
          record.nextAttemptAt && Date.parse(record.nextAttemptAt) > this.now()) {
          return { record, result: { record, scan: false } };
        }
        if (record.scanAttempts >= 3) {
          record.evidence.quarantine_state = 'SCAN_FAILED'; record.operation.state = 'FAILED';
          this.error(record, 'DEPENDENCY_UNAVAILABLE', false); delete record.lease; this.touch(record);
          return { record, result: { record, scan: false } };
        }
        record.scanAttempts++; record.evidence.quarantine_state = 'PENDING_SCAN'; record.evidence.processing_state = 'NOT_STARTED'; record.operation.state = 'RUNNING';
        record.lease = { token, phase: 'SCAN', until: new Date(this.now() + 60000).toISOString() };
        delete record.nextAttemptAt; this.touch(record);
        return { record, result: { record, scan: true } };
      });
      if (!claim.scan) return claim.record?.operation;
      let verdict;
      try {
        const bytes = await boundedBytes(await this.storage.read(context, claim.record.objectKey), byteLimit(claim.record.evidence.media_type));
        await validateContent(bytes, claim.record.evidence, claim.record.evidence.media_type);
        await this.authorize(context, 'evidence.scan', id);
        verdict = await this.scanner.scan(bytes);
        await this.authorize(context, 'evidence.scan', id);
      } catch (cause) {
        verdict = { state: 'SCAN_FAILED' as const, reason: cause instanceof EvidenceError ? cause.code : 'STORAGE_UNAVAILABLE',
          retryable: !(cause instanceof EvidenceError) || cause.retryable };
      }
      return this.store.change(context, id, undefined, record => {
        if (!record || record.lease?.token !== token || Date.parse(record.lease.until) <= this.now() ||
          record.evidence.revision !== claim.record.evidence.revision || record.objectKey !== claim.record.objectKey ||
          record.evidence.sha256 !== claim.record.evidence.sha256) fail('REVISION_CONFLICT', 409);
        record.history.push({ ...verdict, at: new Date(this.now()).toISOString(), attempt: record.scanAttempts,
          sha256: record.evidence.sha256, revision: record.evidence.revision, leaseToken: token, objectKey: record.objectKey });
        record.evidence.quarantine_state = verdict.state;
        if (verdict.state !== 'CLEAN') record.evidence.processing_state = 'NOT_STARTED';
        record.operation.state = verdict.state === 'CLEAN' ? 'SUCCEEDED' : verdict.retryable && record.scanAttempts < 3 ? 'PENDING' : 'FAILED';
        if (verdict.state === 'CLEAN') delete record.operation.error;
        else this.error(record, verdict.retryable ? 'DEPENDENCY_UNAVAILABLE' : 'DRAFT_INVALID', verdict.retryable && record.scanAttempts < 3);
        if (record.operation.state === 'PENDING') record.nextAttemptAt = new Date(this.now() + 1000 * 2 ** (record.scanAttempts - 1) + Math.floor(Math.random() * 250)).toISOString();
        delete record.lease; this.touch(record);
        return { record, result: record.operation };
      });
    });
  }
  async withCleanBytes<T>(context: EvidenceContext, id: string, action: 'evidence.download' | 'extraction.request', use: (bytes: Buffer, recheck: () => Promise<void>) => Promise<T>): Promise<T> {
    await this.authorize(context, action, id);
    return this.slot(async () => {
      const record = await this.store.read(context, id); if (!record) fail('NOT_FOUND', 404);
      if (!record.accepted || record.evidence.quarantine_state !== 'CLEAN') fail('FILE_NOT_CLEAN', 409);
      let bytes: Buffer;
      try {
        bytes = await boundedBytes(await this.storage.read(context, record.objectKey), byteLimit(record.evidence.media_type));
        await validateContent(bytes, record.evidence, record.evidence.media_type);
      } catch (cause) {
        if (cause instanceof EvidenceError && ['CHECKSUM_MISMATCH', 'DRAFT_INVALID', 'UNSUPPORTED_MEDIA_TYPE', 'FILE_TOO_LARGE'].includes(cause.code)) {
          await this.store.change(context, id, undefined, current => {
            if (!current) fail('NOT_FOUND', 404);
            if (current.evidence.revision === record.evidence.revision && current.objectKey === record.objectKey) {
              current.evidence.quarantine_state = 'SCAN_FAILED'; current.evidence.processing_state = 'NOT_STARTED'; current.operation.state = 'RECONCILIATION_REQUIRED';
              this.error(current, cause.code, false); delete current.lease;
              current.history.push({ state: 'SCAN_FAILED', reason: cause.code, retryable: false, at: new Date(this.now()).toISOString(),
                attempt: current.scanAttempts, sha256: current.evidence.sha256, revision: current.evidence.revision });
              this.touch(current);
            }
            return { record: current, result: undefined };
          });
        }
        throw cause;
      }
      const recheck = async () => {
        await this.authorize(context, action, id);
        const current = await this.store.read(context, id);
        if (!current || current.evidence.quarantine_state !== 'CLEAN' || current.evidence.revision !== record.evidence.revision || current.objectKey !== record.objectKey) fail('FILE_NOT_CLEAN', 409);
      };
      await recheck();
      return use(bytes, recheck);
    });
  }
}
