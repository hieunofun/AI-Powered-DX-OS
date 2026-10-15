/* SPDX-License-Identifier: MIT */
'use strict';
// Deterministic proposed DTOs; owning SDK schema registration remains a #59 gate.
const fs = require('node:fs'), path = require('node:path');
const platform = require('../../packages/contracts/opendx/v1/schemas/platform.schema.json');
const closed = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const ref = name => ({ $ref: '#/definitions/' + name }), uuid = { type: 'string', format: 'uuid' }, sha = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const at = { type: 'string', format: 'date-time', pattern: 'Z$' }, subject = { type: 'string', minLength: 1, maxLength: 200 }, profile = { enum: ['DOCS_READ_ONLY', 'TEAM_WORKSPACE'] };
const definitions = {
  ResourceRef: platform.definitions.ResourceRef, VersionRef: platform.definitions.VersionRef, Error: platform.definitions.Error, Operation: platform.definitions.Operation,
  Create: closed({ display_label: { type: 'string', minLength: 1, maxLength: 160, pattern: '\\S' } }),
  ChecklistInput: closed({ evidence_id: uuid, acknowledged: { const: true }, expected_revision: { type: 'integer', minimum: 0, maximum: 9 } }),
  AccessInput: closed({ access_profile: profile }), DecisionInput: closed({ decision_ref: { allOf: [ref('ResourceRef'), { properties: { pack_id: { const: 'platform' }, type: { const: 'decision' } } }] } }),
  ChecklistEvidence: closed({ id: uuid, code: { enum: ['WELCOME_ACK', 'ACCESS_POLICY_ACK'] }, revision: { type: 'integer', minimum: 1, maximum: 10 }, acknowledged: { const: true }, evidence_id: uuid, sha256: sha, recorded_by: subject, recorded_at: at }),
  AccessRequest: closed({ id: uuid, requested_for: subject, profile, requested_scopes: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { enum: ['INTERNAL_DOCS_READ', 'TEAM_WORKSPACE_VIEW'] } },
    checklist: { type: 'array', minItems: 2, maxItems: 2, items: ref('ChecklistEvidence') }, manifest_sha256: sha, policy_ref: ref('VersionRef'), created_at: at, created_by: subject }),
  Decision: closed({ decision_ref: ref('ResourceRef'), action: { enum: ['APPROVE', 'REJECT'] }, approver: subject, subject_ref: ref('ResourceRef'), subject_sha256: sha,
    policy_ref: ref('VersionRef'), decision_version: { type: 'string', minLength: 1, maxLength: 120 }, approved_at: at }),
  Workflow: { ...closed({ definition_id: { type: 'string', pattern: '^(?:onboarding_access_review_v1:[1-9][0-9]*:[A-Za-z0-9-]{1,100}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$' }, process_id: { type: 'string', minLength: 1, maxLength: 200 }, task_id: { type: 'string', minLength: 1, maxLength: 200 }, ended_at: at }), required: ['definition_id'] },
};
definitions.Case = { ...closed({ id: uuid, tenant_id: uuid, requester_subject: subject, display_label: definitions.Create.properties.display_label, created_at: at, updated_at: at,
  state: { enum: ['COLLECTING', 'SUBMITTING', 'AWAITING_APPROVAL', 'APPLYING_DECISION', 'COMPLETED', 'REJECTED', 'RECONCILIATION_REQUIRED'] }, manifest_sha256: sha,
  checklist: { type: 'array', maxItems: 20, items: ref('ChecklistEvidence') }, provisioning_state: { const: 'NOT_PROVISIONED' }, operations: { type: 'array', maxItems: 2, items: ref('Operation') },
  access_request: ref('AccessRequest'), request_sha256: sha, decision: ref('Decision'), workflow: ref('Workflow') }),
  required: ['id', 'tenant_id', 'requester_subject', 'display_label', 'created_at', 'updated_at', 'state', 'manifest_sha256', 'checklist', 'provisioning_state', 'operations'] };
const schema = { $schema: 'http://json-schema.org/draft-07/schema#', $id: 'https://opendx.invalid/proposed/issue60-onboarding.schema.json',
  description: 'Proposed onboarding.case.v1, onboarding.access-request.v1 and onboarding.checklist-evidence.v1. Not registered owning #59 contracts.', definitions };
const target = path.resolve(__dirname, '../../packages/contracts/opendx/proposed/issue60-onboarding.schema.json'); fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(schema, null, 2) + '\n');
