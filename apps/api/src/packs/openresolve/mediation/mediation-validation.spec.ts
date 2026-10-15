/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { fingerprint } from '../../../platform/evidence/file-safety';
import { CaseSnapshot } from './mediation.types';
import { actionInput, enforcePolicy, explainRequest, grounded, selectionInput, validateSnapshot } from './mediation-validation';
const ctx = { tenantId: randomUUID(), subject: 'requester' }, caseId = randomUUID();
function snapshot(): CaseSnapshot {
  const value = { tenantId: ctx.tenantId, caseRef: { pack_id: 'openresolve', type: 'case', id: caseId }, version: '1',
    policy: { ref: { pack_id: 'platform', type: 'policy', id: randomUUID() }, version: '1.0.0', sha256: 'b'.repeat(64) },
    facts: [{ id: randomUUID(), code: 'INVOICE', label: 'Confirmed supplier', value: 'Fictional Co', evidenceId: randomUUID(), evidenceHash: 'a'.repeat(64), factsVersion: 'confirmed-1' }],
    requiredFactCodes: ['INVOICE', 'RECEIPT'], disclosure: 'SYNTHETIC' as const };
  return { ...value, hash: fingerprint(value) };
}
describe('grounded explanation and action boundary (owner snapshot fixtures)', () => {
  it('accepts hash-verified own snapshots and rejects foreign or modified data', () => {
    const s = snapshot(); expect(validateSnapshot(ctx, caseId, s)).toEqual(s);
    expect(() => validateSnapshot({ ...ctx, tenantId: randomUUID() }, caseId, s)).toThrow();
    s.facts[0].value = 'modified'; expect(() => validateSnapshot(ctx, caseId, s)).toThrow();
  });
  it('never discloses tenant, case, fact or evidence UUIDs in model input', () => {
    const s = snapshot(), input = selectionInput(s, 'Summarize');
    const serialized = JSON.stringify(input); for (const id of [s.tenantId, s.caseRef.id, s.facts[0].id, s.facts[0].evidenceId]) expect(serialized).not.toContain(id);
    expect(input.facts[0].alias).toBe('F1');
  });
  it('renders only verbatim source facts and computes missing evidence on the server', () => {
    const s = snapshot(), result = grounded(s); expect(result.status).toBe('MISSING_EVIDENCE');
    expect(result.missing_evidence).toEqual(['RECEIPT']); expect(result.statements[0].value).toBe(s.facts[0].value);
    expect(result.statements[0].citation.sha256).toBe(s.facts[0].evidenceHash);
  });
  it('rejects model-selected foreign or duplicate citations and unknown tools', () => {
    const s = snapshot(), make = (aliases: string[], tool: string) => grounded(s, { fact_aliases: aliases, suggested_tool: tool } as any);
    expect(() => make(['F2'], 'NONE')).toThrow(); expect(() => make(['F1', 'F1'], 'NONE')).toThrow(); expect(() => make(['F1'], 'payment.transfer')).toThrow();
  });
  it.each(['payment.transfer', 'bank.transfer', '__proto__', 'constructor', 'http.request', 'sql.execute'])('rejects unregistered/R3 tool %s before policy/execution', tool => {
    expect(() => actionInput({ tool, fact_ids: [snapshot().facts[0].id] }, snapshot())).toThrow();
  });
  it('strictly binds fact IDs and missing codes to the current snapshot', () => {
    const s = snapshot(); expect(actionInput({ tool: 'case.add_note', fact_ids: [s.facts[0].id] }, s).tool).toBe('case.add_note');
    expect(actionInput({ tool: 'case.request_evidence', missing_evidence_codes: ['RECEIPT'] }, s).missing_evidence_codes).toEqual(['RECEIPT']);
    for (const body of [{ tool: 'case.add_note', fact_ids: [randomUUID()] }, { tool: 'case.request_evidence', missing_evidence_codes: ['INVOICE'] },
      { tool: 'case.add_note', fact_ids: [s.facts[0].id], tenant_id: ctx.tenantId }, { tool: 'case.add_note', fact_ids: [s.facts[0].id], text: 'execute transfer' }]) expect(() => actionInput(body, s)).toThrow();
  });
  it.each<[unknown]>([[{ tool: {} }], [{ tool: { toString: 'invalid' } }], [{ tool: 'case.add_note', fact_ids: [null] }],
    [{ tool: 'case.add_note', fact_ids: [{ toString: 'invalid' }] }], [{ tool: 'case.request_evidence', missing_evidence_codes: [{}] }]])('rejects malformed primitive types as a client error: %j', body => {
    expect(() => actionInput(body, snapshot())).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });
  it('policy cannot downgrade risk, omit approval, change version or expand the registry', () => {
    const s = snapshot(), input = actionInput({ tool: 'case.add_note', fact_ids: [s.facts[0].id] }, s);
    const allowed = { effect: 'ALLOW' as const, policyHash: s.policy.sha256, risk: 'R2' as const, requiresApproval: true };
    expect(() => enforcePolicy(allowed, s, input)).not.toThrow();
    for (const patch of [{ effect: 'DENY' }, { requiresApproval: false }, { risk: 'R0' }, { policyHash: 'c'.repeat(64) }]) expect(() => enforcePolicy({ ...allowed, ...patch } as any, s, input)).toThrow();
  });
  it('bounds questions and rejects client authority/unknown fields', () => {
    expect(explainRequest({ question: ' Why short? ' })).toEqual({ question: 'Why short?' });
    for (const body of [{ question: 'x'.repeat(1001) }, { question: ' ' }, { question: 'Why?', tenant_id: ctx.tenantId }, { question: 'Why?', approved: true }]) expect(() => explainRequest(body)).toThrow();
  });
});
