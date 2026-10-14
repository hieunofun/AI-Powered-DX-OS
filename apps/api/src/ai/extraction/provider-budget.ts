/* SPDX-License-Identifier: MIT */
import { AiProviderError } from './extraction-provider';
import { GeminiConfig } from './provider-config';

export interface ProviderBudget {
  consumeRequest(): void;
  reserveTokens(tokens: number): void;
}

// One adapter/worker instance. Distributed/durable budgeting is a separate
// integration gate; callers may replace this port with an atomic shared store.
export class LocalProviderBudget implements ProviderBudget {
  private minute = -1;
  private day = -1;
  private minuteRequests = 0;
  private dayRequests = 0;
  private dayTokens = 0;
  constructor(private readonly config: GeminiConfig, private readonly now: () => number = Date.now) {}
  private windows(): number {
    const time = this.now();
    const day = Math.floor(time / 86400000), minute = Math.floor(time / 60000);
    if (day !== this.day) { this.day = day; this.dayRequests = 0; this.dayTokens = 0; }
    if (minute !== this.minute) { this.minute = minute; this.minuteRequests = 0; }
    return time;
  }
  consumeRequest(): void {
    const time = this.windows();
    if (this.dayRequests >= this.config.requestsPerDay) throw new AiProviderError('BUDGET_EXCEEDED');
    if (this.minuteRequests >= this.config.requestsPerMinute) {
      throw new AiProviderError('RATE_LIMITED', true, Math.ceil((60000 - time % 60000) / 1000));
    }
    this.minuteRequests++; this.dayRequests++;
  }
  reserveTokens(tokens: number): void {
    this.windows();
    if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > this.config.tokensPerDay - this.dayTokens) {
      throw new AiProviderError('BUDGET_EXCEEDED');
    }
    // No refund on timeout/invalid output: an ambiguous remote call may be billed.
    this.dayTokens += tokens;
  }
}
