/* SPDX-License-Identifier: MIT */
import { EvidenceContext, fail } from '../../platform/evidence/evidence.types';
import { contextValid, fingerprint, UUID } from '../../platform/evidence/file-safety';
import { ResourceRef } from '../../platform/lineage/lineage.types';
import { ONBOARDING_MANIFEST } from './onboarding.manifest';
import { AccessProfile, ChecklistCode, OnboardingBinding, OnboardingCase, VersionRef } from './onboarding.types';
export const CHECKLIST: readonly ChecklistCode[] = ['WELCOME_ACK', 'ACCESS_POLICY_ACK'];
export const SCOPES: Readonly<Record<AccessProfile, readonly string[]>> = Object.freeze({ DOCS_READ_ONLY: ['INTERNAL_DOCS_READ'], TEAM_WORKSPACE: ['INTERNAL_DOCS_READ', 'TEAM_WORKSPACE_VIEW'] });
export const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
export const keys = (v: object, allowed: string[]) => Object.keys(v).every(key => allowed.includes(key));
export function ref(value: unknown): value is ResourceRef {
  return object(value) && keys(value, ['pack_id', 'type', 'id']) && typeof value.pack_id === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(value.pack_id) &&
    typeof value.type === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(value.type) && typeof value.id === 'string' && UUID.test(value.id);
}
export function version(value: unknown): value is VersionRef {
  return object(value) && keys(value, ['id', 'version', 'sha256']) && typeof value.id === 'string' && UUID.test(value.id) &&
    typeof value.version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(value.version) && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256);
}
export function utc(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const at = Date.parse(value); return Number.isFinite(at) && [value, value.replace(/Z$/, '.000Z')].includes(new Date(at).toISOString());
}
export function createInput(body: unknown) {
  if (!object(body) || !keys(body, ['display_label']) || typeof body.display_label !== 'string' || !body.display_label.trim() || body.display_label.length > 160) fail('INVALID_REQUEST');
  return { display_label: body.display_label.trim() };
}
export function checklistInput(code: string, body: unknown) {
  if (!CHECKLIST.includes(code as ChecklistCode) || !object(body) || !keys(body, ['evidence_id', 'acknowledged', 'expected_revision']) ||
    typeof body.evidence_id !== 'string' || !UUID.test(body.evidence_id) || body.acknowledged !== true || !Number.isInteger(body.expected_revision) || body.expected_revision < 0 || body.expected_revision >= 10) fail('INVALID_REQUEST');
  return { code: code as ChecklistCode, evidence_id: body.evidence_id as string, acknowledged: true as const, expected_revision: body.expected_revision as number };
}
export function accessInput(body: unknown) {
  if (!object(body) || !keys(body, ['access_profile']) || typeof body.access_profile !== 'string' || !Object.prototype.hasOwnProperty.call(SCOPES, body.access_profile)) fail('INVALID_REQUEST');
  return { access_profile: body.access_profile as AccessProfile };
}
export function decisionInput(body: unknown) {
  if (!object(body) || !keys(body, ['decision_ref']) || !ref(body.decision_ref) || body.decision_ref.pack_id !== 'platform' || body.decision_ref.type !== 'decision') fail('INVALID_REQUEST');
  return { decision_ref: body.decision_ref as ResourceRef };
}
export function binding(ctx: EvidenceContext, permission: string, value: OnboardingBinding): OnboardingBinding {
  contextValid(ctx); const permissions: readonly string[] = ONBOARDING_MANIFEST.permissions;
  if (!permissions.includes(permission)) fail('FORBIDDEN', 403);
  if (!object(value) || !keys(value, ['manifest_sha256', 'core_version', 'enabled', 'workflow', 'policy_ref']) || typeof value.enabled !== 'boolean') fail('DEPENDENCY_UNAVAILABLE', 503);
  if (!value.enabled) fail('PACK_DISABLED', 409);
  if (value.manifest_sha256 !== fingerprint(ONBOARDING_MANIFEST) || typeof value.core_version !== 'string' || !/^1\.[0-9]+\.[0-9]+$/.test(value.core_version) ||
    !object(value.workflow) || !keys(value.workflow, ['ref', 'definition_id', 'process_key', 'reviewer_group']) || !version(value.workflow.ref) ||
    fingerprint(value.workflow.ref) !== fingerprint(ONBOARDING_MANIFEST.workflow_refs[0]) || value.workflow.process_key !== 'onboarding_access_review_v1' ||
    typeof value.workflow.definition_id !== 'string' || !/^onboarding_access_review_v1:[1-9][0-9]*:[A-Za-z0-9-]{1,100}$/.test(value.workflow.definition_id) ||
    typeof value.workflow.reviewer_group !== 'string' || value.workflow.reviewer_group !== 'onboarding-reviewer-' + ctx.tenantId || !version(value.policy_ref)) fail('REVISION_CONFLICT', 409);
  return structuredClone(value);
}
export function caseView(record: OnboardingCase) {
  return { id: record.id, tenant_id: record.tenantId, requester_subject: record.requester, display_label: record.displayLabel,
    created_at: record.createdAt, updated_at: record.updatedAt, state: record.state, manifest_sha256: record.manifestSha256,
    checklist: record.checklist, provisioning_state: record.provisioningState, operations: record.operations,
    ...(record.request ? { access_request: record.request, request_sha256: record.requestHash } : {}),
    ...(record.decision ? { decision: { decision_ref: record.decision.decision_ref, action: record.decision.action, approver: record.decision.approver,
      subject_ref: record.decision.subject_ref, subject_sha256: record.decision.subject_sha256, policy_ref: record.decision.policy_ref,
      decision_version: record.decision.decision_version, approved_at: record.decision.approved_at } } : {}),
    ...(record.workflow ? { workflow: { definition_id: record.workflow.definitionId, ...(record.workflow.processId ? { process_id: record.workflow.processId } : {}),
      ...(record.workflow.taskId ? { task_id: record.workflow.taskId } : {}), ...(record.workflow.endedAt ? { ended_at: record.workflow.endedAt } : {}) } } : {}) };
}
