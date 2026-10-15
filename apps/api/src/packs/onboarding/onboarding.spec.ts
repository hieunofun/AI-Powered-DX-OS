/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { onboardingFixture, requester, reviewer, processor, foreign } from '../../../test/onboarding.fixtures';
import { accessInput, binding, checklistInput, createInput, decisionInput } from './onboarding-validation';
describe('Onboarding state/recovery invariants (labelled SQL/engine/owner doubles)', () => {
  test.each([{}, { display_label: ' ' }, { display_label: 'x', tenant_id: foreign.tenantId }, { display_label: 'x'.repeat(161) }])('rejects invalid/client-owned creation fields %j', value => expect(() => createInput(value)).toThrow());
  test.each([{ access_profile: 'ADMIN' }, { access_profile: 'DOCS_READ_ONLY', scopes: ['ROOT'] }])('rejects arbitrary profiles/scopes %j', value => expect(() => accessInput(value)).toThrow());
  test('checklist cannot be a claimed approval or unconstrained revision', () => {
    expect(() => checklistInput('WELCOME_ACK', { evidence_id: randomUUID(), acknowledged: false, expected_revision: 0 })).toThrow();
    expect(() => checklistInput('WELCOME_ACK', { evidence_id: randomUUID(), acknowledged: true, expected_revision: 10 })).toThrow();
    expect(() => decisionInput({ decision_ref: { pack_id: 'onboarding', type: 'decision', id: randomUUID() } })).toThrow();
  });
  test.each(['enabled', 'manifest_sha256', 'core_version', 'workflow'])('requires current compatible registered binding: %s', field => {
    const f = onboardingFixture(), current: any = structuredClone(f.current);
    current[field] = field === 'enabled' ? false : field === 'workflow' ? { ...current.workflow, reviewer_group: 'foreign-reviewers' } : 'wrong';
    expect(() => binding(requester, 'onboarding.case.create', current)).toThrow();
  });
  test('idempotent create returns exact same view, changed body conflicts and revoked read blocks replay', async () => {
    const f = onboardingFixture(), key = randomUUID(), first = await f.service.create(requester, { display_label: 'Fixture' }, key);
    expect(await f.service.create(requester, { display_label: 'Fixture' }, key)).toEqual(first);
    await expect(f.service.create(requester, { display_label: 'Different' }, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    f.denied.add('onboarding.case.read'); await expect(f.service.create(requester, { display_label: 'Fixture' }, key)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.store.records.size).toBe(1);
  });
  test('opaque native Flowable UUID definition is pinned through a complete approved case', async () => {
    const f = onboardingFixture(); f.current.workflow.definition_id = randomUUID(); const id = await f.deciding();
    expect(await f.worker().processNext(processor)).toMatchObject({ state: 'SUCCEEDED' });
    expect((await f.store.read(requester, id)).workflow.definitionId).toBe(f.current.workflow.definition_id);
  });
  test('another native UUID cannot replace the pinned process definition during reconciliation', async () => {
    const f = onboardingFixture(); f.current.workflow.definition_id = randomUUID(); const id = await f.ready(); f.engine.fault = 'start-after'; await f.worker().processNext(processor);
    f.engine.rows[0].processDefinitionId = randomUUID(); await f.worker().reconcile(processor, id);
    expect((await f.store.read(requester, id)).state).toBe('RECONCILIATION_REQUIRED'); expect(f.engine.starts).toBe(1);
  });
  test('save/lineage failure rolls back record, history and idempotency', async () => {
    const f = onboardingFixture(); f.store.failSave = true; await expect(f.create()).rejects.toThrow('Injected');
    expect(f.store.records.size).toBe(0); expect(f.store.commands.size).toBe(0); expect(f.store.history).toHaveLength(0);
  });
  test('foreign case and operation IDs cannot be read', async () => {
    const f = onboardingFixture(), id = await f.ready(), op = (await f.store.read(requester, id)).operations[0];
    await expect(f.service.detail(foreign, id)).rejects.toMatchObject({ code: 'NOT_FOUND' }); expect(await f.service.operation(foreign, op.id)).toBeUndefined();
  });
  test('both current clean receipts required; revisions and submitted receipts are immutable', async () => {
    const f = onboardingFixture(), record = await f.create(); await expect(f.submit(record.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await f.checklist(record.id); await expect(f.service.recordChecklist(requester, record.id, 'WELCOME_ACK', { evidence_id: f.evidenceId, acknowledged: true, expected_revision: 0 }, randomUUID())).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await f.submit(record.id); await expect(f.service.recordChecklist(requester, record.id, 'WELCOME_ACK', { evidence_id: f.evidenceId, acknowledged: true, expected_revision: 1 }, randomUUID())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(f.engine.starts).toBe(0);
  });
  test.each(['APPROVE', 'REJECT'] as const)('only verified independent %s can end the workflow; no provisioning', async action => {
    const f = onboardingFixture(), id = await f.deciding(action); expect(await f.worker().processNext(processor)).toMatchObject({ state: 'SUCCEEDED' });
    const result = await f.service.detail(requester, id); expect(result.state).toBe(action === 'APPROVE' ? 'COMPLETED' : 'REJECTED');
    expect(result.provisioning_state).toBe('NOT_PROVISIONED'); expect(f.engine.starts).toBe(1); expect(f.engine.claims).toBe(1); expect(f.engine.completions).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/lease|failures|businessKey|decision_snapshot/);
  });
  test('self approval, unowned references and mismatched subject hash cannot enqueue decision', async () => {
    const f = onboardingFixture(), id = await f.awaiting(), ref = await f.decision(id);
    await expect(f.service.decide(requester, id, { decision_ref: ref }, randomUUID())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    f.decisions.get(ref.id).subject_sha256 = 'f'.repeat(64); await expect(f.service.decide(reviewer, id, { decision_ref: ref }, randomUUID())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await f.store.read(requester, id)).decision).toBeUndefined(); expect(f.engine.completions).toBe(0);
  });
  test.each(['requester', 'worker', 'evidence', 'decision', 'disabled', 'tampered'])('current %s revocation/tamper prevents engine completion', async kind => {
    const f = onboardingFixture(), id = await f.deciding();
    if (kind === 'requester') f.denied.add(requester.subject); if (kind === 'worker') f.denied.add('evidence:' + processor.subject);
    if (kind === 'evidence') f.evidence.quarantine_state = 'INFECTED'; if (kind === 'decision') f.denied.add('decision');
    if (kind === 'disabled') f.current.enabled = false; if (kind === 'tampered') f.tamper();
    if (kind === 'disabled') await expect(f.worker().processNext(processor)).rejects.toMatchObject({ code: 'PACK_DISABLED' }); else await f.worker().processNext(processor);
    expect(f.engine.completions).toBe(0); expect((await f.store.read(requester, id)).state).not.toBe('COMPLETED');
  });
  test('ambiguous successful start recovers through reads after worker recreation; never starts twice', async () => {
    const f = onboardingFixture(), id = await f.ready(); f.engine.fault = 'start-after';
    expect(await f.worker().processNext(processor)).toMatchObject({ state: 'RECONCILIATION_REQUIRED' }); expect(f.engine.starts).toBe(1);
    expect(await f.worker().reconcile(processor, id)).toMatchObject({ state: 'SUCCEEDED' }); expect(f.engine.starts).toBe(1); expect(f.engine.claims).toBe(0);
  });
  test('ambiguous start without proof cannot redispatch even on manual reconciliation', async () => {
    const f = onboardingFixture(), id = await f.ready(); f.engine.fault = 'start-after'; await f.worker().processNext(processor); f.engine.rows = [];
    await f.worker().reconcile(processor, id); await f.worker().processNext(processor); expect(f.engine.starts).toBe(1); expect((await f.store.read(requester, id)).state).toBe('RECONCILIATION_REQUIRED');
  });
  test('safe pre-dispatch failure gets bounded retries and does not silently become approval', async () => {
    const f = onboardingFixture(), id = await f.ready(); f.engine.fault = 'start-before';
    for (let index = 0; index < 4; index++) { await f.worker().processNext(processor); f.advance(10000); }
    expect(f.engine.starts).toBe(3); expect((await f.store.read(requester, id)).intent.failures).toHaveLength(3); expect(f.engine.completions).toBe(0);
  });
  test('ambiguous successful completion finalizes from local operation marker and history, with one completion', async () => {
    const f = onboardingFixture(), id = await f.deciding(); f.engine.fault = 'complete-after'; await f.worker().processNext(processor);
    expect((await f.store.read(requester, id)).state).toBe('RECONCILIATION_REQUIRED');
    expect(await f.worker().reconcile(processor, id)).toMatchObject({ state: 'SUCCEEDED' }); expect(f.engine.completions).toBe(1);
  });
  test('ambiguous claim reconciliation performs no engine writes; verified next worker may complete once', async () => {
    const f = onboardingFixture(), id = await f.deciding(); f.engine.fault = 'claim-after'; await f.worker().processNext(processor);
    await f.worker().reconcile(processor, id); expect(f.engine.claims).toBe(1); expect(f.engine.completions).toBe(0);
    await f.worker().processNext(processor); expect(f.engine.claims).toBe(1); expect(f.engine.completions).toBe(1); expect((await f.store.read(requester, id)).state).toBe('COMPLETED');
  });
  test.each(['operation', 'scope', 'assignee', 'process', 'endTime'])('historic %s mismatch cannot prove a completion', async kind => {
    const f = onboardingFixture(), id = await f.deciding(); f.engine.fault = 'complete-after'; await f.worker().processNext(processor);
    if (kind === 'operation') f.engine.historyRow.variables[0].value = randomUUID(); if (kind === 'scope') f.engine.historyRow.variables[0].scope = 'global';
    if (kind === 'assignee') f.engine.historyRow.assignee = 'other'; if (kind === 'process') f.engine.historyRow.processInstanceId = randomUUID(); if (kind === 'endTime') f.engine.rows[0].endTime = null;
    await f.worker().reconcile(processor, id); expect((await f.store.read(requester, id)).state).not.toBe('COMPLETED'); expect(f.engine.completions).toBe(1);
  });
  test('revocation after engine completion withholds final state until current authority is restored', async () => {
    const f = onboardingFixture(), id = await f.deciding(); f.engine.afterWrite = () => { if (f.engine.completions) f.denied.add('decision'); };
    await f.worker().processNext(processor); expect((await f.store.read(requester, id)).state).toBe('RECONCILIATION_REQUIRED');
    f.denied.delete('decision'); await f.worker().reconcile(processor, id); expect((await f.store.read(requester, id)).state).toBe('COMPLETED'); expect(f.engine.completions).toBe(1);
  });
  test('concurrent workers lease one durable intent', async () => {
    const f = onboardingFixture(), id = await f.ready(); await Promise.all([f.worker().processNext(processor), f.worker().processNext(processor)]);
    expect(f.engine.starts).toBe(1); expect((await f.store.read(requester, id)).state).toBe('AWAITING_APPROVAL');
  });
});
