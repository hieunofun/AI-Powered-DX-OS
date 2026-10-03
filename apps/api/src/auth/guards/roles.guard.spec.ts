import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  const createMockContext = (user?: any): ExecutionContext => {
    const request: any = { user };
    return {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: jest.fn().mockReturnValue({
        getRequest: jest.fn().mockReturnValue(request),
      }),
    } as unknown as ExecutionContext;
  };

  it('should allow access if no roles are required', () => {
    const context = createMockContext({ roles: [] });
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow access if required roles is an empty array', () => {
    const context = createMockContext({ roles: [] });
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([]);

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow access if route is marked as @Public()', () => {
    const context = createMockContext();
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      if (key === 'isPublic') return true;
      if (key === 'roles') return ['admin'];
      return undefined;
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should throw UnauthorizedException if required roles are set but request.user is missing', () => {
    const context = createMockContext(undefined);
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      if (key === 'isPublic') return false;
      if (key === 'roles') return ['admin'];
      return undefined;
    });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow('Authentication required before evaluating role permissions');
  });

  it('should throw ForbiddenException if user lacks the required role', () => {
    const context = createMockContext({
      username: 'buyer.demo',
      roles: ['buyer'],
    });
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      if (key === 'isPublic') return false;
      if (key === 'roles') return ['admin'];
      return undefined;
    });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    expect(() => guard.canActivate(context)).toThrow('Insufficient role permissions');
  });

  it('should allow access if user has one of the allowed roles', () => {
    const context = createMockContext({
      username: 'buyer.demo',
      roles: ['buyer'],
    });
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      if (key === 'isPublic') return false;
      if (key === 'roles') return ['buyer', 'admin'];
      return undefined;
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow access if user has admin role for an admin-only endpoint', () => {
    const context = createMockContext({
      username: 'admin.demo',
      roles: ['admin'],
    });
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      if (key === 'isPublic') return false;
      if (key === 'roles') return ['admin'];
      return undefined;
    });

    expect(guard.canActivate(context)).toBe(true);
  });
});
