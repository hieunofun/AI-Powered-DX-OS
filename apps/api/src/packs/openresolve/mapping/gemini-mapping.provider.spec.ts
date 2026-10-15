/* SPDX-License-Identifier: MIT */
import { geminiConfig } from '../../../ai/extraction/provider-config';
import { LocalProviderBudget } from '../../../ai/extraction/provider-budget';
import { GeminiMappingProvider } from './gemini-mapping.provider';
import { mappingSnapshot } from '../../../../test/mapping.fixtures';
describe('Gemini mapping adapter (transport doubles)', () => {
  const config = () => geminiConfig({ GEMINI_API_KEY: 'synthetic-mapping-key' });
  test('separate semantic prompt carries only identities/descriptions and strict JSON output, no money or credentials in content', async () => {
    const snapshot = mappingSnapshot(), recheck = jest.fn(async () => undefined);
    const transport = jest.fn(async (url: string) => new Response(JSON.stringify(url.endsWith(':countTokens') ? { totalTokens: 100 } : {
      modelVersion: 'gemini-3.8-flash', usageMetadata: { totalTokenCount: 160 }, candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ resolution: 'MATCH', candidates: [{ po_item_id: snapshot.candidates[0].id, reason: 'Equivalent alias', confidence: 0.9 }] }) }] } }],
    })));
    const result = await new GeminiMappingProvider(config(), transport as typeof fetch).suggest(snapshot, 'SYNTHETIC', recheck);
    expect(result).toMatchObject({ state: 'REVIEW_REQUIRED', provenance: { prompt_version: 'reviewed-item-mapping-prompt-v1' }, usage: { reported_total_tokens: 160 } });
    const body = JSON.parse((transport.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(body.tools).toBeUndefined(); expect(JSON.stringify(body.contents)).not.toMatch(/synthetic-mapping-key|unit_price|quantity|tax_rate/);
    expect(JSON.stringify(body.contents)).not.toContain(snapshot.tenantId); expect(JSON.stringify(body.contents)).not.toContain(snapshot.purchaseOrderId);
    expect(recheck).toHaveBeenCalledTimes(3);
  });
  test('full deadline applies when transport ignores abort; ambiguous reservations are not refunded', async () => {
    const limits = { ...config(), timeoutMs: 10 }, budget = new LocalProviderBudget(limits);
    const transport = jest.fn((url: string) => url.endsWith(':countTokens') ? Promise.resolve(new Response('{"totalTokens":100}')) : new Promise<Response>(() => undefined));
    await expect(new GeminiMappingProvider(limits, transport as typeof fetch, budget).suggest(mappingSnapshot(), 'SYNTHETIC', async () => undefined)).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
    expect(budget.snapshot()).toMatchObject({ request_attempts: 2, reserved_tokens: 4196 });
  });
  test('denies paid disclosure before any network call', async () => {
    const transport = jest.fn();
    await expect(new GeminiMappingProvider(config(), transport).suggest(mappingSnapshot(), 'APPROVED_PAID', async () => undefined)).rejects.toMatchObject({ code: 'DISCLOSURE_DENIED' }); expect(transport).not.toHaveBeenCalled();
  });
  test('sanitizes provider errors and does not retry a request', async () => {
    const transport = jest.fn(async () => new Response('synthetic-mapping-key sensitive upstream body', { status: 429, headers: { 'Retry-After': '5' } }));
    const error = await new GeminiMappingProvider(config(), transport).suggest(mappingSnapshot(), 'SYNTHETIC', async () => undefined).catch(cause => cause);
    expect(error).toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterSeconds: 5 }); expect(JSON.stringify(error)).not.toContain('synthetic-mapping-key'); expect(transport).toHaveBeenCalledTimes(1);
  });
});
