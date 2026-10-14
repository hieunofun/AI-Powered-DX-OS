/* SPDX-License-Identifier: MIT */
export interface GeminiConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
  requestsPerMinute: number;
  requestsPerDay: number;
  tokensPerDay: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  allowPaidDocuments: boolean;
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, maximum: number): number {
  const raw = env[key] ?? String(fallback);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(key + ' must be an integer between 1 and ' + maximum + '.');
  }
  return value;
}
export function geminiConfig(env: NodeJS.ProcessEnv): GeminiConfig {
  if (!env.GEMINI_API_KEY?.trim() || /[\r\n]/.test(env.GEMINI_API_KEY)) {
    throw new Error('GEMINI_API_KEY is required for the Gemini adapter.');
  }
  const model = env.GEMINI_MODEL || 'gemini-3.8-flash';
  if (!/^gemini-[a-z0-9.-]{1,80}$/.test(model)) throw new Error('GEMINI_MODEL must be a Gemini model identifier.');
  const policy = env.AI_DOCUMENT_POLICY || 'synthetic-only';
  if (!['synthetic-only', 'approved-paid'].includes(policy)) throw new Error('AI_DOCUMENT_POLICY must be synthetic-only or approved-paid.');
  return {
    apiKey: env.GEMINI_API_KEY.trim(), model,
    timeoutMs: integer(env, 'AI_TIMEOUT_MS', 30000, 120000),
    requestsPerMinute: integer(env, 'AI_REQUESTS_PER_MINUTE', 20, 10000),
    requestsPerDay: integer(env, 'AI_REQUESTS_PER_DAY', 100, 1000000),
    tokensPerDay: integer(env, 'AI_TOKENS_PER_DAY', 100000, 1000000000),
    maxInputTokens: integer(env, 'AI_MAX_INPUT_TOKENS', 8192, 1000000),
    maxOutputTokens: integer(env, 'AI_MAX_OUTPUT_TOKENS', 4096, 65536),
    allowPaidDocuments: policy === 'approved-paid',
  };
}
