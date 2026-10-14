import { AuthenticatedUser } from './interfaces/authenticated-user.interface';

// Signature/issuer/audience verification is owned by the identity adapter.
export interface IdentityPort {
  verifyToken(token:string):Promise<AuthenticatedUser>;
}
