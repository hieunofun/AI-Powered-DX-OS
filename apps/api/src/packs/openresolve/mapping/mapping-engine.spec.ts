/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { AiProviderError } from '../../../ai/extraction/extraction-provider';
import { fail } from '../../../platform/evidence/evidence.types';
import { ReviewedMappingEngine } from './mapping-engine';
import { mappingContext as ctx, mappingSnapshot, mappingSuggestion } from '../../../../test/mapping.fixtures';
describe('reviewed item mapping (provider/authority doubles)', () => {
  let snapshot: ReturnType<typeof mappingSnapshot>, suggest: jest.Mock, recheck: jest.Mock, engine: ReviewedMappingEngine;
  beforeEach(() => { snapshot = mappingSnapshot(); suggest = jest.fn(async () => mappingSuggestion(snapshot)); recheck = jest.fn(async () => undefined); engine = new ReviewedMappingEngine({ suggest }); });
  const run = () => engine.suggest(ctx, snapshot, 'SYNTHETIC', recheck);
  test('an alias suggestion remains REVIEW_REQUIRED with no financial arithmetic or authoritative assignment', async () => {
    const result = await run(); expect(result).toMatchObject({ state: 'REVIEW_REQUIRED', resolution: 'MATCH', method: 'GEMINI' });
    expect(recheck).toHaveBeenCalledTimes(2); expect(suggest).toHaveBeenCalledTimes(1);
  });
  test('unique exact SKU preserves deterministic behavior without model I/O or invented confidence', async () => {
    snapshot.line.sku = 'ce285a'; const result = await run(); expect(result).toMatchObject({ resolution: 'MATCH', method: 'DETERMINISTIC' });
    expect(result.candidates[0].confidence).toBeUndefined(); expect(suggest).not.toHaveBeenCalled();
  });
  test('duplicate exact SKU is ambiguous and a model cannot break the tie', async () => {
    snapshot.line.sku = 'CE285A'; snapshot.candidates.push({ ...snapshot.candidates[0], id: randomUUID() });
    const result = await run(); expect(result.resolution).toBe('AMBIGUOUS'); expect(result.candidates).toHaveLength(2); expect(suggest).not.toHaveBeenCalled();
  });
  test('duplicate catalog identities remain ambiguous even if the model returns one alias at high confidence', async () => {
    snapshot.candidates.push({ ...snapshot.candidates[0], id: randomUUID() });
    const result = await run(); expect(result.resolution).toBe('AMBIGUOUS'); expect(result.candidates).toHaveLength(2);
  });
  test.each(['tenant', 'po', 'duplicate-id'])('rejects invalid candidate scope %s before any provider work', async kind => {
    if (kind === 'tenant') snapshot.candidates[0].tenantId = randomUUID();
    if (kind === 'po') snapshot.candidates[0].purchaseOrderId = randomUUID();
    if (kind === 'duplicate-id') snapshot.candidates.push(snapshot.candidates[0]);
    await expect(run()).rejects.toMatchObject({ code: kind === 'duplicate-id' ? 'INVALID_REQUEST' : 'NOT_FOUND' }); expect(suggest).not.toHaveBeenCalled();
  });
  test('foreign model candidate is discarded and its identifier is never disclosed by fallback', async () => {
    const value = mappingSuggestion(snapshot), foreignId = randomUUID(); value.candidates[0].po_item_id = foreignId; suggest.mockResolvedValue(value);
    const result = await run(); expect(result).toMatchObject({ resolution: 'UNKNOWN', method: 'DETERMINISTIC_FALLBACK', provider_failure: { code: 'INVALID_OUTPUT' } });
    expect(JSON.stringify(result)).not.toContain(foreignId);
  });
  test.each(['TIMEOUT', 'RATE_LIMITED', 'BUDGET_EXCEEDED', 'NOT_CONFIGURED'] as const)('%s preserves deterministic fallback without inventing a candidate', async code => {
    suggest.mockRejectedValue(new AiProviderError(code, true)); const result = await run();
    expect(result).toMatchObject({ resolution: 'UNKNOWN', candidates: [], provider_failure: { code } });
  });
  test('current authorization denial cannot become a successful fallback', async () => {
    recheck.mockImplementation(async () => fail('FORBIDDEN', 403));
    await expect(run()).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(suggest).not.toHaveBeenCalled();
  });
  test('revocation after provider output prevents returning a suggestion', async () => {
    recheck.mockResolvedValueOnce(undefined).mockImplementation(async () => fail('FORBIDDEN', 403));
    await expect(run()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  test('oversized catalogs fail before model dispatch rather than silently omitting candidate identities', async () => {
    snapshot.candidates = Array.from({ length: 41 }, () => ({ ...snapshot.candidates[0], id: randomUUID() }));
    await expect(run()).rejects.toMatchObject({ code: 'INVALID_REQUEST' }); expect(suggest).not.toHaveBeenCalled();
  });
});
