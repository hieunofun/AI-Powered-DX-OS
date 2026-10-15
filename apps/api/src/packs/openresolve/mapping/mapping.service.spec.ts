/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { AiProviderError } from '../../../ai/extraction/extraction-provider';
import { EvidenceService } from '../../../platform/evidence/evidence.service';
import { fail } from '../../../platform/evidence/evidence.types';
import { ReviewedMappingService } from './mapping.service';
import { ReviewedMappingEngine } from './mapping-engine';
import { PostgresMappingOutbox } from './mapping-outbox.target';
import { mappingContext as ctx, mappingSnapshot, mappingSuggestion, MemoryMappingStore } from '../../../../test/mapping.fixtures';
describe('durable reviewed mapping (identity/storage/catalog/transaction/provider doubles)', () => {
  let service: ReviewedMappingService, store: MemoryMappingStore, snapshot: ReturnType<typeof mappingSnapshot>, suggest: jest.Mock, check: jest.Mock, clean: boolean, time: number;
  const key = () => randomUUID();
  beforeEach(() => {
    snapshot = mappingSnapshot(); store = new MemoryMappingStore(); clean = true; time = Date.now();
    suggest = jest.fn(async () => mappingSuggestion(snapshot)); check = jest.fn(async () => undefined);
    const evidence = { detail: async () => ({ quarantine_state: clean ? 'CLEAN' : 'SCAN_FAILED', sha256: snapshot.sourceHash }),
      withCleanBytes: async (_context, _id, _action, work) => { if (!clean) fail('FILE_NOT_CLEAN', 409); return work(Buffer.from('fixture'), async () => { if (!clean) fail('FILE_NOT_CLEAN', 409); }); } } as unknown as EvidenceService;
    service = new ReviewedMappingService(store, { snapshot: async () => structuredClone(snapshot) }, evidence, { check },
      new ReviewedMappingEngine({ suggest }), { resolve: async () => 'SYNTHETIC' }, new PostgresMappingOutbox({ check: async () => undefined }), () => time);
  });
  const request = (command = key()) => service.request(ctx, snapshot.confirmationId, { line_path: snapshot.line.path }, command);
  async function ready() { const operation = await request(); await service.processNext(ctx); return service.detail(ctx, operation.resource_ref.id); }
  const decision = (record: Awaited<ReturnType<typeof ready>>, selected = snapshot.candidates[0].id) => ({ expected_revision: record.revision, selected_po_item_id: selected, reason: 'Inspected authorized original and catalog' });
  test('durable request precedes provider work and replay returns the original pending snapshot after processing', async () => {
    const command = key(), first = await request(command); expect(first.state).toBe('PENDING'); expect(suggest).not.toHaveBeenCalled();
    await service.processNext(ctx); expect((await request(command))).toEqual(first); expect(store.records.size).toBe(1);
  });
  test('high model confidence never creates a decision or dispatch without explicit human confirmation', async () => {
    const record = await ready(); expect(record.suggestion.state).toBe('REVIEW_REQUIRED'); expect(store.decisions).toHaveLength(0); expect(store.outbox).toHaveLength(0);
  });
  test('server actor and immutable source/catalog hashes are recorded with one durable handoff', async () => {
    const record = await ready(), before = structuredClone(record.suggestion), command = key(), body = decision(record);
    const result = await service.confirm(ctx, record.id, body, command);
    expect(result).toMatchObject({ actor_subject: ctx.subject, origin: 'SUGGESTION', dispatch_state: 'PENDING', source_sha256: snapshot.sourceHash });
    expect(await service.confirm(ctx, record.id, body, command)).toEqual(result); expect(store.outbox).toHaveLength(1); expect(store.decisions).toHaveLength(1);
    expect((await service.detail(ctx, record.id)).suggestion).toEqual(before);
  });
  test('a manual authorized alternative records its origin and reason; rejection enqueues nothing', async () => {
    const record = await ready(); expect((await service.confirm(ctx, record.id, decision(record, snapshot.candidates[1].id), key())).origin).toBe('MANUAL');
    const next = await ready(); const result = await service.confirm(ctx, next.id, { ...decision(next), selected_po_item_id: null }, key());
    expect(result).toMatchObject({ origin: 'REJECTED', dispatch_state: 'NONE' }); expect(store.outbox).toHaveLength(1);
  });
  test('stale revision and foreign selected candidate cannot write any decision', async () => {
    const record = await ready();
    await expect(service.confirm(ctx, record.id, { ...decision(record), expected_revision: 1 }, key())).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(service.confirm(ctx, record.id, decision(record, randomUUID()), key())).rejects.toMatchObject({ code: 'NOT_FOUND' }); expect(store.decisions).toHaveLength(0);
  });
  test('changed catalog prevents confirming a stale suggestion', async () => {
    const record = await ready(); snapshot.catalogRevision = 'd'.repeat(64);
    await expect(service.confirm(ctx, record.id, decision(record), key())).rejects.toMatchObject({ code: 'REVISION_CONFLICT' }); expect(store.outbox).toHaveLength(0);
  });
  test('finalization failure rolls back decision/outbox/revision and same key may retry safely', async () => {
    const record = await ready(), body = decision(record), command = key(); store.failFinalization = true;
    await expect(service.confirm(ctx, record.id, body, command)).rejects.toThrow('Injected finalization');
    expect(store.decisions).toHaveLength(0); expect(store.outbox).toHaveLength(0); expect((await service.detail(ctx, record.id)).revision).toBe(record.revision);
    store.failFinalization = false; await service.confirm(ctx, record.id, body, command); expect(store.outbox).toHaveLength(1);
  });
  test('foreign IDs are generic 404 and client actor cannot be recorded', async () => {
    const record = await ready();
    await expect(service.detail({ ...ctx, tenantId: randomUUID() }, record.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.confirm(ctx, record.id, { ...decision(record), actor_subject: 'admin' }, key())).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
  test('revoke the initiating user before worker dispatch: no provider or automatic action', async () => {
    await request(); check.mockImplementation(async () => fail('FORBIDDEN', 403));
    await expect(service.processNext(ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(suggest).not.toHaveBeenCalled();
  });
  test('actual-byte clearance is required again before a human decision', async () => {
    const record = await ready(); clean = false;
    await expect(service.confirm(ctx, record.id, decision(record), key())).rejects.toMatchObject({ code: 'FILE_NOT_CLEAN' }); expect(store.outbox).toHaveLength(0);
  });
  test('duplicate worker claims call the provider once', async () => {
    await request(); await Promise.all([service.processNext(ctx), service.processNext(ctx)]); expect(suggest).toHaveBeenCalledTimes(1);
  });
  test('timeout persists an explicit fallback; only a recorded human can select a candidate', async () => {
    suggest.mockRejectedValue(new AiProviderError('TIMEOUT', true)); const record = await ready();
    expect(record.suggestion).toMatchObject({ resolution: 'UNKNOWN', provider_failure: { code: 'TIMEOUT' } }); expect(store.outbox).toHaveLength(0);
    expect((await service.confirm(ctx, record.id, decision(record), key())).origin).toBe('MANUAL');
  });
  test('expired worker cannot publish late output', async () => {
    await request(); suggest.mockImplementation(async () => { time += 120001; return mappingSuggestion(snapshot); });
    await expect(service.processNext(ctx)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect([...store.records.values()][0].suggestion).toBeUndefined();
  });
});
