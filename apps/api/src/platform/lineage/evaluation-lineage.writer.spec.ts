/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { EvaluationLineageWriter } from './evaluation-lineage.writer';
import { ResourceRef } from './lineage.types';
import { context, foreign } from '../../../test/evidence.fixtures';
import { fail } from '../evidence/evidence.types';
describe('evaluation lineage integration boundary (owner/resource doubles)', () => {
  const client = {} as PoolClient, evidenceId = randomUUID(), sha = 'a'.repeat(64);
  let writer: EvaluationLineageWriter, check: jest.Mock, inspect: jest.Mock, append: jest.Mock;
  const from: ResourceRef = { pack_id: 'fixture', type: 'frozen-facts', id: randomUUID() }, to: ResourceRef = { pack_id: 'fixture', type: 'evaluation', id: randomUUID() };
  beforeEach(() => {
    check = jest.fn(async () => undefined); append = jest.fn(async () => undefined);
    inspect = jest.fn(async (_client, _context, ref) => ({ tenantId: context.tenantId, evidenceIds: [evidenceId],
      snapshot: { ref: { id: ref.id, type: ref.type, pack_id: ref.pack_id }, version: '1', sha256: sha, metadata: { source_sha256: sha } } }));
    writer = new EvaluationLineageWriter({ append, watermark: async () => '0', page: async () => [] },
      { detail: async () => ({ sha256: sha } as any) }, { check }, { inspect });
  });
  const capture = () => writer.capture(client, context, evidenceId, from, to, 'EVALUATED_BY', '2026-10-15T00:00:00Z');
  test('resolves persisted versions in the caller transaction and tolerates JSON object key ordering', async () => {
    await capture(); expect(inspect).toHaveBeenCalledWith(client, context, from);
    expect(append).toHaveBeenCalledWith(client, context, evidenceId, [expect.objectContaining({ relation: 'EVALUATED_BY' })]);
    expect(check).toHaveBeenCalledTimes(4);
  });
  test('rejects foreign tenant versions before recording any link', async () => {
    const original = inspect.getMockImplementation(); inspect.mockImplementation(async (...args) => ({ ...await original(...args), tenantId: foreign.tenantId }));
    await expect(capture()).rejects.toMatchObject({ code: 'NOT_FOUND' }); expect(append).not.toHaveBeenCalled();
  });
  test('rejects versions with no persisted source association', async () => {
    const original = inspect.getMockImplementation(); inspect.mockImplementation(async (...args) => ({ ...await original(...args), evidenceIds: [randomUUID()] }));
    await expect(capture()).rejects.toMatchObject({ code: 'NOT_FOUND' }); expect(append).not.toHaveBeenCalled();
  });
  test('source hash mismatch prevents silently relinking new facts to old evidence', async () => {
    const original = inspect.getMockImplementation(); inspect.mockImplementation(async (...args) => {
      const value = await original(...args); value.snapshot.metadata.source_sha256 = 'b'.repeat(64); return value;
    });
    await expect(capture()).rejects.toMatchObject({ code: 'REVISION_CONFLICT' }); expect(append).not.toHaveBeenCalled();
  });
  test('current authority denies unauthorized recording even with valid-looking persisted refs', async () => {
    check.mockImplementation(async () => fail('FORBIDDEN', 403));
    await expect(capture()).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(inspect).not.toHaveBeenCalled(); expect(append).not.toHaveBeenCalled();
  });
});
