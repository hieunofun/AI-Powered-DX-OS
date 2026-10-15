/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { EvidenceContext, fail } from '../src/platform/evidence/evidence.types';
import { CommandIdentity } from '../src/platform/evidence/evidence.repository';
import { IngressStore } from '../src/packs/openresolve/connectors/ingress.repository';
import { IngressOperation, SourceEvent, SourceObservation, SourceRegistration, ReceivingSensorData } from '../src/packs/openresolve/connectors/ingress.types';
import { PreviousSensorObservation } from '../src/packs/openresolve/connectors/ingress-reconciliation';
import { MemoryEvidenceStore } from './evidence.fixtures';
const copy = <T>(value: T): T => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
// Serial in-memory transactions, storage and SQL boundaries are doubles, not PostgreSQL acceptance.
export class MemoryIngressStore implements IngressStore {
  records = new Map<string, SourceObservation>(); receipts = new Map<string, Buffer>();
  commands = new Map<string, { hash: string; id: string; response: IngressOperation }>();
  cases: any[] = []; links: any[] = []; failAfterLineage = false;
  private queue: Promise<any> = Promise.resolve();
  constructor(private readonly evidence: MemoryEvidenceStore) {}
  private serial<T>(work: () => Promise<T>): Promise<T> { const job = this.queue.then(work); this.queue = job.catch(() => undefined); return job; }
  async read(ctx: EvidenceContext, id: string) { return copy(this.records.get(ctx.tenantId + ':' + id)); }
  async operation(ctx: EvidenceContext, id: string) { return copy([...this.records.values()].find(record => record.tenantId === ctx.tenantId && record.operation.id === id)); }
  async bytes(ctx: EvidenceContext, record: SourceObservation) {
    if (record.tenantId !== ctx.tenantId) fail('NOT_FOUND', 404);
    const bytes = this.receipts.get([ctx.tenantId, record.sourceId, record.event.source_event_id, record.rawHash].join(':'));
    if (!bytes) fail('NOT_FOUND', 404); return Buffer.from(bytes);
  }
  async candidate(ctx: EvidenceContext, at: string) { return [...this.records.values()].find(record => record.tenantId === ctx.tenantId &&
    ['PENDING', 'RUNNING'].includes(record.operation.state) && (!record.lease || record.lease.until <= at) && (!record.nextAttemptAt || record.nextAttemptAt <= at))?.id; }
  accept(ctx: EvidenceContext, source: SourceRegistration, parsed: { event: SourceEvent; rawHash: string; contentHash: string }, bytes: Buffer, command: CommandIdentity, receivedAt: string, correlationId?: string): Promise<IngressOperation> {
    return this.serial(async () => {
      const scope = ctx.tenantId + ':' + command.scope, saved = this.commands.get(scope);
      if (saved && saved.hash !== command.hash) fail('IDEMPOTENCY_CONFLICT', 409);
      const sameEvent = [...this.records.values()].filter(record => record.tenantId === ctx.tenantId && record.sourceId === source.id && record.event.source_event_id === parsed.event.source_event_id);
      let record = sameEvent.find(record => record.contentHash === parsed.contentHash);
      if (!record) {
        const id = randomUUID(), operation: IngressOperation = { id: randomUUID(), tenant_id: ctx.tenantId, kind: 'CONNECTOR_INGRESS', state: 'PENDING', created_at: receivedAt, updated_at: receivedAt, resource_ref: { pack_id: 'openresolve', type: 'source-observation', id } };
        record = { id, tenantId: ctx.tenantId, sourceId: source.id, kind: source.kind, requestedBy: ctx.subject, simulated: source.simulated,
          event: parsed.event, rawHash: parsed.rawHash, contentHash: parsed.contentHash, receivedAt, operation, acknowledgement: copy(operation), attempts: 0,
          witnessVersion: 'source-witness-xml-v1', correlationId: correlationId || randomUUID(), ...(sameEvent.length ? { originalObservationId: sameEvent[0].id } : {}) };
        this.records.set(ctx.tenantId + ':' + id, copy(record));
      }
      this.receipts.set([ctx.tenantId, source.id, parsed.event.source_event_id, parsed.rawHash].join(':'), Buffer.from(bytes));
      if (!saved) this.commands.set(scope, { hash: command.hash, id: record.id, response: copy(record.acknowledgement) });
      return copy(saved?.response || record.acknowledgement);
    });
  }
  change<T>(ctx: EvidenceContext, id: string, work: (record: SourceObservation, client: PoolClient) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      const record = await this.read(ctx, id); if (!record) fail('NOT_FOUND', 404);
      const pendingCases = [], pendingLinks = [];
      const client = { query: async (sql: string, args: any[]) => {
        if (sql.startsWith('SELECT data FROM platform_evidence_records')) { const data = await this.evidence.read({ ...ctx, tenantId: args[0] }, args[1]); return { rows: data ? [{ data }] : [] }; }
        if (sql === 'fixture-case') { pendingCases.push(copy(args[0])); return { rows: [] }; }
        if (sql === 'fixture-lineage') { pendingLinks.push(copy(args[0])); if (this.failAfterLineage) { this.failAfterLineage = false; throw new Error('Injected SQL boundary failure'); } return { rows: [] }; }
        throw new Error('Unexpected fixture SQL');
      } } as unknown as PoolClient;
      const result = await work(record, client);
      if (record.tenantId !== ctx.tenantId || record.id !== id) throw new Error('Fixture scope mismatch');
      this.records.set(ctx.tenantId + ':' + id, copy(record)); this.cases.push(...pendingCases); this.links.push(...pendingLinks); return copy(result);
    });
  }
  async previousSensor(_client: PoolClient, ctx: EvidenceContext, current: SourceObservation): Promise<PreviousSensorObservation | undefined> {
    const input = current.event.data as ReceivingSensorData;
    const records = [...this.records.values()].filter(row => row.tenantId === ctx.tenantId && row.sourceId === current.sourceId && row.id !== current.id && row.kind === 'RECEIVING_SENSOR' &&
      row.operation.state === 'SUCCEEDED' && row.outcome?.reason !== 'SOURCE_CONFLICT' && (row.event.data as ReceivingSensorData).device_id === input.device_id &&
      row.event.data.external_order_id === input.external_order_id && (row.event.data as ReceivingSensorData).external_item_id === input.external_item_id);
    records.sort((a, b) => (b.event.data as ReceivingSensorData).sequence - (a.event.data as ReceivingSensorData).sequence);
    if (!records.length) return;
    const data = records[0].event.data as ReceivingSensorData;
    return { deviceId: data.device_id, sequence: data.sequence, quantity: data.received_quantity, quality: data.quality, observedAt: records[0].event.observed_at };
  }
}
