/* SPDX-License-Identifier: MIT */
import { EvidenceContext, fail } from '../evidence/evidence.types';
import { contextValid, fingerprint, UUID } from '../evidence/file-safety';
import { ResourceRef } from '../lineage/lineage.types';
import { CommittedHistoryPage, HistoryEntry, HistoryRetention } from './history.types';
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: object, allowed: string[]) => Object.keys(v).every(key => allowed.includes(key));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= max;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function sequence(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n) fail('INVALID_STATE', 409);
  return value;
}
export function utc(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const at = Date.parse(value); return Number.isFinite(at) && [value, value.replace(/Z$/, '.000Z')].includes(new Date(at).toISOString());
}
export function resource(value: unknown): value is ResourceRef {
  return object(value) && keys(value, ['pack_id', 'type', 'id']) && text(value.pack_id, 80) && text(value.type, 80) &&
    /^[a-z][a-z0-9-]*$/.test(value.pack_id) && /^[a-z][a-z0-9-]*$/.test(value.type) && typeof value.id === 'string' && UUID.test(value.id);
}
export function streamName(value: string): string { if (typeof value !== 'string' || !/^[a-z][a-z0-9.-]{0,99}$/.test(value)) fail('INVALID_REQUEST'); return value; }
export function retention(value: unknown): HistoryRetention {
  if (!object(value) || !keys(value, ['retention_class', 'retain_until', 'legal_hold', 'policy_version']) || !['STANDARD', 'RESTRICTED'].includes(value.retention_class) ||
    !utc(value.retain_until) || typeof value.legal_hold !== 'boolean' || !text(value.policy_version, 120)) fail('INVALID_STATE', 409);
  return value as HistoryRetention;
}
function payload(value: unknown) {
  let count = 0; const seen = new Set<object>();
  const visit = (v: unknown, depth: number) => {
    if (++count > 3000 || depth > 10) fail('INVALID_STATE', 409);
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number') { if (!Number.isSafeInteger(v)) fail('INVALID_STATE', 409); return; }
    if (!v || typeof v !== 'object' || seen.has(v)) fail('INVALID_STATE', 409); seen.add(v);
    if (Array.isArray(v)) for (const item of v) visit(item, depth + 1);
    else for (const [key, item] of Object.entries(v)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key) || key.length > 200) fail('INVALID_STATE', 409); visit(item, depth + 1);
    }
    seen.delete(v);
  };
  if (!object(value)) fail('INVALID_STATE', 409); visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > 65536) fail('FILE_TOO_LARGE', 413);
}
export function validateEntry(ctx: EvidenceContext, value: HistoryEntry): HistoryEntry {
  contextValid(ctx);
  if (!object(value) || !keys(value, ['sequence', 'event', 'snapshot', 'case_metric', 'evidence', 'retention', 'simulated'])) fail('INVALID_STATE', 409);
  sequence(value.sequence);
  const e = value.event, s = value.snapshot, m = value.case_metric;
  if (!object(e) || !keys(e, ['id', 'type', 'tenant_id', 'occurred_at', 'correlation_id', 'causation_id', 'subject_ref', 'schema_id', 'payload_ref']) ||
    typeof e.id !== 'string' || !UUID.test(e.id) || e.tenant_id !== ctx.tenantId || !text(e.type, 160) || !/^[a-z][a-z0-9.]*\.v[1-9][0-9]*$/.test(e.type) ||
    !utc(e.occurred_at) || typeof e.correlation_id !== 'string' || !UUID.test(e.correlation_id) || e.causation_id !== undefined && (typeof e.causation_id !== 'string' || !UUID.test(e.causation_id)) ||
    !resource(e.subject_ref) || !resource(e.payload_ref) || !text(e.schema_id, 160) || !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*\.v[1-9][0-9]*$/.test(e.schema_id) ||
    !object(s) || !keys(s, ['ref', 'version', 'sha256', 'payload']) || !resource(s.ref) || !text(s.version, 120) || !hash(s.sha256) || fingerprint(s.ref) !== fingerprint(e.subject_ref)) fail('INVALID_STATE', 409);
  payload(s.payload); if (fingerprint(s.payload) !== s.sha256) fail('CHECKSUM_MISMATCH', 422);
  if (!object(m) || !keys(m, ['ref', 'classification', 'started_at', 'finished_at', 'error_code']) || !resource(m.ref) || fingerprint(m.ref) !== fingerprint(s.ref) ||
    !['ACTIVE', 'COMPLETED', 'ERROR'].includes(m.classification) || !utc(m.started_at) ||
    (m.classification === 'ACTIVE' ? m.finished_at !== undefined : !utc(m.finished_at) || Date.parse(m.finished_at) < Date.parse(m.started_at)) ||
    (m.classification === 'ERROR' ? !text(m.error_code, 80) || !/^[A-Z][A-Z0-9_]*$/.test(m.error_code) : m.error_code !== undefined)) fail('INVALID_STATE', 409);
  if (!Array.isArray(value.evidence) || value.evidence.length > 32 || typeof value.simulated !== 'boolean') fail('INVALID_STATE', 409);
  const evidence = new Set<string>();
  for (const item of value.evidence) {
    if (!object(item) || !keys(item, ['ref', 'version', 'sha256']) || !resource(item.ref) || item.ref.pack_id !== 'platform' || item.ref.type !== 'evidence' ||
      !text(item.version, 120) || !hash(item.sha256) || evidence.has(item.ref.id)) fail('INVALID_STATE', 409); evidence.add(item.ref.id);
  }
  retention(value.retention); return structuredClone(value);
}
export function validatePage(ctx: EvidenceContext, epoch: string, after: string, through: string, limit: number, value: CommittedHistoryPage): CommittedHistoryPage {
  sequence(after); sequence(through);
  if (!UUID.test(epoch) || BigInt(after) > BigInt(through) || !Number.isInteger(limit) || limit < 1 || limit > 100 || !object(value) ||
    !keys(value, ['epoch', 'through', 'scannedThrough', 'entries']) || value.epoch !== epoch || value.through !== through || !Array.isArray(value.entries) || value.entries.length > limit) fail('INVALID_STATE', 409);
  sequence(value.scannedThrough); if (BigInt(value.scannedThrough) < BigInt(after) || BigInt(value.scannedThrough) > BigInt(through) ||
    BigInt(after) < BigInt(through) && value.scannedThrough === after) fail('INVALID_STATE', 409);
  let previous = BigInt(after); const ids = new Set<string>();
  for (const entry of value.entries) {
    validateEntry(ctx, entry); if (BigInt(entry.sequence) <= previous || BigInt(entry.sequence) > BigInt(value.scannedThrough) || ids.has(entry.event.id)) fail('INVALID_STATE', 409);
    previous = BigInt(entry.sequence); ids.add(entry.event.id);
  }
  return structuredClone(value);
}
