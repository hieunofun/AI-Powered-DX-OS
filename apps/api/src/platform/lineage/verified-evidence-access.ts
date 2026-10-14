/* SPDX-License-Identifier: MIT */
import { Request } from 'express';
import { EvidenceContextResolver } from '../evidence/evidence-context';
import { EvidenceAccess, EvidenceContext, fail } from '../evidence/evidence.types';
import { contextValid, UUID } from '../evidence/file-safety';
import { LineageAccess, ResourceRef } from './lineage.types';
export interface VerifiedTokenIdentity { verifyToken(token: string): Promise<{ sub: string }>; }
export interface CurrentTenantAuthority {
  // Resolve a verified subject's current active membership; tenant selection is not a grant.
  resolve(subject: string, selectedTenant?: string): Promise<EvidenceContext>;
  // Required on every request/worker/provider/download boundary. Fail closed for unknown actions/resources.
  authorize(context: EvidenceContext, action: string, resource?: ResourceRef, policy?: { retentionClass: 'STANDARD' | 'RESTRICTED' }): Promise<void>;
}
export class MembershipEvidenceResolver implements EvidenceContextResolver {
  constructor(private readonly identity: VerifiedTokenIdentity, private readonly authority: CurrentTenantAuthority) {
    if (!identity?.verifyToken || !authority?.resolve || !authority?.authorize) throw new Error('Verified identity and current tenant authority are required.');
  }
  async resolve(request: Request): Promise<EvidenceContext> {
    const authorization = request.header('Authorization');
    if (typeof authorization !== 'string' || authorization.length > 16384 || !/^Bearer [A-Za-z0-9._~-]+(?![\s\S])/.test(authorization)) fail('UNAUTHENTICATED', 401);
    const selected = request.header('X-Tenant-ID'); if (selected !== undefined && !UUID.test(selected)) fail('TENANT_CONTEXT_REQUIRED');
    let principal: { sub: string };
    try { principal = await this.identity.verifyToken(authorization.slice(7)); } catch { fail('UNAUTHENTICATED', 401); }
    if (!principal || typeof principal.sub !== 'string' || !principal.sub || principal.sub.length > 200) fail('UNAUTHENTICATED', 401);
    const context = await this.authority.resolve(principal.sub, selected); contextValid(context);
    if (context.subject !== principal.sub || selected && context.tenantId !== selected) fail('FORBIDDEN', 403);
    await this.authority.authorize(context, 'context.read');
    return context;
  }
}
export class MembershipEvidenceAccess implements EvidenceAccess, LineageAccess {
  constructor(private readonly authority: CurrentTenantAuthority) {
    if (!authority?.authorize) throw new Error('Current tenant/resource authority is required.');
  }
  async check(context: EvidenceContext, action: string, evidenceOrRef?: string | ResourceRef, policy?: { retentionClass: 'STANDARD' | 'RESTRICTED' }) {
    contextValid(context);
    const ref = typeof evidenceOrRef === 'string' ? { pack_id: 'platform', type: 'evidence', id: evidenceOrRef } : evidenceOrRef;
    if (ref && !UUID.test(ref.id)) fail('INVALID_REQUEST');
    await this.authority.authorize(context, action, ref, policy);
  }
}
