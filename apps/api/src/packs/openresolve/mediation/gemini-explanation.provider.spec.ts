/* SPDX-License-Identifier: MIT */
import { GeminiExplanationProvider } from './gemini-explanation.provider';
import { geminiConfig } from '../../../ai/extraction/provider-config';
import { fail } from '../../../platform/evidence/evidence.types';
import { SelectionInput } from './mediation.types';
const input: SelectionInput = { question: 'Which confirmed evidence is available?', facts: [{ alias: 'F1', code: 'INVOICE', label: 'Supplier', value: 'FICTIONAL Ltd' }], tools: ['case.read_summary'] };
const answer = (output: unknown) => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(output) }] } }], modelVersion: 'gemini-fixture-1', usageMetadata: { totalTokenCount: 120 } });
describe('Gemini extractive boundary (HTTP/model/budget doubles)', () => {
  let transport: jest.Mock, recheck: jest.Mock, config: ReturnType<typeof geminiConfig>;
  beforeEach(() => {
    config = geminiConfig({ GEMINI_API_KEY: 'not-a-real-secret', AI_TIMEOUT_MS: '1000' }); recheck = jest.fn(async () => undefined);
    transport = jest.fn(async (_url, request) => new Response(JSON.stringify(JSON.parse(request.body).generateContentRequest ? { totalTokens: 100 } : answer({ fact_aliases: ['F1'], suggested_tool: 'NONE' }))));
  });
  it('uses closed aliases, retains provenance/usage and rechecks authority at every provider boundary', async () => {
    const result = await new GeminiExplanationProvider(config, transport).select(input, 'SYNTHETIC', recheck);
    expect(result.fact_aliases).toEqual(['F1']); expect(result.provenance.prompt_version).toBe('authorized-case-extractive-v1'); expect(result.usage.reserved_tokens).toBe(4196);
    expect(recheck).toHaveBeenCalledTimes(3); expect(transport).toHaveBeenCalledTimes(2);
    const request = JSON.parse(transport.mock.calls[1][1].body); expect(request.tools).toBeUndefined(); expect(request.generationConfig.responseSchema.properties.fact_aliases.items.enum).toEqual(['F1']);
  });
  it.each([
    { fact_aliases: ['F2'], suggested_tool: 'NONE' }, { fact_aliases: ['F1', 'F1'], suggested_tool: 'NONE' },
    { fact_aliases: ['F1'], suggested_tool: 'payment.transfer' }, { fact_aliases: ['F1'], suggested_tool: 'case.add_note' },
    { fact_aliases: ['F1'], suggested_tool: 'NONE', approved: true }, { fact_aliases: ['F1'], suggested_tool: 'NONE', answer: 'Invented prose' },
  ])('rejects unbound output %j', async output => {
    transport.mockImplementation(async (_url, request) => new Response(JSON.stringify(JSON.parse(request.body).generateContentRequest ? { totalTokens: 100 } : answer(output))));
    await expect(new GeminiExplanationProvider(config, transport).select(input, 'SYNTHETIC', recheck)).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });
  it('denies unapproved disclosure before any remote I/O', async () => {
    await expect(new GeminiExplanationProvider(config, transport).select(input, 'APPROVED_PAID', recheck)).rejects.toMatchObject({ code: 'DISCLOSURE_DENIED' }); expect(transport).not.toHaveBeenCalled();
  });
  it('does not convert revoked authority to a successful fallback', async () => {
    recheck.mockImplementation(async () => fail('FORBIDDEN', 403));
    await expect(new GeminiExplanationProvider(config, transport).select(input, 'SYNTHETIC', recheck)).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(transport).not.toHaveBeenCalled();
  });
  it('does not generate after token-budget rejection', async () => {
    config.maxInputTokens = 50;
    await expect(new GeminiExplanationProvider(config, transport).select(input, 'SYNTHETIC', recheck)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' }); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('returns bounded retry metadata without provider bodies or credentials', async () => {
    transport.mockResolvedValue(new Response('private upstream body', { status: 429, headers: { 'retry-after': '5000000' } }));
    await expect(new GeminiExplanationProvider(config, transport).select(input, 'SYNTHETIC', recheck)).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterSeconds: 86400 });
  });
  it('rejects malformed, oversized and blocked model responses', async () => {
    for (const response of ['{bad', ' '.repeat(65537), JSON.stringify({ ...answer({ fact_aliases: [], suggested_tool: 'NONE' }), promptFeedback: { blockReason: 'SAFETY' } })]) {
      transport.mockImplementation(async (_url, request) => new Response(JSON.parse(request.body).generateContentRequest ? JSON.stringify({ totalTokens: 100 }) : response));
      await expect(new GeminiExplanationProvider(config, transport).select(input, 'SYNTHETIC', recheck)).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    }
  });
  it('rejects tools/functions rather than treating them as text', async () => {
    const value = answer({ fact_aliases: [], suggested_tool: 'NONE' }); value.candidates[0].content.parts = [{ functionCall: { name: 'transfer' } }] as any;
    transport.mockImplementation(async (_url, request) => new Response(JSON.stringify(JSON.parse(request.body).generateContentRequest ? { totalTokens: 100 } : value)));
    await expect(new GeminiExplanationProvider(config, transport).select(input, 'SYNTHETIC', recheck)).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });
});
