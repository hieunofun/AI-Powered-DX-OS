/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { ItemMappingSuggestion, MappingSnapshot } from '../src/packs/openresolve/mapping/mapping.types';
import { PoolClient } from 'pg';
import { MappingStore } from '../src/packs/openresolve/mapping/mapping.repository';
import { MappingRecord } from '../src/packs/openresolve/mapping/mapping.types';
import { EvidenceContext, fail } from '../src/platform/evidence/evidence.types';
import { CommandIdentity } from '../src/platform/evidence/evidence.repository';
export const mappingContext = { tenantId: '00000000-0000-4000-8000-000000000025', subject: 'mapping-fixture-reviewer' };
export function mappingSnapshot(): MappingSnapshot {
  const purchaseOrderId = randomUUID();
  return { tenantId: mappingContext.tenantId, purchaseOrderId, confirmationId: randomUUID(), evidenceId: randomUUID(),
    sourceHash: 'a'.repeat(64), factsHash: 'b'.repeat(64), catalogRevision: 'c'.repeat(64), line: { path: '/lines/0', sku: null, description: 'Hộp mực HP 85A' },
    candidates: [{ id: randomUUID(), tenantId: mappingContext.tenantId, purchaseOrderId, sku: 'CE285A', description: 'Hộp mực laser HP CE285A' },
      { id: randomUUID(), tenantId: mappingContext.tenantId, purchaseOrderId, sku: 'A4-80', description: 'Giấy A4 80gsm' }] };
}
export function mappingSuggestion(snapshot: MappingSnapshot): ItemMappingSuggestion {
  return { state: 'REVIEW_REQUIRED', resolution: 'MATCH', candidates: [{ po_item_id: snapshot.candidates[0].id, confidence: 0.9, reason: 'HP 85A is the CE285A product alias' }],
    method: 'GEMINI', profile_version: 'reviewed-item-mapping-v1', provenance: { provider: 'gemini', model_version: 'gemini-3.8-flash', prompt_version: 'fixture-mapping-prompt', run_id: randomUUID() } };
}
const copy = <T>(value: T): T => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
// In-memory transaction and SQL-boundary doubles; not PostgreSQL acceptance evidence.
export class MemoryMappingStore implements MappingStore {
  records = new Map<string, MappingRecord>();
  commands = new Map<string, { hash: string; id: string; response: unknown }>();
  decisions: any[] = []; outbox: any[] = []; failFinalization = false;
  private queue: Promise<any> = Promise.resolve();
  async read(context: EvidenceContext, id: string) { return copy(this.records.get(context.tenantId + ':' + id)); }
  async operation(context: EvidenceContext, id: string) { return copy([...this.records.values()].find(record => record.tenantId === context.tenantId && record.operation.id === id)); }
  async candidate(context: EvidenceContext, at: string) { return [...this.records.values()].find(record => record.tenantId === context.tenantId &&
    ['PENDING', 'RUNNING'].includes(record.operation.state) && (!record.lease || record.lease.until <= at))?.id; }
  change<T>(context: EvidenceContext, requestedId: string, _evidenceId: string, command: CommandIdentity | undefined,
    work: (record: MappingRecord | undefined, client: PoolClient, replay: boolean, cached?: T) => Promise<{ record: MappingRecord; result: T }>): Promise<T> {
    const job = this.queue.then(async () => {
      const saved = command && this.commands.get(context.tenantId + ':' + command.scope);
      if (saved && saved.hash !== command.hash) fail('IDEMPOTENCY_CONFLICT', 409);
      const id = saved?.id || requestedId, address = context.tenantId + ':' + id, pendingDecisions = [], pendingOutbox = [];
      const client = { query: async (sql: string, args: any[]) => {
        if (sql.startsWith('SELECT payload_hash')) return { rows: this.outbox.filter(row => row.id === args[1] && row.tenant === args[0]).map(row => ({ payload_hash: row.hash })) };
        if (sql.startsWith('INSERT INTO openresolve_mapping_decisions')) pendingDecisions.push(JSON.parse(args[3]));
        else if (sql.startsWith('INSERT INTO openresolve_mapping_outbox')) pendingOutbox.push({ tenant: args[0], id: args[1], hash: args[2], payload: JSON.parse(args[3]) });
        else throw new Error('Unexpected fixture SQL'); return { rows: [] };
      } } as unknown as PoolClient;
      const result = await work(copy(this.records.get(address)), client, Boolean(saved), copy(saved?.response) as T);
      if (this.failFinalization && pendingDecisions.length) throw new Error('Injected finalization failure');
      if (result.record.id !== id || result.record.tenantId !== context.tenantId) throw new Error('Fixture scope mismatch');
      this.records.set(address, copy(result.record)); this.decisions.push(...pendingDecisions); this.outbox.push(...pendingOutbox);
      if (command && !saved) this.commands.set(context.tenantId + ':' + command.scope, { hash: command.hash, id, response: copy(result.result) });
      return copy(result.result);
    });
    this.queue = job.catch(() => undefined); return job;
  }
}
