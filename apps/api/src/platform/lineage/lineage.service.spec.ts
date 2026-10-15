/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { LineageService } from './lineage.service';
import { EvidenceLink, LineageStore } from './lineage.types';
import { context, foreign } from '../../../test/evidence.fixtures';
import { fail } from '../evidence/evidence.types';
describe('lineage pages (repository/authority doubles)', () => {
  let time: number, service: LineageService, source: string, rows: { sequence: string; link: EvidenceLink }[], denied: Set<string>;
  let check: jest.Mock, detail: jest.Mock;
  const edge = (tenant = context.tenantId): EvidenceLink => ({ id: randomUUID(), tenant_id: tenant,
    from_ref: { pack_id: 'platform', type: 'extraction-run', id: randomUUID() },
    to_ref: { pack_id: 'platform', type: 'evidence', id: source }, relation: 'DERIVED_FROM', created_at: '2026-10-15T00:00:00.000Z' });
  beforeEach(() => {
    time = Date.now(); source = randomUUID(); denied = new Set(); rows = [1, 2, 3].map(n => ({ sequence: String(n), link: edge() }));
    check = jest.fn(async (_context, _action, ref) => { if (denied.has(ref.id)) fail('FORBIDDEN', 403); });
    detail = jest.fn(async ctx => { if (ctx.tenantId !== context.tenantId) fail('NOT_FOUND', 404); });
    const store: LineageStore = { append: async () => undefined, watermark: async () => String(rows.length),
      page: async (_ctx, _id, after, through, limit) => rows.filter(row => BigInt(row.sequence) > BigInt(after) && BigInt(row.sequence) <= BigInt(through)).slice(0, limit) };
    service = new LineageService(store, { detail }, { check }, 'x'.repeat(32), () => time);
  });
  test('stable committed watermark excludes later links; pages do not duplicate', async () => {
    const first = await service.page(context, source, 2); expect(first.links).toEqual(rows.slice(0, 2).map(row => row.link));
    rows.push({ sequence: '4', link: edge() });
    const second = await service.page(context, source, 2, first.next_cursor);
    expect(second.links).toEqual([rows[2].link]); expect(second.next_cursor).toBeUndefined();
    expect((await service.page(context, source, 100)).links).toHaveLength(4);
  });
  test('unauthorized endpoints are omitted, including the identifier and link ID', async () => {
    denied.add(rows[0].link.from_ref.id);
    const result = await service.page(context, source, 1); expect(result.links).toEqual([]); expect(result.next_cursor).toBeDefined();
    const next = await service.page(context, source, 1, result.next_cursor); expect(next.links).toEqual([rows[1].link]);
    expect(JSON.stringify(next)).not.toContain(rows[0].link.id);
  });
  test('foreign root remains 404 and no graph lookup grants access', async () => {
    await expect(service.page(foreign, source)).rejects.toMatchObject({ code: 'NOT_FOUND' }); expect(check).not.toHaveBeenCalled();
  });
  test('cursor binds tenant, principal, root, signature and expiration', async () => {
    const { next_cursor } = await service.page(context, source, 1);
    for (const [ctx, id, cursor] of [[{ ...context, subject: 'other' }, source, next_cursor], [context, randomUUID(), next_cursor],
      [context, source, next_cursor + 'x']] as const) await expect(service.page(ctx, id, 1, cursor)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    time += 900001; await expect(service.page(context, source, 1, next_cursor)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
  test('current revoked permission invalidates a previously valid cursor', async () => {
    const first = await service.page(context, source, 1); denied.add(source);
    await expect(service.page(context, source, 1, first.next_cursor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  test('mid-page grant revocation prevents sending assembled identifiers', async () => {
    let calls = 0;
    check.mockImplementation(async () => { if (++calls >= 4) fail('FORBIDDEN', 403); });
    await expect(service.page(context, source, 1)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  test('authority outages fail closed rather than silently returning an empty graph', async () => {
    check.mockImplementation(async () => { throw new Error('authority unavailable'); });
    await expect(service.page(context, source)).rejects.toThrow('authority unavailable');
  });
  test.each([0, 101, 1.5, NaN])('rejects invalid page size %s', async limit => {
    await expect(service.page(context, source, limit)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
  test('corrupt foreign-tenant rows are never returned', async () => {
    rows[0].link = edge(foreign.tenantId); await expect(service.page(context, source)).rejects.toThrow('scope mismatch');
  });
});
