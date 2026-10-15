/* SPDX-License-Identifier: MIT */
import { DatabaseService } from '../../../database/database.service';
import { EvidenceAccess, EvidenceContext, fail } from '../../../platform/evidence/evidence.types';
import { contextValid, fingerprint, UUID } from '../../../platform/evidence/file-safety';
import { InvoiceBindingAuthorization } from '../extraction/invoice-draft.target';
import { validateMappingSnapshot } from './mapping-engine';
import { MappingCandidate, MappingSnapshot } from './mapping.types';
export interface AuthorizedPoCatalog {
  // Query current permitted PO items with tenant+PO predicates; never expand to a global vector/catalog search.
  list(context: EvidenceContext, purchaseOrderId: string): Promise<MappingCandidate[]>;
}
export interface ReviewedMappingSource {
  snapshot(context: EvidenceContext, confirmationId: string, linePath: string): Promise<MappingSnapshot>;
}
export class PostgresReviewedMappingSource implements ReviewedMappingSource {
  constructor(private readonly db: Pick<DatabaseService, 'query'>, private readonly access: EvidenceAccess,
    private readonly binding: InvoiceBindingAuthorization, private readonly catalog: AuthorizedPoCatalog) {
    if (!access?.check || !binding?.verify || !catalog?.list) throw new Error('Current source, invoice binding and PO catalog authorization are required.');
  }
  async snapshot(context: EvidenceContext, confirmationId: string, linePath: string): Promise<MappingSnapshot> {
    contextValid(context);
    if (!UUID.test(confirmationId) || typeof linePath !== 'string' || !/^\/lines\/(0|[1-9][0-9]?)(?![\s\S])/.test(linePath)) fail('INVALID_REQUEST');
    const result = await this.db.query(`SELECT data FROM platform_extraction_records WHERE tenant_id=$1 AND data->'confirmation'->>'id'=$2`, [context.tenantId, confirmationId]);
    const record = result.rows[0]?.data; if (!record) fail('NOT_FOUND', 404);
    await this.access.check(context, 'extraction.read', record.evidenceId);
    if (record.tenantId !== context.tenantId || record.schemaId !== 'openresolve.invoice-draft.v1' || record.draft?.state !== 'CONFIRMED' || !record.verifiedPayload) fail('INVALID_STATE', 409);
    const payload = record.verifiedPayload, index = Number(linePath.slice(7)), line = payload.lines?.[index];
    if (!line) fail('NOT_FOUND', 404);
    await this.binding.verify(context, payload);
    const candidates = [...await this.catalog.list(context, payload.purchase_order_id)].sort((left, right) => left.id.localeCompare(right.id));
    const snapshot: MappingSnapshot = { tenantId: context.tenantId, confirmationId, evidenceId: record.evidenceId, sourceHash: record.sourceHash,
      factsHash: fingerprint(payload), purchaseOrderId: payload.purchase_order_id,
      catalogRevision: fingerprint([...candidates].sort((left, right) => left.id.localeCompare(right.id))),
      line: { path: linePath, sku: line.sku ?? null, description: line.description }, candidates };
    validateMappingSnapshot(context, snapshot);
    await this.access.check(context, 'extraction.read', record.evidenceId); return snapshot;
  }
}
