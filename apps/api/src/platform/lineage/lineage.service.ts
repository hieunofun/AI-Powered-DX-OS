/* SPDX-License-Identifier: MIT */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { EvidenceService } from '../evidence/evidence.service';
import { EvidenceContext, EvidenceError, fail } from '../evidence/evidence.types';
import { contextValid, UUID } from '../evidence/file-safety';
import { EvidenceLink, LineageAccess, LineageStore, ResourceRef } from './lineage.types';
const sequence = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
export class LineageService {
  private readonly cursorKey: Buffer;
  constructor(private readonly store: LineageStore, private readonly evidence: Pick<EvidenceService, 'detail'>,
    private readonly access: LineageAccess, private readonly secret: string, private readonly now: () => number = Date.now) {
    if (!access?.check || Buffer.byteLength(secret || '') < 32) throw new Error('Lineage requires current resource authorization and a private cursor secret.');
    this.cursorKey = createHash('sha256').update(secret).digest();
  }
  private encode(value: unknown): string {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.cursorKey, iv);
    cipher.setAAD(Buffer.from('opendx-lineage-cursor-v1'));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [iv, body, cipher.getAuthTag()].map(part => part.toString('base64url')).join('.');
  }
  private decode(cursor: string): any {
    try {
      if (cursor.length > 1024) throw new Error();
      const parts = cursor.split('.');
      if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
      const [iv, body, tag] = parts.map(part => Buffer.from(part, 'base64url'));
      if (iv.length !== 12 || tag.length !== 16) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.cursorKey, iv); decipher.setAAD(Buffer.from('opendx-lineage-cursor-v1')); decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
    } catch { fail('INVALID_REQUEST'); }
  }
  async page(context: EvidenceContext, evidenceId: string, limit = 25, cursor?: string): Promise<{ evidence_id: string; links: EvidenceLink[]; next_cursor?: string }> {
    contextValid(context); if (!UUID.test(evidenceId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_REQUEST');
    await this.evidence.detail(context, evidenceId);
    const root = { pack_id: 'platform', type: 'evidence', id: evidenceId };
    await this.access.check(context, 'lineage.read', root);
    let after = '0', through: string, expires = this.now() + 900000;
    if (cursor !== undefined) {
      if (typeof cursor !== 'string' || cursor.length > 1024) fail('INVALID_REQUEST');
      const value = this.decode(cursor);
      if (!value || value.tenant !== context.tenantId || value.subject !== context.subject || value.evidence !== evidenceId ||
        value.kind !== 'lineage-v1' || !sequence(value.after) || !sequence(value.through) || BigInt(value.after) > BigInt(value.through) ||
        !Number.isSafeInteger(value.expires) || value.expires <= this.now() || value.expires > this.now() + 900000) fail('INVALID_REQUEST');
      ({ after, through, expires } = value);
    } else through = await this.store.watermark(context, evidenceId);
    const rows = await this.store.page(context, evidenceId, after, through, limit + 1), links: EvidenceLink[] = [], disclosed = new Map<string, ResourceRef>();
    for (const row of rows.slice(0, limit)) {
      if (row.link.tenant_id !== context.tenantId) throw new Error('Lineage row scope mismatch.');
      try {
        for (const ref of [row.link.from_ref, row.link.to_ref]) await this.access.check(context, 'resource.read', ref);
        links.push(row.link);
        for (const ref of [row.link.from_ref, row.link.to_ref]) disclosed.set(JSON.stringify(ref), ref);
      } catch (cause) { if (!(cause instanceof EvidenceError) || ![403, 404].includes(cause.getStatus())) throw cause; }
    }
    // Recheck all disclosed refs before sending, including membership revocation while the page was assembled.
    for (const ref of disclosed.values()) await this.access.check(context, 'resource.read', ref);
    await this.access.check(context, 'lineage.read', root);
    if (rows.length <= limit) return { evidence_id: evidenceId, links };
    return { evidence_id: evidenceId, links, next_cursor: this.encode({ kind: 'lineage-v1', tenant: context.tenantId, subject: context.subject, evidence: evidenceId,
      after: rows[limit - 1].sequence, through, expires }) };
  }
}
