/* SPDX-License-Identifier: MIT */
import { PoolClient } from 'pg';
import { EvidenceContext, EvidenceOperation } from '../../../platform/evidence/evidence.types';
import { ResourceRef } from '../../../platform/lineage/lineage.types';
export type RiskTier = 'R0' | 'R1' | 'R2' | 'R3';
export type ToolId = 'case.read_summary' | 'case.request_evidence' | 'case.add_note';
export interface CaseFact {
  id: string; code: string; label: string; value: string;
  evidenceId: string; evidenceHash: string; factsVersion: string;
}
export interface CaseSnapshot {
  tenantId: string; caseRef: ResourceRef; version: string; hash: string;
  policy: { ref: ResourceRef; version: string; sha256: string };
  facts: CaseFact[]; requiredFactCodes: string[];
  disclosure: 'SYNTHETIC' | 'APPROVED_PAID';
}
export interface MediationCaseSource {
  // Mandatory owner adapter: verify current membership/case/resource/retention grants,
  // persisted confirmed facts, and CLEAN evidence/version/hash under this transaction.
  // Lock master rows and evidence as needed; a caller's UUID never grants authority.
  load(client: PoolClient, context: EvidenceContext, caseId: string): Promise<CaseSnapshot>;
  authorize(client: PoolClient, context: EvidenceContext, action: 'ai.explain' | 'ai.process' | 'ai.propose' | 'ai.approve' | 'ai.execute', caseId?: string): Promise<void>;
}
export interface SelectionInput {
  question: string; facts: { alias: string; code: string; label: string; value: string }[]; tools: ToolId[];
}
export interface ModelSelection {
  fact_aliases: string[]; suggested_tool: ToolId | 'NONE';
  provenance: { provider: 'gemini'; model_version: string; prompt_version: string; run_id: string };
  usage: { input_tokens: number; reserved_tokens: number; reported_total_tokens?: number };
}
export interface ExplanationProvider {
  select(input: SelectionInput, disclosure: CaseSnapshot['disclosure'], recheck: () => Promise<void>): Promise<ModelSelection>;
}
export interface GroundedExplanation {
  status: 'GROUNDED' | 'MISSING_EVIDENCE' | 'NO_SUPPORTED_ANSWER';
  statements: { fact_id: string; code: string; label: string; value: string;
    citation: { evidence_id: string; sha256: string; facts_version: string } }[];
  missing_evidence: string[]; suggested_tool: ToolId | 'NONE';
  provenance?: ModelSelection['provenance']; usage?: ModelSelection['usage'];
}
export interface ActionInput { tool: ToolId; fact_ids?: string[]; missing_evidence_codes?: string[]; }
export interface PolicyVerdict {
  effect: 'ALLOW' | 'DENY'; policyHash: string; risk: RiskTier; requiresApproval: boolean;
}
export interface MediationPolicy {
  // Resolve the actual current published policy; never accept a model/client verdict.
  evaluate(client: PoolClient, context: EvidenceContext, snapshot: CaseSnapshot, action: ActionInput): Promise<PolicyVerdict>;
}
export interface VerifiedApproval {
  decisionRef: ResourceRef; proposalHash: string; policyHash: string; approver: string;
  approvedAt: string; decisionVersion: string; state: 'APPROVED';
}
export interface MediationApproval {
  // Actual owning decision, current approver authority/SoD and revocation must be
  // verified in the same transaction on attachment AND again before execution.
  verify(client: PoolClient, context: EvidenceContext, proposal: ActionProposal, decisionRef: ResourceRef): Promise<VerifiedApproval>;
}
export interface ExecutionReceipt { action_id: string; resource_ref: ResourceRef; sha256: string; executed_at: string; }
export interface MediationExecutor {
  // Only transactional local tools. Apply the exact registered command in this SQL
  // transaction, deduplicating by proposal.id. No HTTP/bank/nontransactional tools.
  executeInTransaction(client: PoolClient, context: EvidenceContext, snapshot: CaseSnapshot, proposal: ActionProposal): Promise<ExecutionReceipt>;
}
export interface ExplanationJob {
  id: string; tenantId: string; requester: string; caseId: string; question: string; controlVersion: string;
  operation: Omit<EvidenceOperation, 'kind' | 'resource_ref'> & { kind: 'AI_EXPLANATION'; resource_ref: ResourceRef };
  acknowledgement: ExplanationJob['operation']; createdAt: string; updatedAt: string;
  attempts: number; lease?: { token: string; until: string }; nextAttemptAt?: string;
  snapshot?: CaseSnapshot; result?: GroundedExplanation;
  failures: { code: string; at: string; attempt: number; providerRunId?: string }[];
}
export interface ActionProposal {
  id: string; tenantId: string; explanationId: string; requester: string; caseId: string;
  snapshotHash: string; policyHash: string; controlVersion: string; input: ActionInput; risk: RiskTier;
  requiresApproval: boolean; hash: string; state: 'AWAITING_APPROVAL' | 'READY' | 'APPROVED' | 'EXECUTED';
  createdAt: string; approval?: VerifiedApproval; receipt?: ExecutionReceipt;
}
export interface Command { scope: string; hash: string; }
export interface MediationStore {
  transaction<T>(context: EvidenceContext, work: (client: PoolClient, controlVersion: string) => Promise<T>, requireEnabled?: boolean): Promise<T>;
  job(context: EvidenceContext, id: string, client?: PoolClient): Promise<ExplanationJob | undefined>;
  operation(context: EvidenceContext, id: string): Promise<ExplanationJob | undefined>;
  saveJob(client: PoolClient, job: ExplanationJob): Promise<void>;
  candidate(context: EvidenceContext, now: string): Promise<string | undefined>;
  proposal(context: EvidenceContext, id: string, client: PoolClient): Promise<ActionProposal | undefined>;
  saveProposal(client: PoolClient, proposal: ActionProposal): Promise<void>;
  command<T>(client: PoolClient, context: EvidenceContext, command: Command, work: () => Promise<T>): Promise<T>;
  lock(client: PoolClient, context: EvidenceContext, namespace: 'job' | 'proposal', id: string): Promise<void>;
}
