/* SPDX-License-Identifier: MIT */
import { EvidenceService } from './evidence.service';
import { EvidenceError, ScanResult, fail } from './evidence.types';
import { boundedBytes, byteLimit, checksum, registration, validateContent } from './file-safety';
import { PrivateEvidenceStorage } from './evidence-storage';
import { context, foreign, key, MemoryEvidenceStorage, MemoryEvidenceStore, metadata, pdf, stream } from '../../../test/evidence.fixtures';

describe('secure evidence boundary (transaction/storage/ACL doubles)', () => {
  let store: MemoryEvidenceStore, storage: MemoryEvidenceStorage, service: EvidenceService;
  let time: number, scan: jest.Mock, access: jest.Mock;
  beforeEach(() => {
    store = new MemoryEvidenceStore(); storage = new MemoryEvidenceStorage(); time = Date.parse('2026-10-14T00:00:00Z');
    scan = jest.fn(async (): Promise<ScanResult> => ({ state: 'CLEAN', retryable: false, engine: 'fixture', definitions: '1' }));
    access = jest.fn(async () => undefined);
    service = new EvidenceService(store, storage, { scan }, { check: access }, 'x'.repeat(32), () => time);
  });
  async function uploaded(bytes = pdf) {
    const registered = await service.register(context, metadata(bytes), key());
    const operation = await service.upload(context, registered.evidence.id, stream(bytes), 'application/pdf', key());
    return { id: registered.evidence.id, operation };
  }
  async function clean() { const item = await uploaded(); await service.processNextScan(context); return item; }
  test('a scoped connector worker can scan its known evidence ID without touching an unrelated queued file', async () => {
    const unrelated = await uploaded(), own = await uploaded();
    access.mockImplementation(async (_ctx, action, id) => { if (action === 'evidence.scan' && id === unrelated.id) fail('FORBIDDEN', 403); });
    await service.processNextScan(context, own.id);
    expect(scan).toHaveBeenCalledTimes(1);
    expect((await store.read(context, own.id)).evidence.quarantine_state).toBe('CLEAN');
    expect((await store.read(context, unrelated.id)).evidence.quarantine_state).toBe('PENDING_SCAN');
  });
  test('register derives identity, 15 minute entitlement and blocked initial states', async () => {
    const result = await service.register(context, metadata(), key());
    expect(result.evidence).toMatchObject({ tenant_id: context.tenantId, created_by: context.subject, revision: 1,
      quarantine_state: 'PENDING_UPLOAD', processing_state: 'NOT_STARTED', legal_hold: false });
    expect(Date.parse(result.upload.expires_at) - time).toBe(900000);
    expect(storage.puts).toBe(0);
  });
  test.each(['tenant_id', 'created_by', 'created_at', 'object_key', 'quarantine_state'])('rejects identity/state property %s', async property => {
    await expect(service.register(context, { ...metadata(), [property]: 'client' }, key())).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(store.records.size).toBe(0);
  });
  test('missing tenant and denied grants perform no persistence/storage work', async () => {
    await expect(service.register({ ...context, tenantId: '' }, metadata(), key())).rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
    access.mockImplementation(async () => fail('FORBIDDEN', 403));
    await expect(service.register(context, metadata(), key())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(store.records.size).toBe(0); expect(storage.puts).toBe(0);
  });
  test('retention policy is checked before persisting a registration', async () => {
    access.mockImplementation(async (_ctx, _action, _id, policy) => { if (policy?.retentionClass === 'RESTRICTED') fail('FORBIDDEN', 403); });
    await expect(service.register(context, { ...metadata(), retention_class: 'RESTRICTED' }, key())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(store.records.size).toBe(0);
  });
  test('foreign and absent UUIDs have identical failures, operation lookup scoped to tenant', async () => {
    const { id, operation } = await uploaded();
    for (const check of [() => service.detail(foreign, id), () => service.detail(context, key()), () => service.operation(foreign, operation.id)]) {
      await expect(check()).rejects.toMatchObject({ code: 'NOT_FOUND', retryable: false });
    }
  });
  test('concurrent same-key registrations persist one evidence; changed payload conflicts', async () => {
    const command = key();
    const results = await Promise.all(Array.from({ length: 8 }, () => service.register(context, metadata(), command)));
    expect(new Set(results.map(item => item.evidence.id)).size).toBe(1); expect(store.records.size).toBe(1);
    await expect(service.register(context, { ...metadata(), filename: 'changed' }, command)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  test('idempotency is scoped by principal and tenant', async () => {
    const command = key();
    const results = await Promise.all([context, foreign, { ...context, subject: 'another-member' }].map(ctx => service.register(ctx, metadata(), command)));
    expect(new Set(results.map(item => item.evidence.id)).size).toBe(3);
  });
  test('accepted bytes are read back, remain blocked until scan, and replay does not write again', async () => {
    const { evidence } = await service.register(context, metadata(), key()), command = key();
    const original = await service.upload(context, evidence.id, stream(pdf), 'application/pdf', command);
    expect(original.state).toBe('PENDING'); expect(storage.reads).toBe(1);
    await expect(service.withCleanBytes(context, evidence.id, 'extraction.request', async () => 'bad')).rejects.toMatchObject({ code: 'FILE_NOT_CLEAN' });
    time += 1000000;
    const replay = await service.upload(context, evidence.id, stream(pdf), 'application/pdf', command);
    expect(replay.id).toBe(original.id); expect(storage.puts).toBe(1);
    await expect(service.upload(context, evidence.id, stream(Buffer.concat([pdf, Buffer.from('changed')])), 'application/pdf', command)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(service.upload(context, evidence.id, stream(pdf), 'application/pdf', key())).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  test('expired fresh upload is rejected before storage', async () => {
    const { evidence } = await service.register(context, metadata(), key()); time += 900001;
    await expect(service.upload(context, evidence.id, stream(pdf), 'application/pdf', key())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(storage.puts).toBe(0);
  });
  test('MIME rejection happens before reading request; checksum mismatch does not persist a job', async () => {
    const { evidence } = await service.register(context, metadata(), key()), read = jest.fn();
    await expect(service.upload(context, evidence.id, { [Symbol.asyncIterator]: read }, 'image/png', key())).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    expect(read).not.toHaveBeenCalled();
    await expect(service.upload(context, evidence.id, stream(Buffer.concat([pdf, Buffer.from('changed')])), 'application/pdf', key())).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    expect((await store.read(context, evidence.id)).operation).toBeUndefined(); expect(storage.puts).toBe(0);
  });
  test('partial storage failure returns uncertain operation; same-key retry recovers without replacing accepted bytes', async () => {
    const { evidence } = await service.register(context, metadata(), key()), command = key();
    const put = jest.spyOn(storage, 'put').mockRejectedValueOnce(new Error('private dependency error'));
    await expect(service.upload(context, evidence.id, stream(pdf), 'application/pdf', command)).rejects.toMatchObject({ code: 'RECONCILIATION_REQUIRED', operationId: expect.any(String) });
    const before = await store.read(context, evidence.id);
    expect(before.accepted).toBe(false); expect(before.operation.state).toBe('RECONCILIATION_REQUIRED');
    const result = await service.upload(context, evidence.id, stream(pdf), 'application/pdf', command);
    expect(result.id).toBe(before.operation.id); expect(put).toHaveBeenCalledTimes(2);
    expect((await store.read(context, evidence.id)).uploadAttempts).toBe(2);
  });
  test('write succeeds but final transaction fails: retry keeps stable operation and fresh immutable attempt key', async () => {
    const { evidence } = await service.register(context, metadata(), key()), command = key();
    const change = store.change.bind(store); let failed = false;
    jest.spyOn(store, 'change').mockImplementation((ctx, id, identity, work) => {
      if (!identity && !failed) { failed = true; return Promise.reject(new Error('DB finalize unavailable')); }
      return change(ctx, id, identity, work);
    });
    await expect(service.upload(context, evidence.id, stream(pdf), 'application/pdf', command)).rejects.toMatchObject({ code: 'RECONCILIATION_REQUIRED' });
    const record = await store.read(context, evidence.id), oldKey = record.objectKey;
    const replay = await service.upload(context, evidence.id, stream(pdf), 'application/pdf', command);
    expect(replay.id).toBe(record.operation.id); expect((await store.read(context, evidence.id)).objectKey).not.toBe(oldKey);
    expect(storage.objects.has(oldKey)).toBe(true);
  });
  test.each(['INFECTED', 'SCAN_FAILED'] as const)('%s blocks download and AI with durable history', async state => {
    const { id } = await uploaded(); scan.mockResolvedValue({ state, reason: 'fixture-alert', retryable: false });
    await service.processNextScan(context); const consume = jest.fn();
    for (const action of ['evidence.download', 'extraction.request'] as const) await expect(service.withCleanBytes(context, id, action, consume)).rejects.toMatchObject({ code: 'FILE_NOT_CLEAN' });
    expect(consume).not.toHaveBeenCalled(); expect((await store.read(context, id)).history).toHaveLength(1);
  });
  test('clean scan permits verified bytes without starting extraction', async () => {
    const { id } = await clean();
    expect(await service.withCleanBytes(context, id, 'extraction.request', async bytes => checksum(bytes))).toBe(checksum(pdf));
    const row = await store.read(context, id); expect(row.operation.state).toBe('SUCCEEDED'); expect(row.evidence.processing_state).toBe('NOT_STARTED');
  });
  test('changed stored bytes revoke CLEAN and cannot reach a consumer', async () => {
    const { id } = await clean(), row = await store.read(context, id), consume = jest.fn();
    storage.objects.set(row.objectKey, Buffer.from('%PDF-1.7\ncorrupted\n%%EOF'));
    await expect(service.withCleanBytes(context, id, 'extraction.request', consume)).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    const revoked = await store.read(context, id); expect(revoked.evidence.quarantine_state).toBe('SCAN_FAILED');
    expect(revoked.operation.state).toBe('RECONCILIATION_REQUIRED'); expect(revoked.history).toHaveLength(2); expect(consume).not.toHaveBeenCalled();
  });
  test('ACL revoked during read denies consumer; later chunk guard also reauthorizes', async () => {
    const { id } = await clean();
    const read = storage.read.bind(storage);
    jest.spyOn(storage, 'read').mockImplementation(async (...args) => { const value = await read(...args); access.mockImplementation(async () => fail('FORBIDDEN', 403)); return value; });
    const consume = jest.fn(); await expect(service.withCleanBytes(context, id, 'evidence.download', consume)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(consume).not.toHaveBeenCalled();
    access.mockImplementation(async () => undefined); jest.restoreAllMocks();
    await expect(service.withCleanBytes(context, id, 'evidence.download', async (_bytes, guard) => {
      access.mockImplementation(async () => fail('FORBIDDEN', 403)); await guard();
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  test('retry counters and due time survive worker recreation, with exactly three attempts', async () => {
    const { id } = await uploaded(); scan.mockResolvedValue({ state: 'SCAN_FAILED', reason: 'TIMEOUT', retryable: true });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await service.processNextScan(context); const row = await store.read(context, id);
      expect(row.scanAttempts).toBe(attempt); expect(row.operation.state).toBe(attempt === 3 ? 'FAILED' : 'PENDING');
      expect(await service.processNextScan(context)).toBeUndefined(); time += 10000;
      service = new EvidenceService(store, storage, { scan }, { check: access }, 'x'.repeat(32), () => time);
    }
    expect(scan).toHaveBeenCalledTimes(3); expect((await store.read(context, id)).history).toHaveLength(3);
  });
  test('expired third lease is exhausted without dispatching a fourth scan', async () => {
    const { id } = await uploaded();
    await store.change(context, id, undefined, row => { row.scanAttempts = 3; row.operation.state = 'RUNNING';
      row.lease = { token: key(), phase: 'SCAN', until: new Date(time - 1).toISOString() }; return { record: row, result: undefined }; });
    expect((await service.processNextScan(context)).state).toBe('FAILED'); expect(scan).not.toHaveBeenCalled();
  });
  test('a stale candidate cannot bypass newly persisted retry backoff', async () => {
    const { id } = await uploaded(); scan.mockResolvedValue({ state: 'SCAN_FAILED', reason: 'TIMEOUT', retryable: true });
    jest.spyOn(store, 'candidate').mockResolvedValue(id);
    await service.processNextScan(context); await service.processNextScan(context);
    expect(scan).toHaveBeenCalledTimes(1); expect((await store.read(context, id)).scanAttempts).toBe(1);
  });
  test('stale scan owner cannot commit clean after lease expiry', async () => {
    const { id } = await uploaded(); scan.mockImplementation(async () => { time += 60001; return { state: 'CLEAN', retryable: false }; });
    await expect(service.processNextScan(context)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect((await store.read(context, id)).evidence.quarantine_state).toBe('PENDING_SCAN');
  });
  test('ACL revoked during scanner I/O prevents CLEAN publication', async () => {
    const { id } = await uploaded(); scan.mockImplementation(async () => {
      access.mockImplementation(async () => fail('FORBIDDEN', 403)); return { state: 'CLEAN', retryable: false };
    });
    expect((await service.processNextScan(context)).state).toBe('FAILED');
    expect((await store.read(context, id)).evidence.quarantine_state).toBe('SCAN_FAILED');
  });
  test('concurrent scans use a single owner', async () => {
    await uploaded(); await Promise.all([service.processNextScan(context), service.processNextScan(context)]);
    expect(scan).toHaveBeenCalledTimes(1);
  });
  test('literal filename/retention search remains tenant-scoped and binds the cursor filters', async () => {
    for (const filename of ['Hóa đơn [1]%.pdf', 'Hóa đơn [2]%.pdf', 'unrelated.pdf']) await service.register(context, { ...metadata(), filename }, key());
    await service.register(foreign, { ...metadata(), filename: 'Hóa đơn [foreign]%.pdf' }, key());
    const first = await service.page(context, 1, undefined, { q: 'HÓA ĐƠN', retentionClass: 'STANDARD' });
    expect(first.items).toHaveLength(1); expect(first.next_cursor).toBeDefined();
    const second = await service.page(context, 1, first.next_cursor, { q: 'HÓA ĐƠN', retentionClass: 'STANDARD' });
    expect(second.items).toHaveLength(1); expect(second.items[0].id).not.toBe(first.items[0].id);
    await expect(service.page(context, 1, first.next_cursor, { q: 'unrelated' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect((await service.page(context, 100, undefined, { q: '%' })).items).toHaveLength(2);
    expect((await service.page(context, 100, undefined, { retentionClass: 'RESTRICTED' })).items).toEqual([]);
  });
  test('cursor tampering and cross-principal reuse fail; pages have no duplicates', async () => {
    for (let i = 0; i < 4; i++) { time++; await service.register(context, metadata(), key()); }
    const first = await service.page(context, 2), second = await service.page(context, 2, first.next_cursor);
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(4); expect(second.next_cursor).toBeUndefined();
    for (const [ctx, cursor] of [[foreign, first.next_cursor], [{ ...context, subject: 'other' }, first.next_cursor], [context, first.next_cursor + 'x']] as const)
      await expect(service.page(ctx, 2, cursor)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
  test('capacity rejects a third blocked reader and releases reservations on errors', async () => {
    const { id } = await clean(); let release: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const first = service.withCleanBytes(context, id, 'evidence.download', async () => blocked);
    const second = service.withCleanBytes(context, id, 'evidence.download', async () => blocked);
    await expect(service.withCleanBytes(context, id, 'evidence.download', async () => undefined)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    release(); await Promise.all([first, second]);
    await expect(service.withCleanBytes(context, id, 'evidence.download', async () => undefined)).resolves.toBeUndefined();
  });
  test('storage adapter rejects cross-tenant and client-controlled paths before I/O', async () => {
    const io = { read: jest.fn(), upload: jest.fn() }, adapter = new PrivateEvidenceStorage(io as any);
    await expect(adapter.read(context, 'tenant/' + foreign.tenantId + '/evidence/' + key() + '/revision/1/content/' + key())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(adapter.read(context, '../../secret')).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(io.read).not.toHaveBeenCalled();
  });
});
describe('bounded file safety', () => {
  test.each(['application/pdf', 'image/png', 'image/jpeg', 'application/xml'])('%s enforces registration ceiling', media_type => {
    expect(() => registration({ ...metadata(), media_type, size_bytes: byteLimit(media_type) + 1 })).toThrow(EvidenceError);
    expect(registration({ ...metadata(), media_type, size_bytes: byteLimit(media_type) }).size_bytes).toBe(byteLimit(media_type));
  });
  test('bounded iterator cancels excess chunks and stalled streams', async () => {
    const close = jest.fn(async () => ({ done: true, value: undefined }));
    const source = { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: Buffer.alloc(11) }), return: close }) };
    await expect(boundedBytes(source, 10)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' }); expect(close).toHaveBeenCalled();
    await expect(boundedBytes({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<any>(() => undefined), return: close }) }, 10, 10)).rejects.toThrow('deadline');
  });
  test.each(['application/pdf', 'image/png', 'image/jpeg', 'application/xml'] as const)('%s validates exact byte ceiling; one byte over fails', async media => {
    const size = byteLimit(media);
    let bytes: Buffer;
    if (media === 'application/xml') bytes = Buffer.from('<a>' + 'x'.repeat(size - 7) + '</a>');
    else {
      bytes = Buffer.alloc(size, 32);
      const prefix = media === 'application/pdf' ? Buffer.from('%PDF-1.7') : media === 'image/png' ? Buffer.from('89504e470d0a1a0a', 'hex') : Buffer.from('ffd8ff', 'hex'); prefix.copy(bytes);
    }
    const input = { ...metadata(bytes), media_type: media };
    await expect(validateContent(bytes, input, media)).resolves.toBeUndefined();
    await expect(validateContent(Buffer.concat([bytes, Buffer.from('x')]), input, media)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });
  test.each(['<a/>', '<?xml version="1.0" encoding="UTF-8"?><invoice><amount>12.00</amount></invoice>'])('validates well-formed XML in a bounded worker: %s', async text => {
    const bytes = Buffer.from(text); await expect(validateContent(bytes, metadata(bytes, 'application/xml'), 'application/xml')).resolves.toBeUndefined();
  });
  test.each(['<!DOCTYPE a [<!ENTITY x SYSTEM "file:///secret">]><a>&x;</a>', '<a><b></a>', '<a>'.repeat(65) + '</a>'.repeat(65), '<a>' + '<b/>'.repeat(10001) + '</a>', '<a>&unknown;</a>'])('blocks unsafe or malformed XML without domain parsing', async text => {
    const bytes = Buffer.from(text); await expect(validateContent(bytes, metadata(bytes, 'application/xml'), 'application/xml')).rejects.toMatchObject({ code: 'DRAFT_INVALID' });
  });
  test('rejects binary UTF-8 and forged media magic', async () => {
    const bytes = Buffer.from([60, 97, 62, 255]);
    await expect(validateContent(bytes, metadata(bytes, 'application/xml'), 'application/xml')).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    await expect(validateContent(Buffer.from('not pdf'), metadata(Buffer.from('not pdf')), 'application/pdf')).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
  });
  test('rejects conflicting XML encoding and invalid character references', async () => {
    const encoded = Buffer.from('<?xml version="1.0" encoding="UTF-16"?><a/>');
    await expect(validateContent(encoded, metadata(encoded, 'application/xml'), 'application/xml')).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    for (const text of ['<a>&#0;</a>', '<a>&#xD800;</a>', '<a>&#1114112;</a>']) {
      const bytes = Buffer.from(text); await expect(validateContent(bytes, metadata(bytes, 'application/xml'), 'application/xml')).rejects.toMatchObject({ code: 'DRAFT_INVALID' });
    }
  });
});
