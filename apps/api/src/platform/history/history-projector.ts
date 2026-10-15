/* SPDX-License-Identifier: MIT */
import { EvidenceContext, fail } from '../evidence/evidence.types';
import { contextValid, UUID } from '../evidence/file-safety';
import { ColdHistoryStore, CommittedHistorySource, HistoryAccess, HistoryCheckpoint } from './history.types';
import { sequence, streamName, validatePage } from './history-validation';
export class HistoryProjector {
  private active = 0;
  constructor(private readonly cold: ColdHistoryStore, private readonly source: CommittedHistorySource, private readonly access: HistoryAccess, private readonly now: () => number = Date.now) {
    if (!cold?.apply || !source?.databaseName || !source?.watermark || !source?.withCommittedPage || !access?.check) throw new Error('Separate cold storage and current owning committed-source authority are required.');
  }
  async processPage(ctx: EvidenceContext, stream: string, jobId = 'live', limit = 100) {
    contextValid(ctx); streamName(stream);
    if (jobId !== 'live' && (typeof jobId !== 'string' || !UUID.test(jobId)) || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_REQUEST');
    await this.access.check(ctx, 'history.project', stream);
    if (this.active >= 2) fail('QUOTA_EXCEEDED', 429, true); this.active++;
    try {
      const [coldDb, hotDb] = await Promise.all([this.cold.databaseName(), this.source.databaseName()]);
      if (typeof coldDb !== 'string' || !coldDb || typeof hotDb !== 'string' || !hotDb || coldDb === hotDb) fail('INVALID_STATE', 409);
      const previous = await this.cold.checkpoint(ctx, stream, jobId), watermark = previous?.mode === 'BACKFILL' ? { epoch: previous.epoch, through: previous.through } : await this.source.watermark(ctx, stream);
      if (!watermark || typeof watermark.epoch !== 'string' || !UUID.test(watermark.epoch)) fail('INVALID_STATE', 409);
      sequence(watermark.through); const after = previous?.after || '0'; sequence(after);
      if (previous && previous.epoch !== watermark.epoch || BigInt(after) > BigInt(watermark.through)) fail('REVISION_CONFLICT', 409);
      if (previous?.mode === 'BACKFILL' && previous.state === 'SUCCEEDED') return { checkpoint: previous, inserted: 0, replayed: 0 };
      const checkpoint: HistoryCheckpoint = { tenantId: ctx.tenantId, stream, jobId, mode: jobId === 'live' ? 'LIVE' : 'BACKFILL', epoch: watermark.epoch,
        after, through: watermark.through, updatedAt: new Date(this.now()).toISOString(), state: 'RUNNING' };
      return this.source.withCommittedPage(ctx, stream, checkpoint.epoch, after, checkpoint.through, limit, async supplied => {
        const page = validatePage(ctx, checkpoint.epoch, after, checkpoint.through, limit, supplied);
        await this.access.check(ctx, 'history.project', stream);
        return this.cold.apply(ctx, checkpoint, after, page, async () => this.access.check(ctx, 'history.project', stream));
      });
    } finally { this.active--; }
  }
}
