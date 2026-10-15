/* SPDX-License-Identifier: MIT */
import { Evidence } from '../evidence/evidence.types';
import { ResourceSnapshot } from './lineage.types';
// One canonical immutable byte-version view, shared by every evidence-producing pack.
export function rawEvidenceSnapshot(source: Evidence): ResourceSnapshot {
  return { ref: { pack_id: 'platform', type: 'evidence', id: source.id }, version: 'blob-1', sha256: source.sha256,
    metadata: { media_type: source.media_type, size_bytes: source.size_bytes, source_sha256: source.sha256,
      retention_class_at_registration: source.retention_class, created_at: source.created_at } };
}
