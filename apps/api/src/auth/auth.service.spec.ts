import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

describe('AuthService', () => {
  let authService: AuthService;
  let privateKey: string;
  let publicKey: string;

  beforeAll(() => {
    // Generate an RSA keypair for cryptographic JWT verification testing
    const { privateKey: priv, publicKey: pub } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    privateKey = priv;
    publicKey = pub;
  });

  beforeEach(() => {
    process.env.KEYCLOAK_ISSUER = 'http://localhost:8080/realms/smartprocure';
    process.env.KEYCLOAK_AUDIENCE = 'smartprocure-api';
    process.env.KEYCLOAK_JWKS_URI =
      'http://localhost:8080/realms/smartprocure/protocol/openid-connect/certs';
    authService = new AuthService();

    // Mock remote JWKS client to return our test public key
    (authService as any).jwksClient = {
      getSigningKey: jest.fn().mockResolvedValue({
        getPublicKey: () => publicKey,
      }),
    };
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

  describe('verifyToken & Audience Enforcement', () => {
    const validClaims = {
      sub: 'usr-test-123',
      preferred_username: 'buyer.demo',
      email: 'buyer.demo@smartprocure.local',
      iss: 'http://localhost:8080/realms/smartprocure',
      aud: 'smartprocure-api',
      realm_access: {
        roles: ['buyer'],
      },
    };

    it('should accept valid RS256 token when signature, issuer, and audience match', async () => {
      const token = jwt.sign(validClaims, privateKey, {
        algorithm: 'RS256',
        keyid: 'test-kid-1',
        expiresIn: '1h',
      });

      const user = await authService.verifyToken(token);

      expect(user).toEqual({
        sub: 'usr-test-123',
        username: 'buyer.demo',
        email: 'buyer.demo@smartprocure.local',
        roles: ['buyer'],
      });
    });

    it('should accept valid RS256 token when aud claim is an array containing smartprocure-api', async () => {
      const token = jwt.sign(
        {
          ...validClaims,
          aud: ['smartprocure-web', 'smartprocure-api'],
        },
        privateKey,
        {
          algorithm: 'RS256',
          keyid: 'test-kid-1',
          expiresIn: '1h',
        },
      );

      const user = await authService.verifyToken(token);
      expect(user.username).toBe('buyer.demo');
      expect(user.roles).toContain('buyer');
    });

    it('should reject correctly signed token when audience is missing', async () => {
      const claimsWithoutAud = { ...validClaims };
      delete (claimsWithoutAud as any).aud;

      const token = jwt.sign(claimsWithoutAud, privateKey, {
        algorithm: 'RS256',
        keyid: 'test-kid-1',
        expiresIn: '1h',
      });

      await expect(authService.verifyToken(token)).rejects.toThrow(UnauthorizedException);
      await expect(authService.verifyToken(token)).rejects.toThrow(
        /jwt audience invalid|Token verification failed/,
      );
    });

    it('should reject correctly signed token when audience is wrong', async () => {
      const claimsWrongAud = {
        ...validClaims,
        aud: 'other-untrusted-api',
      };

      const token = jwt.sign(claimsWrongAud, privateKey, {
        algorithm: 'RS256',
        keyid: 'test-kid-1',
        expiresIn: '1h',
      });

      await expect(authService.verifyToken(token)).rejects.toThrow(UnauthorizedException);
      await expect(authService.verifyToken(token)).rejects.toThrow(
        /jwt audience invalid|Token verification failed/,
      );
    });

    it('should reject token when issuer is wrong', async () => {
      const claimsWrongIss = {
        ...validClaims,
        iss: 'http://rogue-idp.local/realms/fake',
      };

      const token = jwt.sign(claimsWrongIss, privateKey, {
        algorithm: 'RS256',
        keyid: 'test-kid-1',
        expiresIn: '1h',
      });

      await expect(authService.verifyToken(token)).rejects.toThrow(UnauthorizedException);
      await expect(authService.verifyToken(token)).rejects.toThrow(
        /jwt issuer invalid|Token verification failed/,
      );
    });

    it('should reject token when token has expired', async () => {
      const token = jwt.sign(validClaims, privateKey, {
        algorithm: 'RS256',
        keyid: 'test-kid-1',
        expiresIn: '-10s', // already expired
      });

      await expect(authService.verifyToken(token)).rejects.toThrow(UnauthorizedException);
      await expect(authService.verifyToken(token)).rejects.toThrow('Token has expired');
    });

    it('should throw UnauthorizedException if token header does not contain kid', async () => {
      const tokenWithoutKid = jwt.sign({ sub: 'test' }, 'symmetric-secret', {
        noTimestamp: true,
      });

      await expect(authService.verifyToken(tokenWithoutKid)).rejects.toThrow(UnauthorizedException);
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
