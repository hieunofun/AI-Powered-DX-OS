/* SPDX-License-Identifier: MIT */
import { PoolClient } from 'pg';
import { EvidenceContext, fail } from '../../../platform/evidence/evidence.types';
import { DraftConfirmation, VerifiedDraftTarget } from '../../../platform/extraction/draft.types';
import { fingerprint } from '../../../platform/evidence/file-safety';
export interface InvoiceBindingAuthorization {
  // Verifies currently permitted tenant/PO/supplier/buyer facts; a document's PO UUID grants no access.
  verify(context: EvidenceContext, payload: Record<string, unknown>): Promise<void>;
}
export class InvoiceDraftTarget implements VerifiedDraftTarget {
  constructor(private readonly binding: InvoiceBindingAuthorization) {
    if (!binding?.verify) throw new Error('Verified invoice binding authorization is required.');
  }
  async authorize(context: EvidenceContext, schemaId: string, payload: unknown): Promise<void> {
    if (schemaId !== 'openresolve.invoice-draft.v1' || !payload || typeof payload !== 'object' || Array.isArray(payload)) fail('INVALID_REQUEST');
    await this.binding.verify(context, payload as Record<string, unknown>);
  }
  async enqueue(client: PoolClient, context: EvidenceContext, confirmation: DraftConfirmation, payload: unknown): Promise<void> {
    const hash = fingerprint(payload);
    const existing = await client.query('SELECT payload_hash FROM platform_verified_draft_outbox WHERE tenant_id=$1 AND confirmation_id=$2', [context.tenantId, confirmation.id]);
    if (existing.rows.length) { if (existing.rows[0].payload_hash !== hash) fail('IDEMPOTENCY_CONFLICT', 409); return; }
    await client.query(`INSERT INTO platform_verified_draft_outbox(tenant_id,confirmation_id,draft_id,created_at,payload_hash,payload)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [context.tenantId, confirmation.id, confirmation.draft_id, confirmation.confirmed_at, hash, JSON.stringify(payload)]);
  }
}
