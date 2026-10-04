import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthService } from '../auth.service';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let reflector: Reflector;
  let authService: AuthService;

  const mockUser: AuthenticatedUser = {
    sub: 'user-uuid-1',
    username: 'test.user',
    email: 'test@example.com',
    roles: ['buyer'],
  };

  beforeEach(() => {
    reflector = new Reflector();
    authService = {
      verifyToken: jest.fn(),
    } as unknown as AuthService;
    guard = new JwtAuthGuard(reflector, authService);
  });

  const createMockContext = (headers: Record<string, string> = {}): { context: ExecutionContext; request: any } => {
    const request: any = { headers };
    const context = {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: jest.fn().mockReturnValue({
        getRequest: jest.fn().mockReturnValue(request),
      }),
    } as unknown as ExecutionContext;
    return { context, request };
  };

  it('should allow access if route is marked as @Public()', async () => {
    const { context } = createMockContext();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);

    const result = await guard.canActivate(context);
    expect(result).toBe(true);
    expect(authService.verifyToken).not.toHaveBeenCalled();
  });

  it('should throw UnauthorizedException when Authorization header is missing', async () => {
    const { context } = createMockContext({});
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(context)).rejects.toThrow('Missing Authorization header');
  });

  it('should throw UnauthorizedException when Authorization header does not use Bearer scheme', async () => {
    const { context } = createMockContext({ authorization: 'Basic dXNlcjpwYXNz' });
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(context)).rejects.toThrow('Invalid Authorization header format');
  });

  it('should throw UnauthorizedException when Bearer token is empty', async () => {
    const { context } = createMockContext({ authorization: 'Bearer ' });
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('should set request.user and return true when token is successfully verified', async () => {
    const { context, request } = createMockContext({ authorization: 'Bearer valid.jwt.token' });
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    (authService.verifyToken as jest.Mock).mockResolvedValue(mockUser);

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(authService.verifyToken).toHaveBeenCalledWith('valid.jwt.token');
    expect(request.user).toEqual(mockUser);
  });

  it('should propagate UnauthorizedException when token verification fails', async () => {
    const { context } = createMockContext({ authorization: 'Bearer invalid.jwt.token' });
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    (authService.verifyToken as jest.Mock).mockRejectedValue(new UnauthorizedException('Invalid signature'));

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(context)).rejects.toThrow('Invalid signature');
  });
});
