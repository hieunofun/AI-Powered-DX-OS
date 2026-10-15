/* SPDX-License-Identifier: MIT */
import { PoolClient } from 'pg';
import { Evidence, EvidenceContext, EvidenceOperation } from '../../platform/evidence/evidence.types';
import { ResourceRef, ResourceSnapshot } from '../../platform/lineage/lineage.types';
export interface VersionRef { id: string; version: string; sha256: string; }
export interface OnboardingBinding {
  manifest_sha256: string; core_version: string; enabled: boolean;
  workflow: { ref: VersionRef; definition_id: string; process_key: string; reviewer_group: string };
  policy_ref: VersionRef;
}
export interface CapabilityPackRuntime {
  // Required owning #59 binding: current registered manifest/version/compatibility,
  // declared permission, enabled state and current tenant/resource grant in this transaction.
  // No pack-owned permissive production registry is provided.
  require(client: PoolClient, context: EvidenceContext, packId: 'onboarding', permission: string, resource?: ResourceRef): Promise<OnboardingBinding>;
}
export type ChecklistCode = 'WELCOME_ACK' | 'ACCESS_POLICY_ACK';
export type AccessProfile = 'DOCS_READ_ONLY' | 'TEAM_WORKSPACE';
export interface ChecklistReceipt {
  id: string; code: ChecklistCode; revision: number; acknowledged: true; evidence_id: string;
  sha256: string; recorded_by: string; recorded_at: string;
}
export interface AccessRequest {
  id: string; requested_for: string; profile: AccessProfile; requested_scopes: string[];
  checklist: ChecklistReceipt[]; manifest_sha256: string; policy_ref: VersionRef;
  created_at: string; created_by: string;
}
export interface VerifiedOnboardingDecision {
  decision_ref: ResourceRef; action: 'APPROVE' | 'REJECT'; approver: string; subject_ref: ResourceRef;
  subject_sha256: string; policy_ref: VersionRef; decision_version: string; approved_at: string; decision_snapshot: ResourceSnapshot;
}
export interface OnboardingEvidenceBindings {
  // Generic owning SDK adapter must lock/verify current actor/resource/retention,
  // actual accepted CLEAN source/hash and its immutable registered raw snapshot.
  inspect(client: PoolClient, context: EvidenceContext, evidenceId: string, expectedHash: string): Promise<{ evidence: Evidence; rawSnapshot: ResourceSnapshot }>;
}
export interface OnboardingDecisionPort {
  // Required actual owner decision, current approval authority/SoD/revocation and exact
  // subject/policy hashes. Rechecked before every engine write and finalization.
  verify(client: PoolClient, context: EvidenceContext, request: AccessRequest, decisionRef: ResourceRef): Promise<VerifiedOnboardingDecision>;
}
export type OnboardingOperation = Omit<EvidenceOperation, 'kind' | 'resource_ref'> & {
  kind: 'ONBOARDING_SUBMIT' | 'ONBOARDING_DECISION'; resource_ref: ResourceRef;
};
export interface WorkflowIntent {
  operationId: string; kind: 'START' | 'DECISION'; phase: 'READY' | 'START_SENT' | 'START_CONFIRMED' | 'CLAIM_SENT' | 'CLAIM_CONFIRMED' | 'COMPLETE_SENT' | 'DONE';
  attempts: number; lease?: { token: string; until: string }; nextAttemptAt?: string;
  failures: { code: string; at: string; attempt: number }[];
}
export interface OnboardingCase {
  id: string; tenantId: string; requester: string; displayLabel: string; createdAt: string; updatedAt: string;
  manifestSha256: string; binding: OnboardingBinding; checklist: ChecklistReceipt[];
  state: 'COLLECTING' | 'SUBMITTING' | 'AWAITING_APPROVAL' | 'APPLYING_DECISION' | 'COMPLETED' | 'REJECTED' | 'RECONCILIATION_REQUIRED';
  request?: AccessRequest; requestHash?: string; decision?: VerifiedOnboardingDecision;
  workflow?: { businessKey: string; definitionId: string; processId?: string; taskId?: string; endedAt?: string };
  operations: OnboardingOperation[]; intent?: WorkflowIntent;
  // This MVP never creates an external account, grant or token.
  provisioningState: 'NOT_PROVISIONED';
}
export interface OnboardingLineageSink {
  capture(client: PoolClient, context: EvidenceContext, before: OnboardingCase | undefined, after: OnboardingCase): Promise<void>;
}
export interface OnboardingCommand { scope: string; hash: string; }
export interface OnboardingStore {
  transaction<T>(context: EvidenceContext, work: (client: PoolClient) => Promise<T>): Promise<T>;
  read(context: EvidenceContext, id: string, client?: PoolClient): Promise<OnboardingCase | undefined>;
  operation(context: EvidenceContext, id: string): Promise<OnboardingCase | undefined>;
  lock(client: PoolClient, context: EvidenceContext, id: string): Promise<void>;
  save(client: PoolClient, context: EvidenceContext, before: OnboardingCase | undefined, after: OnboardingCase): Promise<void>;
  command<T>(client: PoolClient, context: EvidenceContext, command: OnboardingCommand, work: () => Promise<T>): Promise<T>;
  candidate(context: EvidenceContext, now: string): Promise<string | undefined>;
}
