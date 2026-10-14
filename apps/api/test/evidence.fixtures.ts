/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { EvidenceStore, CommandIdentity } from '../src/platform/evidence/evidence.repository';
import { EvidenceContext, EvidenceRecord, EvidenceStorage, fail } from '../src/platform/evidence/evidence.types';
import { checksum } from '../src/platform/evidence/file-safety';
export const context = { tenantId: '00000000-0000-4000-8000-000000000041', subject: 'fixture-member' };
export const foreign = { tenantId: '00000000-0000-4000-8000-000000000042', subject: 'fixture-member' };
export const pdf = Buffer.from('%PDF-1.7\nfixture bytes\n%%EOF');
export const metadata = (bytes: Buffer = pdf, media_type: 'application/pdf' | 'application/xml' = 'application/pdf') => ({
  filename: 'untrusted../file.pdf', media_type, size_bytes: bytes.length, sha256: checksum(bytes),
  source: { kind: 'USER_UPLOAD' as const }, retention_class: 'STANDARD' as const,
});
export const key = () => randomUUID();
export async function* stream(bytes: Buffer) { yield bytes; }
const copy = <T>(value: T): T => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
// Serial transactions and copied snapshots model the repository boundary; not PostgreSQL acceptance.
export class MemoryEvidenceStore implements EvidenceStore {
  records = new Map<string, EvidenceRecord>();
  commands = new Map<string, { hash: string; id: string }>();
  private queue: Promise<any> = Promise.resolve();
  async commandHash(ctx: EvidenceContext, scope: string) { return this.commands.get(ctx.tenantId + ':' + scope)?.hash; }
  async read(ctx: EvidenceContext, id: string) { return copy(this.records.get(ctx.tenantId + ':' + id)); }
  async operation(ctx: EvidenceContext, id: string) {
    return copy([...this.records.values()].find(row => row.evidence.tenant_id === ctx.tenantId && row.operation?.id === id));
  }
  async page(ctx: EvidenceContext, limit: number, before?: { at: string; id: string }) {
    return copy([...this.records.values()].filter(row => row.evidence.tenant_id === ctx.tenantId &&
      (!before || row.evidence.created_at < before.at || row.evidence.created_at === before.at && row.evidence.id < before.id))
      .sort((a, b) => b.evidence.created_at.localeCompare(a.evidence.created_at) || b.evidence.id.localeCompare(a.evidence.id)).slice(0, limit));
  }
  async candidate(ctx: EvidenceContext, now: string) {
    return [...this.records.values()].find(row => row.evidence.tenant_id === ctx.tenantId && row.accepted &&
      ['PENDING_SCAN', 'SCAN_FAILED'].includes(row.evidence.quarantine_state) && ['PENDING', 'RUNNING'].includes(row.operation.state) &&
      (!row.lease || row.lease.until <= now) && (!row.nextAttemptAt || row.nextAttemptAt <= now))?.evidence.id;
  }
  change<T>(ctx: EvidenceContext, requested: string, command: CommandIdentity | undefined,
    work: (record: EvidenceRecord | undefined, replay: boolean) => { record: EvidenceRecord; result: T }): Promise<T> {
    const job = this.queue.then(() => {
      const old = command && this.commands.get(ctx.tenantId + ':' + command.scope);
      if (old && old.hash !== command.hash) fail('IDEMPOTENCY_CONFLICT', 409);
      const id = old ? old.id : requested, address = ctx.tenantId + ':' + id;
      const result = work(copy(this.records.get(address)), Boolean(old));
      if (result.record.evidence.tenant_id !== ctx.tenantId || result.record.evidence.id !== id) throw new Error('Scope mismatch');
      this.records.set(address, copy(result.record));
      if (command && !old) this.commands.set(ctx.tenantId + ':' + command.scope, { hash: command.hash, id });
      return copy(result.result);
    });
    this.queue = job.catch(() => undefined); return job;
  }
}
export class MemoryEvidenceStorage implements EvidenceStorage {
  objects = new Map<string, Buffer>();
  puts = 0; reads = 0;
  async put(_ctx: EvidenceContext, name: string, bytes: Buffer) { this.puts++; this.objects.set(name, Buffer.from(bytes)); }
  async read(_ctx: EvidenceContext, name: string) {
    this.reads++; const bytes = this.objects.get(name); if (!bytes) throw new Error('Missing fixture object');
    return stream(Buffer.from(bytes));
  }
}
