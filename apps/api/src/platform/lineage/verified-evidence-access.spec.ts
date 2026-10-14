/* SPDX-License-Identifier: MIT */
import { Request } from 'express';
import { MembershipEvidenceAccess, MembershipEvidenceResolver } from './verified-evidence-access';
import { context, foreign } from '../../../test/evidence.fixtures';
import { fail } from '../evidence/evidence.types';
const request = (headers: Record<string, string>) => ({ header: name => headers[name] } as Request);
describe('verified evidence context bridge (identity/authority doubles)', () => {
  let verifyToken: jest.Mock, resolve: jest.Mock, authorize: jest.Mock, resolver: MembershipEvidenceResolver;
  beforeEach(() => {
    verifyToken = jest.fn(async () => ({ sub: context.subject })); resolve = jest.fn(async () => context); authorize = jest.fn(async () => undefined);
    resolver = new MembershipEvidenceResolver({ verifyToken }, { resolve, authorize });
  });
  test('verifies bearer then current membership and context grant; roles/body are not authority', async () => {
    expect(await resolver.resolve(request({ Authorization: 'Bearer fixture.signed.token' }))).toEqual(context);
    expect(verifyToken).toHaveBeenCalledWith('fixture.signed.token'); expect(resolve).toHaveBeenCalledWith(context.subject, undefined);
    expect(authorize).toHaveBeenCalledWith(context, 'context.read');
  });
  test.each([undefined, 'Basic injected', 'Bearer a b', 'Bearer token\n'])('rejects malformed authorization %s', async authorization => {
    await expect(resolver.resolve(request({ Authorization: authorization }))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' }); expect(resolve).not.toHaveBeenCalled();
  });
  test('signature/issuer/audience/expiry verification failures cannot reach membership lookup', async () => {
    verifyToken.mockRejectedValue(new Error('invalid signature'));
    await expect(resolver.resolve(request({ Authorization: 'Bearer invalid' }))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' }); expect(resolve).not.toHaveBeenCalled();
  });
  test('tenant header is only a selector and cannot replace authoritative membership', async () => {
    await expect(resolver.resolve(request({ Authorization: 'Bearer valid', 'X-Tenant-ID': foreign.tenantId }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(resolve).toHaveBeenCalledWith(context.subject, foreign.tenantId);
  });
  test('authority cannot replace the verified principal', async () => {
    resolve.mockResolvedValue({ ...context, subject: 'injected' });
    await expect(resolver.resolve(request({ Authorization: 'Bearer valid' }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  test('worker/download/provider boundaries always call current authority, including retention', async () => {
    const access = new MembershipEvidenceAccess({ resolve, authorize });
    await access.check(context, 'evidence.download', foreign.tenantId, { retentionClass: 'RESTRICTED' });
    expect(authorize).toHaveBeenCalledWith(context, 'evidence.download', { pack_id: 'platform', type: 'evidence', id: foreign.tenantId }, { retentionClass: 'RESTRICTED' });
    authorize.mockImplementation(async () => fail('FORBIDDEN', 403));
    await expect(access.check(context, 'extraction.request', foreign.tenantId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(authorize).toHaveBeenCalledTimes(2);
  });
});
