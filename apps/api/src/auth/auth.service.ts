import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import { AuthenticatedUser } from './interfaces/authenticated-user.interface';
import { KeycloakJwtPayload } from './interfaces/keycloak-jwt-payload.interface';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly expectedIssuer: string;
  private readonly expectedAudience: string;
  private readonly jwksUri: string;
  private readonly jwksClient: jwksRsa.JwksClient;

  // Keycloak internal/default roles that are not business domain roles
  private static readonly IGNORED_REALM_ROLES = new Set([
    'default-roles-smartprocure',
    'offline_access',
    'uma_authorization',
  ]);

  constructor() {
    this.expectedIssuer =
      process.env.KEYCLOAK_ISSUER || 'http://localhost:8080/realms/smartprocure';
    this.expectedAudience = process.env.KEYCLOAK_AUDIENCE || 'smartprocure-api';
    this.jwksUri =
      process.env.KEYCLOAK_JWKS_URI ||
      `${this.expectedIssuer}/protocol/openid-connect/certs`;

    this.jwksClient = jwksRsa({
      jwksUri: this.jwksUri,
      cache: true,
      cacheMaxEntries: 10,
      cacheMaxAge: 600000, // 10 minutes
      rateLimit: true,
      jwksRequestsPerMinute: 10,
    });
  }

  /**
   * Normalizes roles extracted from Keycloak token payload.
   * Strategy: inspects realm_access.roles and filters out default infrastructure roles.
   */
  public extractRoles(payload: KeycloakJwtPayload): string[] {
    const rawRoles = payload.realm_access?.roles || [];
    return rawRoles
      .filter((role) => !AuthService.IGNORED_REALM_ROLES.has(role))
      .map((role) => role.toLowerCase());
  }

  /**
   * Transforms Keycloak claims into standard AuthenticatedUser principal.
   */
  public normalizeUser(payload: KeycloakJwtPayload): AuthenticatedUser {
    return {
      sub: payload.sub,
      username: payload.preferred_username || payload.sub,
      email: payload.email,
      roles: this.extractRoles(payload),
    };
  }

  /**
   * Validates a raw Bearer JWT against Keycloak JWKS and returns the verified user principal.
   */
  async verifyToken(token: string): Promise<AuthenticatedUser> {
    try {
      const decoded = jwt.decode(token, { complete: true });
      if (!decoded || typeof decoded !== 'object' || !decoded.header?.kid) {
        throw new UnauthorizedException('Malformed token: missing kid in header');
      }

      const signingKey = await this.jwksClient.getSigningKey(decoded.header.kid);
      const publicKey = signingKey.getPublicKey();

      const payload = jwt.verify(token, publicKey, {
        issuer: this.expectedIssuer,
        audience: this.expectedAudience,
        algorithms: ['RS256'],
      }) as KeycloakJwtPayload;

      return this.normalizeUser(payload);
    } catch (err: unknown) {
      if (err instanceof UnauthorizedException) {
        throw err;
      }

      if (err instanceof jwt.TokenExpiredError) {
        throw new UnauthorizedException('Token has expired');
      }

      if (err instanceof jwt.JsonWebTokenError) {
        throw new UnauthorizedException(`Token verification failed: ${err.message}`);
      }

      const message = err instanceof Error ? err.message : 'Unknown authentication error';
      this.logger.warn(`JWT verification error: ${message}`);
      throw new UnauthorizedException('Authentication failed');
    }
  }
}
