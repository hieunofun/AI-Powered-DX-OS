/* SPDX-License-Identifier: MIT */
import { exactDecimal, Exact } from '../../../invoices/parsers/invoice-xml-validation';
import { EvidenceContext, fail } from '../../../platform/evidence/evidence.types';
import { contextValid, UUID } from '../../../platform/evidence/file-safety';
import { AuthorizedOrderSnapshot, ExternalOrderData, ReceivingSensorData, SourceObservation } from './ingress.types';
export interface PreviousSensorObservation { deviceId: string; sequence: number; quantity: string; quality: string; observedAt: string; }
export function reconcileObservation(context: EvidenceContext, observation: SourceObservation, order: AuthorizedOrderSnapshot, previous?: PreviousSensorObservation): NonNullable<SourceObservation['outcome']> {
  contextValid(context);
  if (observation.tenantId !== context.tenantId || !order || order.tenantId !== context.tenantId || order.externalOrderId !== observation.event.data.external_order_id) fail('NOT_FOUND', 404);
  if (!UUID.test(order.purchaseOrderId) || typeof order.sourceVersion !== 'string' || !order.sourceVersion || order.sourceVersion.length > 200 ||
    !Array.isArray(order.lines) || order.lines.length > 100 || new Set(order.lines.map(item => item.id)).size !== order.lines.length ||
    new Set(order.lines.map(item => item.externalItemId)).size !== order.lines.length || order.lines.some(item => !UUID.test(item.id))) fail('DEPENDENCY_UNAVAILABLE', 503);
  try {
    for (const line of order.lines) {
      exactDecimal(line.orderedQuantity, 18, 4, true); exactDecimal(line.receivedQuantity, 18, 4);
      exactDecimal(line.unitPrice, 18, 4); exactDecimal(line.taxRate, 7, 4);
      if (new Exact(line.taxRate).gt('1')) throw new Error();
    }
    if (previous) exactDecimal(previous.quantity, 18, 4);
  } catch { fail('DEPENDENCY_UNAVAILABLE', 503); }
  const outcome: NonNullable<SourceObservation['outcome']> = { purchaseOrderId: order.purchaseOrderId, sourceVersion: order.sourceVersion, caseDispatch: 'NONE' };
  const discrepancy = (reason: 'SOURCE_CONFLICT' | 'SHORT_DELIVERY' | 'QUALITY', severity: 'LOW' | 'MEDIUM' | 'HIGH' = 'MEDIUM') => ({ ...outcome, reason, severity, caseDispatch: 'PENDING' as const });
  if (observation.originalObservationId) return discrepancy('SOURCE_CONFLICT', 'HIGH');
  const equal = (left: string, right: string) => {
    try { return new Exact(left).eq(right); } catch { fail('DEPENDENCY_UNAVAILABLE', 503); }
  };
  if (observation.kind === 'EXTERNAL_ORDER') {
    const incoming = observation.event.data as ExternalOrderData;
    if (incoming.supplier_ref !== order.supplierRef || incoming.currency !== order.currency || incoming.lines.length !== order.lines.length) return discrepancy('SOURCE_CONFLICT');
    for (const line of incoming.lines) {
      const local = order.lines.find(item => item.externalItemId === line.external_item_id);
      if (!local || local.sku !== line.sku || !equal(local.orderedQuantity, line.ordered_quantity) || !equal(local.unitPrice, line.unit_price) || !equal(local.taxRate, line.tax_rate)) return discrepancy('SOURCE_CONFLICT');
    }
    return outcome;
  }
  if (observation.kind !== 'RECEIVING_SENSOR') fail('INVALID_REQUEST');
  const incoming = observation.event.data as ReceivingSensorData, local = order.lines.find(item => item.externalItemId === incoming.external_item_id);
  if (!local) return discrepancy('SOURCE_CONFLICT');
  if (previous) {
    if (previous.deviceId !== incoming.device_id || !Number.isSafeInteger(previous.sequence) || !Number.isFinite(Date.parse(previous.observedAt))) fail('DEPENDENCY_UNAVAILABLE', 503);
    if (incoming.sequence < previous.sequence || Date.parse(observation.event.observed_at) < Date.parse(previous.observedAt)) return discrepancy('SOURCE_CONFLICT');
    if (incoming.sequence === previous.sequence) return equal(incoming.received_quantity, previous.quantity) && incoming.quality === previous.quality ? outcome : discrepancy('SOURCE_CONFLICT', 'HIGH');
    if (new Exact(incoming.received_quantity).lt(previous.quantity)) return discrepancy('SOURCE_CONFLICT');
  }
  if (incoming.quality === 'DAMAGED') return discrepancy('QUALITY', 'HIGH');
  if (incoming.quality === 'UNKNOWN') return discrepancy('SOURCE_CONFLICT');
  if (new Exact(incoming.received_quantity).gt(local.orderedQuantity) || new Exact(incoming.received_quantity).lt(local.receivedQuantity)) return discrepancy('SOURCE_CONFLICT');
  if (incoming.is_final && new Exact(incoming.received_quantity).lt(local.orderedQuantity)) return discrepancy('SHORT_DELIVERY');
  return outcome;
}
