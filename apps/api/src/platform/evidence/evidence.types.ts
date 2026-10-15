/* SPDX-License-Identifier: MIT */
import { HttpException } from '@nestjs/common';
export interface EvidenceContext { tenantId: string; subject: string; }
export interface EvidenceAccess {
  check(context: EvidenceContext, action: string, evidenceId?: string, policy?: { retentionClass: 'STANDARD' | 'RESTRICTED' }): Promise<void>;
}
export type Quarantine = 'PENDING_UPLOAD' | 'PENDING_SCAN' | 'CLEAN' | 'INFECTED' | 'SCAN_FAILED';
export interface EvidenceRegistration {
  filename: string; media_type: 'application/xml' | 'application/pdf' | 'image/png' | 'image/jpeg';
  size_bytes: number; sha256: string; source: { kind: 'USER_UPLOAD' | 'CONNECTOR'; source_id?: string; observed_at?: string };
  retention_class: 'STANDARD' | 'RESTRICTED';
}
export interface Evidence extends EvidenceRegistration {
  id: string; tenant_id: string; revision: number; quarantine_state: Quarantine;
  processing_state: 'NOT_STARTED' | 'QUEUED' | 'PROCESSING' | 'REVIEW_REQUIRED' | 'CONFIRMED' | 'FAILED';
  created_at: string; updated_at: string; created_by: string; legal_hold: boolean;
}
export interface EvidenceOperation {
  id: string; tenant_id: string; kind: 'EVIDENCE_UPLOAD'; state: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'RECONCILIATION_REQUIRED';
  created_at: string; updated_at: string; resource_ref: { pack_id: 'platform'; type: 'evidence'; id: string };
  error?: { code: string; message: string; correlation_id: string; retryable: boolean };
}
export interface OperationReader {
  // Implementations reauthorize the original resource before returning a view.
  read(context: EvidenceContext, id: string): Promise<{
    id: string; tenant_id: string; kind: string; state: EvidenceOperation['state'];
    created_at: string; updated_at: string; resource_ref: { pack_id: string; type: string; id: string };
  } | undefined>;
}
export interface ScanResult {
  state: 'CLEAN' | 'INFECTED' | 'SCAN_FAILED'; reason?: string; retryable: boolean;
  engine?: string; definitions?: string; definitionsAt?: string; policy?: string;
}
export interface ScanHistory extends ScanResult { attempt: number; at: string; sha256: string; revision: number; leaseToken?: string; objectKey?: string; }
export interface EvidenceRecord {
  evidence: Evidence; expiresAt: string; operation?: EvidenceOperation; objectKey?: string;
  accepted: boolean; lease?: { token: string; until: string; phase: 'UPLOAD' | 'SCAN' };
  uploadAttempts: number; scanAttempts: number; nextAttemptAt?: string; history: ScanHistory[];
  uploadHistory?: { attempt: number; at: string; objectKey: string; leaseToken: string }[];
}
export interface EvidenceStorage {
  put(context: EvidenceContext, key: string, bytes: Buffer, mediaType: string, checksum: string): Promise<void>;
  read(context: EvidenceContext, key: string): Promise<AsyncIterable<Buffer>>;
}
export interface EvidenceScanner { scan(bytes: Buffer): Promise<ScanResult>; }
export class EvidenceError extends HttpException {
  constructor(readonly code: string, status: number, readonly retryable = false, readonly operationId?: string) {
    super({ code, message: 'Evidence operation failed: ' + code + '.', retryable,
      ...(operationId ? { operation_id: operationId } : {}) }, status);
  }
}
export function fail(code: string, status = 400, retryable = false, operationId?: string): never {
  throw new EvidenceError(code, status, retryable, operationId);
}
