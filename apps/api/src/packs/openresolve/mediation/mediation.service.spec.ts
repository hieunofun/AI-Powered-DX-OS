/* SPDX-License-Identifier: MIT */
import { randomUUID } from 'node:crypto';
import { AiProviderError } from '../../../ai/extraction/extraction-provider';
import { mediationFixture } from '../../../../test/mediation.fixtures';
describe('AI mediation pipeline (SQL/identity/evidence/model/owner policy and decision doubles)', () => {
  let f: ReturnType<typeof mediationFixture>;
  const request = () => f.service.request(f.contexts.requester, f.caseId, { question: 'What evidence is missing?' }, randomUUID());
  async function explained() { const operation = await request(); await f.service.processNext(f.contexts.worker); return operation.resource_ref.id; }
  const propose = async (id: string, tool = 'case.request_evidence') => f.service.propose(f.contexts.requester, id,
    tool === 'case.request_evidence' ? { tool, missing_evidence_codes: ['RECEIPT'] } : { tool, fact_ids: [f.snapshot.facts[0].id] }, randomUUID());
  async function approved() { const proposal = await propose(await explained()); const ref = f.decision(proposal.id);
    await f.service.attachApproval(f.contexts.approver, proposal.id, { decision_ref: ref }, randomUUID()); return proposal; }
  beforeEach(() => { f = mediationFixture(); });
  it('durably acknowledges before model work and exact replay preserves the original PENDING response', async () => {
    const key = randomUUID(), body = { question: 'Why?' }, first = await f.service.request(f.contexts.requester, f.caseId, body, key);
    expect(first.state).toBe('PENDING'); expect(f.provider.select).not.toHaveBeenCalled(); expect(f.store.jobs.size).toBe(1);
    await f.service.processNext(f.contexts.worker);
    expect(await f.service.request(f.contexts.requester, f.caseId, body, key)).toEqual(first); expect(f.store.jobs.size).toBe(1);
    await expect(f.service.request(f.contexts.requester, f.caseId, { question: 'Different?' }, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('reports source-bound facts and server-computed missing evidence without executing a suggestion', async () => {
    const detail = await f.service.detail(f.contexts.requester, await explained());
    expect(detail.result.status).toBe('MISSING_EVIDENCE'); expect(detail.result.missing_evidence).toEqual(['RECEIPT']);
    expect(detail.result.statements[0].citation.evidence_id).toBe(f.snapshot.facts[0].evidenceId); expect(f.executor.executeInTransaction).not.toHaveBeenCalled();
  });
  it('never substitutes worker rights for the revoked requester', async () => {
    const operation = await request(); f.active.delete('requester'); await f.service.processNext(f.contexts.worker);
    expect(f.provider.select).not.toHaveBeenCalled(); expect(f.store.jobs.get(operation.resource_ref.id).operation.state).toBe('FAILED');
  });
  it('rechecks requester membership after remote generation and retains no revoked result', async () => {
    const operation = await request(); f.provider.select.mockImplementation(async (_i, _d, recheck) => { f.active.delete('requester'); await recheck(); return undefined; });
    await f.service.processNext(f.contexts.worker); expect(f.store.jobs.get(operation.resource_ref.id).result).toBeUndefined(); expect(f.executor.executeInTransaction).not.toHaveBeenCalled();
  });
  it('stops provider/tool work when controls are disabled, including during generation', async () => {
    const operation = await request(); f.provider.select.mockImplementation(async (_i, _d, recheck) => { f.store.enabled = false; await recheck(); return undefined; });
    await f.service.processNext(f.contexts.worker); expect(f.store.jobs.get(operation.resource_ref.id).result).toBeUndefined();
    await expect(f.service.processNext(f.contexts.worker)).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' }); expect(f.executor.executeInTransaction).not.toHaveBeenCalled();
  });
  it('rejects non-CLEAN evidence before model disclosure', async () => {
    const operation = await request(); f.state.clean = false; await f.service.processNext(f.contexts.worker);
    expect(f.provider.select).not.toHaveBeenCalled(); expect(f.store.jobs.get(operation.resource_ref.id).operation.state).toBe('FAILED');
  });
  it('freezes source versions and rejects drift instead of attaching a new source to an old result', async () => {
    const operation = await request(); f.snapshot.facts[0].value = 'changed'; f.rehash(); await f.service.processNext(f.contexts.worker);
    const job = f.store.jobs.get(operation.resource_ref.id); expect(job.operation.state).toBe('FAILED'); expect(job.snapshot.facts[0].value).toBe('FICTIONAL Supplier'); expect(f.provider.select).not.toHaveBeenCalled();
  });
  it('requires independent verified approval before a side effect and replays execution exactly once', async () => {
    const proposal = await propose(await explained()); expect(proposal.state).toBe('AWAITING_APPROVAL'); expect(f.store.effects.size).toBe(0);
    await expect(f.service.execute(f.contexts.requester, proposal.id, {}, randomUUID())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const ref = f.decision(proposal.id); await expect(f.service.attachApproval(f.contexts.requester, proposal.id, { decision_ref: ref }, randomUUID())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await f.service.attachApproval(f.contexts.approver, proposal.id, { decision_ref: ref }, randomUUID()); const key = randomUUID();
    const first = await f.service.execute(f.contexts.requester, proposal.id, {}, key); expect(first.state).toBe('EXECUTED');
    expect(await f.service.execute(f.contexts.requester, proposal.id, {}, key)).toEqual(first); await f.service.execute(f.contexts.requester, proposal.id, {}, randomUUID());
    expect(f.store.effects.size).toBe(1); expect(f.executor.executeInTransaction).toHaveBeenCalledTimes(1);
  });
  it('R0 reads current facts and never invokes the side-effect executor', async () => {
    const proposal = await propose(await explained(), 'case.read_summary'); expect(proposal.risk).toBe('R0'); expect(proposal.requires_approval).toBe(false);
    expect((await f.service.execute(f.contexts.requester, proposal.id, {}, randomUUID())).receipt.resource_ref.id).toBe(f.caseId); expect(f.executor.executeInTransaction).not.toHaveBeenCalled();
  });
  it('R2 notes require approval; model/client risk or transfer fields are rejected', async () => {
    const id = await explained(), proposal = await propose(id, 'case.add_note'); expect(proposal.risk).toBe('R2'); expect(proposal.requires_approval).toBe(true);
    for (const body of [{ tool: 'payment.transfer', amount: '1000' }, { tool: 'case.add_note', fact_ids: [f.snapshot.facts[0].id], risk: 'R0' },
      { tool: 'case.add_note', fact_ids: [f.snapshot.facts[0].id], approved: true }]) await expect(f.service.propose(f.contexts.requester, id, body, randomUUID())).rejects.toBeDefined();
  });
  it('revoked decision/approver/policy or changed control revision cannot execute an old approval', async () => {
    for (const kind of ['decision', 'approver', 'policy', 'control']) {
      f = mediationFixture(); const proposal = await approved();
      if (kind === 'decision') f.decisions.clear(); if (kind === 'approver') f.active.delete('approver'); if (kind === 'policy') f.state.policyAllowed = false; if (kind === 'control') f.store.version = '2';
      await expect(f.service.execute(f.contexts.requester, proposal.id, {}, randomUUID())).rejects.toBeDefined(); expect(f.store.effects.size).toBe(0);
    }
  });
  it('rolls back an effect and receipt together, then permits a recreated service to retry the same proposal', async () => {
    const proposal = await approved(), key = randomUUID(); f.state.failExecution = true;
    await expect(f.service.execute(f.contexts.requester, proposal.id, {}, key)).rejects.toThrow('Fixture exception');
    expect(f.store.effects.size).toBe(0); expect(f.store.proposals.get(proposal.id).state).toBe('APPROVED');
    f.state.failExecution = false; expect((await f.createService().execute(f.contexts.requester, proposal.id, {}, key)).state).toBe('EXECUTED'); expect(f.store.effects.size).toBe(1);
  });
  it('bounds persistent retries and preserves every failure without inventing an explanation', async () => {
    const operation = await request(); f.provider.select.mockRejectedValue(new AiProviderError('RATE_LIMITED', true, 1));
    for (let i = 0; i < 3; i++) { await f.createService().processNext(f.contexts.worker); f.advance(); }
    const job = f.store.jobs.get(operation.resource_ref.id); expect(job.operation.state).toBe('FAILED'); expect(job.failures).toHaveLength(3); expect(job.result).toBeUndefined();
  });
  it('foreign-tenant case/explanation/operation/proposal IDs never grant access', async () => {
    const id = await explained(), proposal = await propose(id); const job = f.store.jobs.get(id);
    await expect(f.service.request(f.contexts.foreign, f.caseId, { question: 'Why?' }, randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(f.service.detail(f.contexts.foreign, id)).rejects.toMatchObject({ code: 'NOT_FOUND' }); expect(await f.service.operation(f.contexts.foreign, job.operation.id)).toBeUndefined();
    await expect(f.service.execute(f.contexts.foreign, proposal.id, {}, randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
