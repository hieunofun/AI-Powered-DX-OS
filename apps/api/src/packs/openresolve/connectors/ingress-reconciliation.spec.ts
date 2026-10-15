/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { reconcileObservation } from './ingress-reconciliation';
import { AuthorizedOrderSnapshot, SourceObservation } from './ingress.types';
const ctx = { tenantId: '00000000-0000-4000-8000-000000000051', subject: 'connector-fixture' };
describe('source observations propose cases without modifying master facts', () => {
  let order: AuthorizedOrderSnapshot, observation: SourceObservation;
  beforeEach(() => {
    order = { tenantId: ctx.tenantId, purchaseOrderId: randomUUID(), sourceVersion: 'frozen-po-version-1', externalOrderId: 'ERP-PO-1', supplierRef: 'SUP-1', currency: 'VND',
      lines: [{ id: randomUUID(), externalItemId: 'ERP-LINE-1', sku: 'CE285A', orderedQuantity: '2.0000', unitPrice: '500000.0000', taxRate: '0.1000', receivedQuantity: '0.0000' }] };
    const id = randomUUID(), at = '2026-10-15T00:00:00.000Z';
    observation = { id, tenantId: ctx.tenantId, sourceId: randomUUID(), kind: 'RECEIVING_SENSOR', requestedBy: ctx.subject, simulated: true, rawHash: 'a'.repeat(64), contentHash: 'b'.repeat(64), receivedAt: at, attempts: 0,
      operation: { id: randomUUID(), tenant_id: ctx.tenantId, kind: 'CONNECTOR_INGRESS', state: 'RUNNING', created_at: at, updated_at: at, resource_ref: { pack_id: 'openresolve', type: 'source-observation', id } },
      event: { source_event_id: 'counter-1', schema_id: 'openresolve.receiving-sensor.v1', observed_at: at,
        data: { external_order_id: 'ERP-PO-1', external_item_id: 'ERP-LINE-1', device_id: 'device-1', sequence: 2, received_quantity: '1.0000', quality: 'ACCEPTED', is_final: true } } };
  });
  test('final short delivery proposes the existing SHORT_DELIVERY case reason and preserves all PO/receipt facts', () => {
    const before = structuredClone(order), result = reconcileObservation(ctx, observation, order);
    expect(result).toMatchObject({ reason: 'SHORT_DELIVERY', caseDispatch: 'PENDING' }); expect(order).toEqual(before);
  });
  test('nonfinal counts do not prematurely become short delivery or inventory updates', () => {
    (observation.event.data as any).is_final = false; expect(reconcileObservation(ctx, observation, order).caseDispatch).toBe('NONE');
  });
  test('damaged items propose QUALITY; unknown quality and excess counts propose SOURCE_CONFLICT', () => {
    (observation.event.data as any).quality = 'DAMAGED'; expect(reconcileObservation(ctx, observation, order).reason).toBe('QUALITY');
    (observation.event.data as any).quality = 'UNKNOWN'; expect(reconcileObservation(ctx, observation, order).reason).toBe('SOURCE_CONFLICT');
    (observation.event.data as any).quality = 'ACCEPTED'; (observation.event.data as any).received_quantity = '3.0000'; expect(reconcileObservation(ctx, observation, order).reason).toBe('SOURCE_CONFLICT');
  });
  test('foreign tenant or external-order ownership cannot be inferred from an incoming identifier', () => {
    order.tenantId = randomUUID(); expect(() => reconcileObservation(ctx, observation, order)).toThrow('NOT_FOUND');
  });
  test('same device sequence/value is idempotent; a conflicting same sequence remains visible as source conflict', () => {
    const previous = { deviceId: 'device-1', sequence: 2, quantity: '1.0000', quality: 'ACCEPTED', observedAt: observation.event.observed_at };
    expect(reconcileObservation(ctx, observation, order, previous).caseDispatch).toBe('NONE');
    expect(reconcileObservation(ctx, observation, order, { ...previous, quantity: '0.5000' }).reason).toBe('SOURCE_CONFLICT');
  });
  test('reversed sequences and cumulative counter resets require investigation rather than summing measurements', () => {
    const previous = { deviceId: 'device-1', sequence: 3, quantity: '1.5000', quality: 'ACCEPTED', observedAt: observation.event.observed_at };
    expect(reconcileObservation(ctx, observation, order, previous).reason).toBe('SOURCE_CONFLICT');
    expect(reconcileObservation(ctx, observation, order, { ...previous, sequence: 1 }).reason).toBe('SOURCE_CONFLICT');
  });
  test('a different payload under an existing source event ID proposes a conflict without replacing the original', () => {
    observation.originalObservationId = randomUUID(); expect(reconcileObservation(ctx, observation, order)).toMatchObject({ reason: 'SOURCE_CONFLICT', severity: 'HIGH' });
  });
  test('external order must agree exactly on authorized supplier/currency/items/decimal values', () => {
    observation.kind = 'EXTERNAL_ORDER'; observation.event.schema_id = 'openresolve.external-order.v1';
    observation.event.data = { external_order_id: 'ERP-PO-1', source_revision: 1, supplier_ref: 'SUP-1', currency: 'VND', lines: [
      { external_item_id: 'ERP-LINE-1', sku: 'CE285A', description: 'Source wording differs', ordered_quantity: '2', unit_price: '500000', tax_rate: '0.1' }] };
    expect(reconcileObservation(ctx, observation, order).caseDispatch).toBe('NONE');
    observation.event.data.lines[0].unit_price = '500001'; expect(reconcileObservation(ctx, observation, order).reason).toBe('SOURCE_CONFLICT');
  });
});
