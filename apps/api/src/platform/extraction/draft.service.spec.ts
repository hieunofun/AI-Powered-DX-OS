/* SPDX-License-Identifier: MIT */
import { AiProviderError } from '../../ai/extraction/extraction-provider';
import { EvidenceService } from '../evidence/evidence.service';
import { fail } from '../evidence/evidence.types';
import { DraftService } from './draft.service';
import { InvoiceDraftProfile } from '../../packs/openresolve/extraction/invoice-draft.profile';
import { InvoiceDraftTarget } from '../../packs/openresolve/extraction/invoice-draft.target';
import { context, foreign, key, metadata, pdf, stream, MemoryEvidenceStore, MemoryEvidenceStorage } from '../../../test/evidence.fixtures';
import { fixturePo, invoiceSuggestion, MemoryDraftStore } from '../../../test/ocr.fixtures';
describe('durable reviewed drafts (identity/storage/transaction/provider doubles)', () => {
  let evidenceStore: MemoryEvidenceStore, storage: MemoryEvidenceStorage, evidence: EvidenceService, store: MemoryDraftStore, service: DraftService;
  let access: jest.Mock, extract: jest.Mock, binding: jest.Mock, clock: number, sourceId: string;
  const profile = new InvoiceDraftProfile(), request = { schema_id: profile.id, mode: 'OCR' };
  beforeEach(async () => {
    evidenceStore = new MemoryEvidenceStore(); storage = new MemoryEvidenceStorage(); clock = Date.now(); access = jest.fn(async () => undefined);
    evidence = new EvidenceService(evidenceStore, storage, { scan: async () => ({ state: 'CLEAN', retryable: false }) }, { check: access }, 's'.repeat(32), () => clock);
    const registered = await evidence.register(context, metadata(), key()); sourceId = registered.evidence.id;
    await evidence.upload(context, sourceId, stream(pdf), 'application/pdf', key()); await evidence.processNextScan(context);
    store = new MemoryDraftStore(evidenceStore); binding = jest.fn(async (_ctx, value) => { if (value.purchase_order_id !== fixturePo) fail('FORBIDDEN', 403); });
    extract = jest.fn(async () => { const result = invoiceSuggestion(sourceId); return { fields: result.fields, runs: [result] }; });
    service = makeService();
  });
  function makeService() { return new DraftService(store, evidence, { extract }, [profile], { check: access }, new InvoiceDraftTarget({ verify: binding }), () => clock); }
  async function reviewed() { const op = await service.request(context, sourceId, request, key()); await service.processNext(context); return { op, draft: await service.detail(context, op.resource_ref.id) }; }
  const confirmationBody = draft => ({ expected_revision: draft.revision, reviewed_field_paths: profile.requiredPaths(draft.fields) });
  test('request is persisted before provider I/O; source queues and same key returns original operation snapshot', async () => {
    const command = key(), op = await service.request(context, sourceId, request, command);
    expect(op.state).toBe('PENDING'); expect(extract).not.toHaveBeenCalled(); expect(store.records.size).toBe(1);
    expect((await evidenceStore.read(context, sourceId)).evidence.processing_state).toBe('QUEUED');
    await service.processNext(context); expect(await service.request(context, sourceId, request, command)).toEqual(op);
    expect(store.records.size).toBe(1); expect(store.outbox).toHaveLength(0);
  });
  test('non-clean request, client identity and unknown schema do not enqueue', async () => {
    await evidenceStore.change(context, sourceId, undefined, row => { row.evidence.quarantine_state = 'SCAN_FAILED'; row.evidence.processing_state = 'NOT_STARTED'; return { record: row, result: undefined }; });
    await expect(service.request(context, sourceId, request, key())).rejects.toMatchObject({ code: 'FILE_NOT_CLEAN' });
    await expect(service.request(context, sourceId, { ...request, tenant_id: context.tenantId }, key())).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(service.request(context, sourceId, { ...request, schema_id: 'unknown.invoice.v1' }, key())).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(store.records.size).toBe(0); expect(extract).not.toHaveBeenCalled();
  });
  test('foreign IDs and operations are tenant-scoped; action denial precedes provider work', async () => {
    const { op } = await reviewed();
    await expect(service.detail(foreign, op.resource_ref.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await service.operation(foreign, op.id)).toBeUndefined(); access.mockImplementation(async () => fail('FORBIDDEN', 403));
    await expect(service.detail(context, op.resource_ref.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  test('successful extraction preserves original/provenance and does not dispatch matching', async () => {
    const { op, draft } = await reviewed(), row = await store.read(context, op.resource_ref.id);
    expect(draft.state).toBe('REVIEW_REQUIRED'); expect(row.original).toEqual(draft.fields); expect(row.providerRuns).toHaveLength(1);
    expect((await service.operation(context, op.id)).state).toBe('SUCCEEDED'); expect(store.outbox).toHaveLength(0); expect(binding).not.toHaveBeenCalled();
    expect((await evidenceStore.read(context, sourceId)).evidence.processing_state).toBe('REVIEW_REQUIRED');
  });
  test('correction retains original suggestion, server actor/revision and clears uncalibrated confidence', async () => {
    const { draft } = await reviewed(), original = await store.read(context, draft.id);
    const corrected = await service.correct(context, draft.id, { expected_revision: 1, corrections: [{ field_path: '/invoice_number', previous_value: 'SYN-26', new_value: 'REVIEW-26', reason: 'Compared to raw source' }] }, key());
    expect(corrected.revision).toBe(2); expect(corrected.corrections[0]).toMatchObject({ actor_subject: context.subject, revision: 2 });
    expect(corrected.fields.find(field => field.path === '/invoice_number')).toMatchObject({ value: 'REVIEW-26' });
    expect(corrected.fields.find(field => field.path === '/invoice_number').confidence).toBeUndefined(); expect((await store.read(context, draft.id)).original).toEqual(original.original);
  });
  test('missing field is filled without previous_value; supplied invented original is rejected', async () => {
    extract.mockImplementation(async () => { const suggestion = invoiceSuggestion(sourceId, { '/purchase_order_id': undefined }); return { fields: suggestion.fields, runs: [suggestion] }; });
    const { draft } = await reviewed();
    await expect(service.correct(context, draft.id, { expected_revision: 1, corrections: [{ field_path: '/purchase_order_id', previous_value: 'invented', new_value: fixturePo, reason: 'Selected authorized PO' }] }, key())).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const result = await service.correct(context, draft.id, { expected_revision: 1, corrections: [{ field_path: '/purchase_order_id', new_value: fixturePo, reason: 'Selected authorized PO' }] }, key());
    expect(result.corrections[0].previous_value).toBeUndefined(); expect(result.fields.find(field => field.path === '/purchase_order_id').value).toBe(fixturePo);
  });
  test('correction replay returns its original response even after another update', async () => {
    const { draft } = await reviewed(), command = key(), body = { expected_revision: 1, corrections: [{ field_path: '/invoice_number', previous_value: 'SYN-26', new_value: 'A', reason: 'First review' }] };
    const first = await service.correct(context, draft.id, body, command);
    await service.correct(context, draft.id, { expected_revision: 2, corrections: [{ field_path: '/invoice_number', previous_value: 'A', new_value: 'B', reason: 'Second review' }] }, key());
    expect(await service.correct(context, draft.id, body, command)).toEqual(first);
    await expect(service.correct(context, draft.id, { ...body, expected_revision: 3 }, command)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await service.detail(context, draft.id)).revision).toBe(3);
  });
  test('stale revisions, duplicate/unknown paths and client actor are rejected atomically', async () => {
    const { draft } = await reviewed(), item = { field_path: '/invoice_number', previous_value: 'SYN-26', new_value: 'A', reason: 'Review' };
    for (const [body, code] of [
      [{ expected_revision: 2, corrections: [item] }, 'REVISION_CONFLICT'], [{ expected_revision: 1, corrections: [item, item] }, 'INVALID_REQUEST'],
      [{ expected_revision: 1, corrections: [{ ...item, field_path: '/auto_approve' }] }, 'INVALID_REQUEST'],
      [{ expected_revision: 1, corrections: [{ ...item, actor_subject: 'client' }] }, 'INVALID_REQUEST'],
    ] as const) await expect(service.correct(context, draft.id, body, key())).rejects.toMatchObject({ code });
    expect((await service.detail(context, draft.id)).revision).toBe(1);
  });
  test('unreviewed fields or invalid totals prevent confirmation and matching', async () => {
    const { draft } = await reviewed();
    await expect(service.confirm(context, draft.id, { expected_revision: 1, reviewed_field_paths: ['/total_amount'] }, key())).rejects.toMatchObject({ code: 'DRAFT_INVALID' });
    const corrected = await service.correct(context, draft.id, { expected_revision: 1, corrections: [{ field_path: '/total_amount', previous_value: '1100000', new_value: '99999', reason: 'Intentional invalid-total test' }] }, key());
    await expect(service.confirm(context, draft.id, confirmationBody(corrected), key())).rejects.toMatchObject({ code: 'DRAFT_INVALID' }); expect(store.outbox).toHaveLength(0);
  });
  test('binding authorization blocks foreign PO before durable handoff', async () => {
    const { draft } = await reviewed(); binding.mockImplementation(async () => fail('FORBIDDEN', 403));
    await expect(service.confirm(context, draft.id, confirmationBody(draft), key())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(store.outbox).toHaveLength(0); expect((await service.detail(context, draft.id)).state).toBe('REVIEW_REQUIRED');
  });
  test('confirmation snapshot and outbox commit once; retry never creates another matching request', async () => {
    const { draft } = await reviewed(), command = key(), body = confirmationBody(draft);
    const confirmation = await service.confirm(context, draft.id, body, command);
    expect(confirmation.confirmed_revision).toBe(1); expect(confirmation.operation.state).toBe('PENDING'); expect(store.outbox).toHaveLength(1);
    expect(await service.confirm(context, draft.id, body, command)).toEqual(confirmation); expect(store.outbox).toHaveLength(1);
    await expect(service.confirm(context, draft.id, body, key())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect((await evidenceStore.read(context, sourceId)).evidence.processing_state).toBe('CONFIRMED');
    expect((await service.operation(context, confirmation.operation.id)).id).toBe(confirmation.operation.id);
  });
  test('failed outbox write rolls back draft/source/confirmation; same-key retry succeeds', async () => {
    const { draft } = await reviewed(), command = key(), body = confirmationBody(draft); store.enqueueFailure = true;
    await expect(service.confirm(context, draft.id, body, command)).rejects.toThrow('outbox');
    expect(store.outbox).toHaveLength(0); expect((await service.detail(context, draft.id)).state).toBe('REVIEW_REQUIRED');
    expect((await evidenceStore.read(context, sourceId)).evidence.processing_state).toBe('REVIEW_REQUIRED');
    store.enqueueFailure = false; await service.confirm(context, draft.id, body, command); expect(store.outbox).toHaveLength(1);
  });
  test('provider timeout persists bounded retry and original source; recreated worker exhausts at three', async () => {
    const op = await service.request(context, sourceId, request, key()); extract.mockRejectedValue(new AiProviderError('TIMEOUT', true));
    for (let attempt = 1; attempt <= 3; attempt++) {
      service = makeService(); const result = await service.processNext(context);
      expect(result.state).toBe(attempt === 3 ? 'FAILED' : 'PENDING'); expect(await service.processNext(context)).toBeUndefined(); clock += 10000;
    }
    const row = await store.read(context, op.resource_ref.id); expect(row.attempts).toBe(3); expect(row.failures).toHaveLength(3);
    expect(row.draft).toBeUndefined(); expect(storage.objects.size).toBe(1); expect(store.outbox).toHaveLength(0);
  });
  test('stored corruption never reaches extraction and revokes file clearance', async () => {
    await service.request(context, sourceId, request, key());
    const raw = await evidenceStore.read(context, sourceId); storage.objects.set(raw.objectKey, Buffer.concat([pdf, Buffer.from('corrupt')]));
    expect((await service.processNext(context)).state).toBe('FAILED'); expect(extract).not.toHaveBeenCalled();
    expect((await evidenceStore.read(context, sourceId)).evidence).toMatchObject({ quarantine_state: 'SCAN_FAILED', processing_state: 'NOT_STARTED' });
  });
  test('duplicate worker claims produce one provider call', async () => {
    await service.request(context, sourceId, request, key()); await Promise.all([service.processNext(context), service.processNext(context)]); expect(extract).toHaveBeenCalledTimes(1);
  });
  test('expired lease cannot publish a draft', async () => {
    const op = await service.request(context, sourceId, request, key());
    extract.mockImplementation(async () => { clock += 120001; const result = invoiceSuggestion(sourceId); return { fields: result.fields, runs: [result] }; });
    await expect(service.processNext(context)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect((await store.read(context, op.resource_ref.id)).draft).toBeUndefined(); expect(store.outbox).toHaveLength(0);
  });
  test('worker authority cannot replace a revoked initiating user grant', async () => {
    await service.request(context, sourceId, request, key());
    access.mockImplementation(async ctx => { if (ctx.subject === context.subject) fail('FORBIDDEN', 403); });
    await expect(service.processNext({ ...context, subject: 'authorized-service-worker' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(extract).not.toHaveBeenCalled(); expect(store.outbox).toHaveLength(0);
  });
  test('a stale result cannot replace a newer source processing owner', async () => {
    await service.request(context, sourceId, request, key());
    extract.mockImplementation(async () => {
      await evidenceStore.change(context, sourceId, undefined, row => {
        row.evidence.revision++; row.evidence.processing_state = 'QUEUED'; return { record: row, result: undefined };
      });
      const output = invoiceSuggestion(sourceId); return { fields: output.fields, runs: [output] };
    });
    expect((await service.processNext(context)).state).toBe('FAILED');
    expect((await evidenceStore.read(context, sourceId)).evidence.processing_state).toBe('QUEUED');
  });
});
