/* SPDX-License-Identifier: MIT */
import * as legacy from '../../ai/extraction/extraction-provider';
import * as core from '../../platform/extraction/provider.port';
describe('neutral provider port compatibility', () => {
  it('retains existing injection symbol and error constructor identity across old/new imports', () => {
    expect(legacy.AI_EXTRACTION_PROVIDER).toBe(core.AI_EXTRACTION_PROVIDER);
    expect(legacy.AiProviderError).toBe(core.AiProviderError);
    expect(new legacy.AiProviderError('NOT_CONFIGURED')).toBeInstanceOf(core.AiProviderError);
  });
  it('the disabled provider remains closed and returns no fabricated extraction', async () => {
    await expect(new legacy.DisabledExtractionProvider().extract(undefined)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });
});
