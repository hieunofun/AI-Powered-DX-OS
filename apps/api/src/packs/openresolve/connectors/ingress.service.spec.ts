/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { ConnectorIngressService } from './ingress.service';
import { AuthorizedOrderSnapshot, SourceKind } from './ingress.types';
import { EvidenceService } from '../../../platform/evidence/evidence.service';
import { fail } from '../../../platform/evidence/evidence.types';
import { MemoryEvidenceStorage, MemoryEvidenceStore } from '../../../../test/evidence.fixtures';
import { MemoryIngressStore } from '../../../../test/connector.fixtures';
describe('durable connector worker (SQL/storage/AV/identity/catalog doubles)', () => {
  let store: MemoryIngressStore, evidenceStore: MemoryEvidenceStore, evidence: EvidenceService, service: ConnectorIngressService, time: number, active: boolean, blocked: boolean;
  let sourceId: string, tenant: string, authority: jest.Mock, scan: jest.Mock, master: AuthorizedOrderSnapshot;
  const sourceContext = () => ({ tenantId: tenant, subject: 'fixture-source-service' }), processor = () => ({ tenantId: tenant, subject: 'fixture-processor' });
  const packet = () => ({ source_event_id: randomUUID(), schema_id: 'openresolve.receiving-sensor.v1', observed_at: new Date(time).toISOString(),
    data: { external_order_id: 'ERP-1', external_item_id: 'LINE-1', device_id: 'SIMULATED-1', sequence: 1, received_quantity: '1', quality: 'ACCEPTED', is_final: true } });
  beforeEach(() => {
    time = Date.now(); tenant = randomUUID(); sourceId = randomUUID(); active = true; blocked = false;
    evidenceStore = new MemoryEvidenceStore(); store = new MemoryIngressStore(evidenceStore);
    authority = jest.fn(async ctx => { if (ctx.tenantId !== tenant || blocked) fail('FORBIDDEN', 403); });
    scan = jest.fn(async () => ({ state: 'CLEAN' as const, retryable: false }));
    evidence = new EvidenceService(evidenceStore, new MemoryEvidenceStorage(), { scan }, { check: authority }, 'fixture-connector-cursor-secret-at-least32bytes', () => time);
    master = { tenantId: tenant, purchaseOrderId: randomUUID(), sourceVersion: 'master-1', externalOrderId: 'ERP-1', supplierRef: 'SUP-1', currency: 'VND',
      lines: [{ id: randomUUID(), externalItemId: 'LINE-1', sku: 'CE285A', orderedQuantity: '2.0000', unitPrice: '500000.0000', taxRate: '0.1000', receivedQuantity: '0.0000' }] };
    service = createService();
  });
  function createService() { return new ConnectorIngressService(store, { resolve: async (ctx, id, kind) => {
    if (ctx.tenantId !== tenant || id !== sourceId) fail('NOT_FOUND', 404);
    if (!active || ctx.subject !== sourceContext().subject) fail('FORBIDDEN', 403);
    return { id, tenantId: tenant, principal: ctx.subject, kind, active, simulated: true };
  } }, { authorize: authority }, evidence, { snapshot: async () => structuredClone(master) },
  { enqueue: async (client, ctx, record, request) => { await client.query('fixture-case', [{ tenant: ctx.tenantId, id: record.id, request }]); } },
  { capture: async (client, ctx, record) => { await client.query('fixture-lineage', [{ tenant: ctx.tenantId, id: record.id }]); } }, () => time); }
  const send = (value = packet(), key = randomUUID(), raw = Buffer.from(JSON.stringify(value))) => service.receive(sourceContext(), sourceId, 'RECEIVING_SENSOR', raw, key);
  test('202 precedes AV/domain work; canonical reencoding retains every raw receipt and original acknowledgement', async () => {
    const input = packet(), key = randomUUID(), first = await send(input, key); expect(first.state).toBe('PENDING'); expect(scan).not.toHaveBeenCalled();
    await send(input, randomUUID(), Buffer.from(JSON.stringify(input, null, 2))); expect(store.receipts.size).toBe(2); expect(store.records.size).toBe(1);
    await service.processNext(processor()); expect(await send(input, key)).toEqual(first);
  });
  test('only current-source grants admit data; raw client tenant claims are rejected', async () => {
    await expect(service.receive({ ...sourceContext(), tenantId: randomUUID() }, sourceId, 'RECEIVING_SENSOR', Buffer.from(JSON.stringify(packet())), randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    active = false; await expect(send()).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(store.records.size).toBe(0);
  });
  test('an actually validated witness precedes a case intent; master quantities remain unchanged', async () => {
    const input = await send(), before = structuredClone(master); await service.processNext(processor()); const detail = await service.detail(sourceContext(), input.resource_ref.id);
    expect(detail).toMatchObject({ simulated: true, operation: { state: 'SUCCEEDED' }, outcome: { reason: 'SHORT_DELIVERY', case_dispatch: 'PENDING' } });
    expect(scan).toHaveBeenCalledTimes(1); expect(store.cases).toHaveLength(1); expect(store.links).toHaveLength(1); expect(master).toEqual(before);
  });
  test('case+lineage finalization failure rolls back, keeps original/witness and retries under a recreated worker', async () => {
    const operation = await send(); store.failAfterLineage = true; await service.processNext(processor());
    const pending = await store.read(processor(), operation.resource_ref.id); expect(pending.operation.state).toBe('PENDING'); expect(pending.outcome).toBeUndefined(); expect(store.cases).toHaveLength(0);
    time += 5000; await createService().processNext(processor()); const completed = await store.read(processor(), operation.resource_ref.id);
    expect(completed.operation.state).toBe('SUCCEEDED'); expect(completed.evidenceId).toBe(pending.evidenceId); expect(store.cases).toHaveLength(1); expect(completed.failures).toHaveLength(1);
  });
  test('conflicting same event ID creates another record and never replaces the first raw bytes', async () => {
    const input = packet(), raw = Buffer.from(JSON.stringify(input)), first = await send(input); await service.processNext(processor());
    input.data.received_quantity = '2'; const second = await send(input); await service.processNext(processor());
    const original = await store.read(processor(), first.resource_ref.id), conflict = await store.read(processor(), second.resource_ref.id);
    expect(await store.bytes(processor(), original)).toEqual(raw); expect(conflict.originalObservationId).toBe(original.id); expect(conflict.outcome.reason).toBe('SOURCE_CONFLICT'); expect(store.records.size).toBe(2);
  });
  test('revoked initiating source cannot be replaced by a processor grant', async () => {
    await send(); active = false; await expect(service.processNext(processor())).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(scan).not.toHaveBeenCalled(); expect(store.cases).toHaveLength(0);
  });
  test('failed AV clearance blocks cases/lineage and remains a retained bounded retry', async () => {
    const operation = await send(); scan.mockResolvedValue({ state: 'SCAN_FAILED', retryable: true } as any); await service.processNext(processor());
    expect((await store.read(processor(), operation.resource_ref.id)).operation.state).toBe('PENDING'); expect(store.cases).toHaveLength(0); expect(store.links).toHaveLength(0);
  });
  test('duplicate worker claims do not duplicate scans or cases', async () => {
    await send(); await Promise.all([service.processNext(processor()), service.processNext(processor())]); expect(scan).toHaveBeenCalledTimes(1); expect(store.cases).toHaveLength(1);
  });
  test('foreign mapped master facts are rejected without a case intent', async () => {
    const operation = await send(); master.tenantId = randomUUID(); await service.processNext(processor());
    expect((await store.read(processor(), operation.resource_ref.id)).operation).toMatchObject({ state: 'FAILED', error: { code: 'NOT_FOUND' } }); expect(store.cases).toHaveLength(0);
  });
  test('the two families cannot silently exchange their schema', async () => {
    await expect(service.receive(sourceContext(), sourceId, 'EXTERNAL_ORDER' as SourceKind, Buffer.from(JSON.stringify(packet())), randomUUID())).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});
