/* SPDX-License-Identifier: MIT */
import { Evidence, EvidenceContext } from '../../../platform/evidence/evidence.types';
import { PoolClient } from 'pg';
export type SourceKind = 'EXTERNAL_ORDER' | 'RECEIVING_SENSOR';
export interface SourceRegistration {
  id: string; tenantId: string; principal: string; kind: SourceKind; active: boolean; simulated: boolean;
}
export interface SourceRegistry {
  // Verified service principal + current tenant membership + active source grant. Body source/tenant claims grant nothing.
  resolve(context: EvidenceContext, sourceId: string, kind: SourceKind): Promise<SourceRegistration>;
}
export interface ExternalOrderData {
  external_order_id: string; source_revision: number; supplier_ref: string; currency: string;
  lines: { external_item_id: string; sku: string; description: string; ordered_quantity: string; unit_price: string; tax_rate: string }[];
}
export interface ReceivingSensorData {
  external_order_id: string; external_item_id: string; device_id: string; sequence: number;
  received_quantity: string; quality: 'ACCEPTED' | 'DAMAGED' | 'UNKNOWN'; is_final: boolean;
}
export interface SourceEvent {
  source_event_id: string; schema_id: 'openresolve.external-order.v1' | 'openresolve.receiving-sensor.v1'; observed_at: string;
  data: ExternalOrderData | ReceivingSensorData;
}
export interface IngressOperation {
  id: string; tenant_id: string; kind: 'CONNECTOR_INGRESS'; state: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  created_at: string; updated_at: string; resource_ref: { pack_id: 'openresolve'; type: 'source-observation'; id: string };
  error?: { code: string; message: string; correlation_id: string; retryable: boolean };
}
export interface SourceObservation {
  id: string; tenantId: string; sourceId: string; kind: SourceKind; requestedBy: string; simulated: boolean;
  event: SourceEvent; rawHash: string; contentHash: string; receivedAt: string; originalObservationId?: string;
  operation: IngressOperation; acknowledgement?: IngressOperation; evidenceId?: string; evidenceSha256?: string; attempts: number; nextAttemptAt?: string;
  witnessVersion?: 'source-witness-xml-v1'; correlationId?: string;
  lease?: { token: string; until: string };
  failures?: { attempt: number; at: string; code: string }[];
  outcome?: { purchaseOrderId: string; reason?: 'SOURCE_CONFLICT' | 'SHORT_DELIVERY' | 'QUALITY'; severity?: 'LOW' | 'MEDIUM' | 'HIGH'; caseDispatch: 'NONE' | 'PENDING'; sourceVersion: string };
}
export interface AuthorizedOrderSnapshot {
  tenantId: string; purchaseOrderId: string; sourceVersion: string; externalOrderId: string;
  supplierRef: string; currency: string;
  lines: { id: string; externalItemId: string; sku: string; orderedQuantity: string; unitPrice: string; taxRate: string; receivedQuantity: string }[];
}
export interface ExternalOrderMapping {
  // Resolve registered external references using tenant+source predicates and current PO/resource grants.
  snapshot(context: EvidenceContext, source: SourceRegistration, externalOrderId: string, client?: PoolClient): Promise<AuthorizedOrderSnapshot>;
}
export interface ConnectorCaseTarget {
  // The owning #53 adapter authorizes and durably enqueues this request in the same transaction.
  // A pending intent is not a created/closed case; never materialize PO/GRN/payment state here.
  enqueue(client: PoolClient, context: EvidenceContext, observation: SourceObservation, request: {
    reason: 'SOURCE_CONFLICT' | 'SHORT_DELIVERY' | 'QUALITY'; severity: 'LOW' | 'MEDIUM' | 'HIGH';
    subject_ref: { pack_id: 'openresolve'; type: 'purchase-order'; id: string }; evidence_ids: string[];
  }): Promise<void>;
}
export type ConnectorCaseRequest = Parameters<ConnectorCaseTarget['enqueue']>[3];
export interface ConnectorLineageSink {
  capture(client: PoolClient, context: EvidenceContext, observation: SourceObservation, witness: Evidence, order: AuthorizedOrderSnapshot, caseRequest?: ConnectorCaseRequest, original?: SourceObservation): Promise<void>;
}
