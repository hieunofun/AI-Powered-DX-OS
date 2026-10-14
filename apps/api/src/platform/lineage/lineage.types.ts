/* SPDX-License-Identifier: MIT */
import { PoolClient } from 'pg';
import { EvidenceContext, EvidenceRecord } from '../evidence/evidence.types';
import { DraftRecord } from '../extraction/draft.types';
export interface ResourceRef { pack_id: string; type: string; id: string; }
export interface EvidenceLink {
  id: string; tenant_id: string; from_ref: ResourceRef; to_ref: ResourceRef;
  relation: 'DERIVED_FROM' | 'CORRECTS' | 'CONFIRMS' | 'SUPPORTS' | 'EVALUATED_BY'; created_at: string;
}
export interface ResourceSnapshot { ref: ResourceRef; version: string; sha256: string; metadata: Record<string, unknown>; }
export interface LineageEdge { from: ResourceSnapshot; to: ResourceSnapshot; relation: EvidenceLink['relation']; createdAt: string; }
export interface DraftLineageSink {
  // Same transaction as source/draft/outbox. A sink failure must roll back the entire mutation.
  capture(client: PoolClient, context: EvidenceContext, record: DraftRecord, source: EvidenceRecord): Promise<void>;
}
export interface LineageAccess {
  // Revalidate active membership and current action/resource/retention permissions; never trust a ref as a grant.
  check(context: EvidenceContext, action: 'lineage.read' | 'resource.read' | 'lineage.record', ref: ResourceRef): Promise<void>;
}
export interface LineageStore {
  watermark(context: EvidenceContext, evidenceId: string): Promise<string>;
  page(context: EvidenceContext, evidenceId: string, after: string, through: string, limit: number): Promise<{ sequence: string; link: EvidenceLink }[]>;
  append(client: PoolClient, context: EvidenceContext, evidenceId: string, edges: LineageEdge[]): Promise<void>;
}
