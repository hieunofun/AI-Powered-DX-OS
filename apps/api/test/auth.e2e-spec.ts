import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, UnauthorizedException } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';

describe('AuthController (e2e)', () => {
  let app: INestApplication;

  const mockBuyer = {
    sub: 'sub-buyer-1234',
    username: 'buyer.demo',
    email: 'buyer.demo@smartprocure.local',
    roles: ['buyer'],
  };

  const mockAdmin = {
    sub: 'sub-admin-5678',
    username: 'admin.demo',
    email: 'admin.demo@smartprocure.local',
    roles: ['admin'],
  };

  const mockAuthService = {
    verifyToken: jest.fn(async (token: string) => {
      if (token === 'valid-buyer-token') {
        return mockBuyer;
      }
      if (token === 'valid-admin-token') {
        return mockAdmin;
      }
      if (token === 'expired-token') {
        throw new UnauthorizedException('Token has expired');
      }
      if (token === 'wrong-audience-token') {
        throw new UnauthorizedException('Token verification failed: jwt audience invalid. expected: smartprocure-api');
      }
      if (token === 'missing-audience-token') {
        throw new UnauthorizedException('Token verification failed: jwt audience invalid. expected: smartprocure-api');
      }
      throw new UnauthorizedException('Invalid or unknown token');
    }),
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthService)
      .useValue(mockAuthService)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Unauthenticated requests (401)', () => {
    it('/auth/me (GET) without Authorization header should return 401', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .expect(401);

      expect(response.body.message).toContain('Missing Authorization header');
    });

    it('/auth/me (GET) with invalid scheme should return 401', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', 'Basic dXNlcjpwYXNz')
        .expect(401);

      expect(response.body.message).toContain('Invalid Authorization header format');
    });

    it('/auth/me (GET) with expired token should return 401', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', 'Bearer expired-token')
        .expect(401);

      expect(response.body.message).toContain('Token has expired');
    });

    it('/auth/me (GET) with token having wrong audience should return 401', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', 'Bearer wrong-audience-token')
        .expect(401);

      expect(response.body.message).toContain('jwt audience invalid');
    });

    it('/auth/me (GET) with token missing audience should return 401', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', 'Bearer missing-audience-token')
        .expect(401);

      expect(response.body.message).toContain('jwt audience invalid');
    });
  });

  describe('Authenticated user profile (/auth/me)', () => {
    it('should return normalized user principal for valid buyer token', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', 'Bearer valid-buyer-token')
        .expect(200);

      expect(response.body).toEqual({
        sub: 'sub-buyer-1234',
        username: 'buyer.demo',
        email: 'buyer.demo@smartprocure.local',
        roles: ['buyer'],
      });
      // Ensure no raw token or secrets leaked
      expect(response.body.token).toBeUndefined();
      expect(response.body.password).toBeUndefined();
    });

    it('should return normalized user principal for valid admin token', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', 'Bearer valid-admin-token')
        .expect(200);

      expect(response.body).toEqual({
        sub: 'sub-admin-5678',
        username: 'admin.demo',
        email: 'admin.demo@smartprocure.local',
        roles: ['admin'],
      });
    });
  });

  describe('Role-Based Access Control (/auth/buyer-test and /auth/admin-test)', () => {
    it('buyer token accessing buyer endpoint should return 200', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/buyer-test')
        .set('Authorization', 'Bearer valid-buyer-token')
        .expect(200);

      expect(response.body.message).toBe('Buyer authorization test passed');
      expect(response.body.user.username).toBe('buyer.demo');
    });

    it('buyer token accessing admin endpoint should return 403 Forbidden', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/admin-test')
        .set('Authorization', 'Bearer valid-buyer-token')
        .expect(403);

      expect(response.body.statusCode).toBe(403);
      expect(response.body.error).toBe('Forbidden');
      expect(response.body.message).toContain('Insufficient role permissions');
    });

    it('admin token accessing admin endpoint should return 200', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/admin-test')
        .set('Authorization', 'Bearer valid-admin-token')
        .expect(200);

      expect(response.body.message).toBe('Admin authorization test passed');
      expect(response.body.user.username).toBe('admin.demo');
    });

    it('admin token accessing buyer endpoint should also return 200 (buyer or admin allowed)', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/buyer-test')
        .set('Authorization', 'Bearer valid-admin-token')
        .expect(200);

      expect(response.body.message).toBe('Buyer authorization test passed');
    });
  });
});
