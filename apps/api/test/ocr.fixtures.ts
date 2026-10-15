/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { ExtractionField, ExtractionSuggestion } from '../src/ai/extraction/extraction-provider';
import { invoiceFields } from '../src/packs/openresolve/extraction/invoice-draft.profile';
import { DraftStore } from '../src/platform/extraction/draft.repository';
import { DraftRecord } from '../src/platform/extraction/draft.types';
import { CommandIdentity } from '../src/platform/evidence/evidence.repository';
import { EvidenceContext, EvidenceRecord, fail } from '../src/platform/evidence/evidence.types';
import { MemoryEvidenceStore } from './evidence.fixtures';
export const fixturePo = '00000000-0000-4000-8000-000000000026';
const copy = <T>(value: T): T => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
export const fixtureInvoiceValues = { '/purchase_order_id': fixturePo, '/seller_tax_code': '0123456789', '/buyer_tax_code': '0987654321',
  '/invoice_number': 'SYN-26', '/invoice_date': '2026-10-15', '/currency': 'VND', '/subtotal': '1000000', '/tax_amount': '100000', '/total_amount': '1100000',
  '/lines/0/description': 'Fictional printer cartridge', '/lines/0/sku': 'CE285A', '/lines/0/quantity': '2', '/lines/0/unit_price': '500000',
  '/lines/0/tax_rate': '0.1', '/lines/0/line_subtotal': '1000000', '/lines/0/tax_amount': '100000', '/lines/0/line_total': '1100000' };
export function invoiceSuggestion(evidenceId: string, overrides: Record<string, string | undefined> = {}): ExtractionSuggestion {
  const values = { ...fixtureInvoiceValues, ...overrides };
  const fields: ExtractionField[] = invoiceFields(1).map(field => ({ path: field.path, kind: field.kind,
    status: values[field.path] === undefined ? 'MISSING' : 'EXTRACTED', ...(values[field.path] === undefined ? {} : { value: values[field.path], confidence: 0.9 }),
    source_refs: [{ location_status: 'UNKNOWN', evidence_id: evidenceId, reason: 'PROVIDER_NO_LOCATION' }] }));
  return { evidence_id: evidenceId, schema_id: 'openresolve.invoice-draft.v1', state: 'REVIEW_REQUIRED', fields,
    extractor: { provider: 'gemini', model_version: 'fixture-model', prompt_version: 'fixture-prompt', run_id: randomUUID() }, usage: { input_tokens: 1, reserved_tokens: 2 } };
}
export class MemoryDraftStore implements DraftStore {
  records = new Map<string, DraftRecord>();
  commands = new Map<string, { hash: string; id: string; response: unknown }>();
  outbox: any[] = [];
  enqueueFailure = false;
  private queue: Promise<any> = Promise.resolve();
  constructor(private readonly evidence: MemoryEvidenceStore) {}
  async read(ctx: EvidenceContext, id: string) { return copy(this.records.get(ctx.tenantId + ':' + id)); }
  async operation(ctx: EvidenceContext, id: string) {
    return copy([...this.records.values()].find(row => row.tenantId === ctx.tenantId && (row.operation.id === id || row.confirmation?.operation.id === id)));
  }
  async candidate(ctx: EvidenceContext, at: string) {
    return [...this.records.values()].find(row => row.tenantId === ctx.tenantId && !row.draft && ['PENDING', 'RUNNING'].includes(row.operation.state) &&
      (!row.lease || row.lease.until <= at) && (!row.nextAttemptAt || row.nextAttemptAt <= at))?.id;
  }
  change<T>(ctx: EvidenceContext, requestedId: string, requestedSource: string, command: CommandIdentity | undefined,
    work: (record: DraftRecord | undefined, source: EvidenceRecord, client: PoolClient, replay: boolean, cached?: T) => Promise<{ record: DraftRecord; source?: EvidenceRecord; result: T }>): Promise<T> {
    const job = this.queue.then(async () => {
      const saved = command && this.commands.get(ctx.tenantId + ':' + command.scope);
      if (saved && saved.hash !== command.hash) fail('IDEMPOTENCY_CONFLICT', 409);
      const id = saved?.id || requestedId, address = ctx.tenantId + ':' + id, record = copy(this.records.get(address));
      const evidenceId = record?.evidenceId || requestedSource, source = await this.evidence.read(ctx, evidenceId);
      if (!source) fail('NOT_FOUND', 404);
      const additions: any[] = [];
      const client = { query: async (sql: string, params: any[]) => {
        if (sql.startsWith('SELECT payload_hash')) return { rows: this.outbox.filter(row => row.tenant === params[0] && row.id === params[1]).map(row => ({ payload_hash: row.hash })) };
        if (this.enqueueFailure) throw new Error('Acceptance-only outbox write failure');
        additions.push({ tenant: params[0], id: params[1], draft: params[2], hash: params[4], payload: JSON.parse(params[5]) }); return { rows: [] };
      } } as unknown as PoolClient;
      const result = await work(record, source, client, Boolean(saved), copy(saved?.response) as T);
      if (result.record.id !== id || result.record.tenantId !== ctx.tenantId || result.record.evidenceId !== evidenceId) throw new Error('Fixture scope mismatch');
      this.records.set(address, copy(result.record));
      if (result.source) this.evidence.records.set(ctx.tenantId + ':' + evidenceId, copy(result.source));
      this.outbox.push(...additions);
      if (command && !saved) this.commands.set(ctx.tenantId + ':' + command.scope, { hash: command.hash, id, response: copy(result.result) });
      return copy(result.result);
    });
    this.queue = job.catch(() => undefined); return job;
  }
}
