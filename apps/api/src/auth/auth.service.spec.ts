import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import jwt from 'jsonwebtoken';

describe('AuthService', () => {
  let authService: AuthService;

  beforeEach(() => {
    // Provide test env vars
    process.env.KEYCLOAK_ISSUER = 'http://localhost:8080/realms/smartprocure';
    process.env.KEYCLOAK_JWKS_URI = 'http://localhost:8080/realms/smartprocure/protocol/openid-connect/certs';
    authService = new AuthService();
  });

  describe('normalizeUser', () => {
    it('should correctly normalize claims into an AuthenticatedUser', () => {
      const payload = {
        sub: 'usr-1234-uuid',
        preferred_username: 'buyer.demo',
        email: 'buyer.demo@smartprocure.local',
        realm_access: {
          roles: ['buyer', 'default-roles-smartprocure', 'offline_access'],
        },
      };

      const user = authService.normalizeUser(payload as any);

      expect(user).toEqual({
        sub: 'usr-1234-uuid',
        username: 'buyer.demo',
        email: 'buyer.demo@smartprocure.local',
        roles: ['buyer'],
      });
    });

    it('should fall back to sub when preferred_username is missing', () => {
      const payload = {
        sub: 'usr-no-username',
        realm_access: {
          roles: ['admin'],
        },
      };

      const user = authService.normalizeUser(payload as any);

      expect(user.username).toBe('usr-no-username');
      expect(user.roles).toEqual(['admin']);
      expect(user.email).toBeUndefined();
    });

    it('should handle payload with no realm_access or empty roles', () => {
      const payload = {
        sub: 'usr-no-roles',
        preferred_username: 'plain.user',
      };

      const user = authService.normalizeUser(payload as any);

      expect(user.roles).toEqual([]);
    });

    it('should filter out all internal Keycloak default roles', () => {
      const payload = {
        sub: 'usr-filtered',
        preferred_username: 'filtered.user',
        realm_access: {
          roles: [
            'default-roles-smartprocure',
            'offline_access',
            'uma_authorization',
            'accountant',
          ],
        },
      };

      const user = authService.normalizeUser(payload as any);

      expect(user.roles).toEqual(['accountant']);
    });
  });

  describe('verifyToken', () => {
    it('should throw UnauthorizedException if token header does not contain kid', async () => {
      const tokenWithoutKid = jwt.sign(
        { sub: 'test' },
        'secret',
        { noTimestamp: true }, // signs without kid by default in symmetric
      );

      await expect(authService.verifyToken(tokenWithoutKid)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(authService.verifyToken(tokenWithoutKid)).rejects.toThrow(
        'Malformed token: missing kid in header',
      );
    });

    it('should throw UnauthorizedException if token is completely malformed', async () => {
      await expect(authService.verifyToken('not.a.valid.jwt.token')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
