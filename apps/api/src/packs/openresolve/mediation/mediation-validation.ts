/* SPDX-License-Identifier: MIT */
import { contextValid, fingerprint, UUID } from '../../../platform/evidence/file-safety';
import { EvidenceContext, fail } from '../../../platform/evidence/evidence.types';
import { ResourceRef } from '../../../platform/lineage/lineage.types';
import { ActionInput, ActionProposal, CaseSnapshot, GroundedExplanation, ModelSelection, PolicyVerdict, RiskTier, SelectionInput, ToolId } from './mediation.types';
const hash = /^[a-f0-9]{64}$/, code = /^[A-Z][A-Z0-9_]{0,63}$/;
export const TOOLS: Readonly<Record<ToolId, RiskTier>> = Object.freeze({ 'case.read_summary': 'R0', 'case.request_evidence': 'R1', 'case.add_note': 'R2' });
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: object, allowed: string[]) => Object.keys(v).every(key => allowed.includes(key));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max &&
  ![...v].some(c => { const n = c.charCodeAt(0); return n < 32 && ![9, 10, 13].includes(n) || n === 127; });
export const toolIds = () => Object.keys(TOOLS) as ToolId[];
export function refValid(ref: unknown): ref is ResourceRef {
  return object(ref) && keys(ref, ['pack_id', 'type', 'id']) && typeof ref.pack_id === 'string' && typeof ref.type === 'string' && typeof ref.id === 'string' &&
    /^[a-z][a-z0-9-]{0,79}$/.test(ref.pack_id) && /^[a-z][a-z0-9-]{0,79}$/.test(ref.type) && UUID.test(ref.id);
}
export function validateSnapshot(ctx: EvidenceContext, id: string, snapshot: CaseSnapshot): CaseSnapshot {
  contextValid(ctx);
  if (!object(snapshot) || !keys(snapshot, ['tenantId', 'caseRef', 'version', 'hash', 'policy', 'facts', 'requiredFactCodes', 'disclosure']) ||
    snapshot.tenantId !== ctx.tenantId || !refValid(snapshot.caseRef) || snapshot.caseRef.pack_id !== 'openresolve' || snapshot.caseRef.type !== 'case' || snapshot.caseRef.id !== id ||
    !text(snapshot.version, 120) || !hash.test(snapshot.hash) || !object(snapshot.policy) || !keys(snapshot.policy, ['ref', 'version', 'sha256']) ||
    !refValid(snapshot.policy.ref) || !text(snapshot.policy.version, 120) || !hash.test(snapshot.policy.sha256) ||
    !['SYNTHETIC', 'APPROVED_PAID'].includes(snapshot.disclosure) || !Array.isArray(snapshot.facts) || snapshot.facts.length > 32 ||
    !Array.isArray(snapshot.requiredFactCodes) || snapshot.requiredFactCodes.length > 32 || snapshot.requiredFactCodes.some(c => !code.test(c)) ||
    new Set(snapshot.requiredFactCodes).size !== snapshot.requiredFactCodes.length) fail('INVALID_STATE', 409);
  const ids = new Set<string>(), codes = new Set<string>();
  for (const fact of snapshot.facts) {
    if (!object(fact) || !keys(fact, ['id', 'code', 'label', 'value', 'evidenceId', 'evidenceHash', 'factsVersion']) ||
      !UUID.test(fact.id) || ids.has(fact.id) || !code.test(fact.code) || codes.has(fact.code) || !text(fact.label, 160) || !text(fact.value, 1200) ||
      !UUID.test(fact.evidenceId) || !hash.test(fact.evidenceHash) || !text(fact.factsVersion, 120)) fail('INVALID_STATE', 409);
    ids.add(fact.id); codes.add(fact.code);
  }
  const content: Partial<CaseSnapshot> = { ...snapshot }; delete content.hash;
  if (fingerprint(content) !== snapshot.hash) fail('INVALID_STATE', 409);
  return structuredClone(snapshot);
}
export function explainRequest(body: unknown): { question: string } {
  if (!object(body) || !keys(body, ['question']) || !text(body.question, 1000)) fail('INVALID_REQUEST');
  return { question: body.question.trim() };
}
export function selectionInput(snapshot: CaseSnapshot, question: string): SelectionInput {
  return { question, facts: snapshot.facts.map((fact, i) => ({ alias: 'F' + (i + 1), code: fact.code, label: fact.label, value: fact.value })), tools: toolIds() };
}
export function grounded(snapshot: CaseSnapshot, selection?: ModelSelection): GroundedExplanation {
  const aliases = snapshot.facts.map((_f, i) => 'F' + (i + 1));
  if (selection && (!Array.isArray(selection.fact_aliases) || selection.fact_aliases.some(alias => !aliases.includes(alias)) ||
    new Set(selection.fact_aliases).size !== selection.fact_aliases.length || !['NONE', ...toolIds()].includes(selection.suggested_tool))) fail('INVALID_STATE', 409);
  const missing = snapshot.requiredFactCodes.filter(code => !snapshot.facts.some(fact => fact.code === code));
  const selected = selection ? new Set(selection.fact_aliases) : new Set(aliases);
  return { status: missing.length ? 'MISSING_EVIDENCE' : selected.size ? 'GROUNDED' : 'NO_SUPPORTED_ANSWER',
    statements: snapshot.facts.filter((_f, i) => selected.has(aliases[i])).map(f => ({ fact_id: f.id, code: f.code, label: f.label, value: f.value,
      citation: { evidence_id: f.evidenceId, sha256: f.evidenceHash, facts_version: f.factsVersion } })),
    missing_evidence: missing, suggested_tool: selection?.suggested_tool || 'NONE',
    ...(selection ? { provenance: selection.provenance, usage: selection.usage } : {}) };
}
export function actionInput(body: unknown, snapshot: CaseSnapshot): ActionInput {
  if (!object(body) || !keys(body, ['tool', 'fact_ids', 'missing_evidence_codes']) || typeof body.tool !== 'string' || !Object.prototype.hasOwnProperty.call(TOOLS, body.tool)) fail('INVALID_REQUEST');
  const list = body.tool === 'case.request_evidence' ? body.missing_evidence_codes : body.fact_ids;
  if (!Array.isArray(list) || list.length < 1 || list.length > 32 || new Set(list).size !== list.length) fail('INVALID_REQUEST');
  if (body.tool === 'case.request_evidence') {
    if (body.fact_ids !== undefined || list.some(c => typeof c !== 'string' || !code.test(c) || !snapshot.requiredFactCodes.includes(c) || snapshot.facts.some(f => f.code === c))) fail('INVALID_REQUEST');
    return { tool: body.tool, missing_evidence_codes: [...list].sort() };
  }
  if (body.missing_evidence_codes !== undefined || list.some(id => typeof id !== 'string' || !UUID.test(id) || !snapshot.facts.some(f => f.id === id))) fail('INVALID_REQUEST');
  return { tool: body.tool as ToolId, fact_ids: [...list].sort() };
}
export function enforcePolicy(verdict: PolicyVerdict, snapshot: CaseSnapshot, action: ActionInput): void {
  if (!object(verdict) || !keys(verdict, ['effect', 'policyHash', 'risk', 'requiresApproval']) || verdict.effect !== 'ALLOW' ||
    verdict.policyHash !== snapshot.policy.sha256 || verdict.risk !== TOOLS[action.tool] || typeof verdict.requiresApproval !== 'boolean' ||
    TOOLS[action.tool] !== 'R0' && !verdict.requiresApproval) fail('FORBIDDEN', 403);
}
export function proposalHash(proposal: Omit<ActionProposal, 'hash'> | ActionProposal): string {
  return fingerprint({ id: proposal.id, tenantId: proposal.tenantId, explanationId: proposal.explanationId, requester: proposal.requester,
    caseId: proposal.caseId, snapshotHash: proposal.snapshotHash, policyHash: proposal.policyHash, controlVersion: proposal.controlVersion,
    input: proposal.input, risk: proposal.risk, requiresApproval: proposal.requiresApproval, createdAt: proposal.createdAt });
}
