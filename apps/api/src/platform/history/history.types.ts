/* SPDX-License-Identifier: MIT */
import { PoolClient } from 'pg';
import { EvidenceContext } from '../evidence/evidence.types';
import { ResourceRef } from '../lineage/lineage.types';
export interface HistoryEvent {
  id: string; type: string; tenant_id: string; occurred_at: string; correlation_id: string; causation_id?: string;
  subject_ref: ResourceRef; schema_id: string; payload_ref: ResourceRef;
}
export interface HistoryRetention { retention_class: 'STANDARD' | 'RESTRICTED'; retain_until: string; legal_hold: boolean; policy_version: string; }
export interface HistoryEntry {
  sequence: string; event: HistoryEvent;
  snapshot: { ref: ResourceRef; version: string; sha256: string; payload: Record<string, unknown> };
  case_metric: { ref: ResourceRef; classification: 'ACTIVE' | 'COMPLETED' | 'ERROR'; started_at: string; finished_at?: string; error_code?: string };
  evidence: { ref: ResourceRef; version: string; sha256: string }[];
  retention: HistoryRetention; simulated: boolean;
}
export interface CommittedHistoryPage { epoch: string; through: string; scannedThrough: string; entries: HistoryEntry[]; }
export interface CommittedHistorySource {
  // Return the actual hot database name and a committed stream watermark. IDs allocated
  // by uncommitted writers must never become late events below this watermark.
  databaseName(): Promise<string>;
  watermark(context: EvidenceContext, stream: string): Promise<{ epoch: string; through: string }>;
  // Mandatory owning adapter: preserve immutable source/native versions, current tenant/
  // resource/evidence/retention authority and source ordering while use() commits cold data.
  // This is a read port: no hot DML, deletion, fabricated events or model-supplied snapshots.
  // scannedThrough explicitly attests the scanned prefix; empty pages cannot silently skip data.
  // Include every committed entry in (after, scannedThrough]; do not omit denied resources
  // and then advance. The current archive worker must be entitled to the whole scanned prefix.
  withCommittedPage<T>(context: EvidenceContext, stream: string, epoch: string, after: string, through: string, limit: number,
    use: (page: CommittedHistoryPage) => Promise<T>): Promise<T>;
}
export interface HistoryAccess {
  check(context: EvidenceContext, action: 'history.project' | 'history.read' | 'history.report', stream: string): Promise<void>;
  // Recheck CURRENT membership, full historical resource/field grants, every evidence ACL,
  // current retention class/hold and permission to inspect expired history. Denials omit rows;
  // authority outages throw. A legal hold preserves data; it never grants disclosure.
  inspect(context: EvidenceContext, stream: string, entry: HistoryEntry): Promise<{
    allowed: boolean; currentRetention: HistoryRetention; allowExpired: boolean;
  }>;
}
export interface HistoryCheckpoint {
  tenantId: string; stream: string; jobId: string; mode: 'LIVE' | 'BACKFILL'; epoch: string;
  after: string; through: string; updatedAt: string; state: 'RUNNING' | 'SUCCEEDED';
}
export interface ColdHistoryRecord { id: string; tenantId: string; stream: string; epoch: string; capturedAt: string; nativeHash: string; entry: HistoryEntry; }
export interface ColdHistoryStore {
  databaseName(): Promise<string>;
  checkpoint(context: EvidenceContext, stream: string, jobId: string): Promise<HistoryCheckpoint | undefined>;
  apply(context: EvidenceContext, checkpoint: HistoryCheckpoint, expectedAfter: string, page: CommittedHistoryPage,
    guard: (client: PoolClient) => Promise<void>): Promise<{ checkpoint: HistoryCheckpoint; inserted: number; replayed: number }>;
  watermark(context: EvidenceContext, stream: string): Promise<string>;
  latestCases(context: EvidenceContext, stream: string, through: string, afterCase: string | undefined, limit: number): Promise<{ caseKey: string; record: ColdHistoryRecord }[]>;
  events(context: EvidenceContext, stream: string, through: string, after: string, limit: number): Promise<{ captureSequence: string; record: ColdHistoryRecord }[]>;
}
