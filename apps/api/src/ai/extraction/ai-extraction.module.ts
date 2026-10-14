/* SPDX-License-Identifier: MIT */
import { Module } from '@nestjs/common';
import { AI_EXTRACTION_PROVIDER, DisabledExtractionProvider, ExtractionProvider } from './extraction-provider';
import { GeminiExtractionProvider } from './gemini-extraction.provider';
import { geminiConfig } from './provider-config';

export function createExtractionProvider(env: NodeJS.ProcessEnv = process.env): ExtractionProvider {
  const provider = env.AI_PROVIDER || 'disabled';
  if (provider === 'disabled') return new DisabledExtractionProvider();
  if (provider !== 'gemini') throw new Error('AI_PROVIDER must be disabled or gemini.');
  return new GeminiExtractionProvider(geminiConfig(env));
}

// Not wired to the legacy ingest route. #26/#41 must integrate authorized,
// quarantined evidence and durable draft persistence before exposing OCR.
@Module({ providers: [{ provide: AI_EXTRACTION_PROVIDER, useFactory: () => createExtractionProvider() }],
  exports: [AI_EXTRACTION_PROVIDER] })
export class AiExtractionModule {}
