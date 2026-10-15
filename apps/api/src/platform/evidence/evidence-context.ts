/* SPDX-License-Identifier: MIT */
import { Request } from 'express';
import { EvidenceContext } from './evidence.types';
export const EVIDENCE_CONTEXT = Symbol('EVIDENCE_VERIFIED_CONTEXT');
export interface EvidenceContextResolver {
  // Authenticate and revalidate active membership server-side on every request.
  // Body/query/header tenant claims are never trusted identity sources.
  resolve(request: Request): Promise<EvidenceContext>;
}
