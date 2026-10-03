import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from './decorators/current-user.decorator';
import { Roles } from './decorators/roles.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { AuthenticatedUser } from './interfaces/authenticated-user.interface';

@Controller('auth')
export class AuthController {
  /**
   * Technical verification endpoint: Returns normalized user principal.
   * Requires a valid Keycloak Bearer JWT.
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  getProfile(@CurrentUser() user: AuthenticatedUser) {
    return {
      sub: user.sub,
      username: user.username,
      email: user.email,
      roles: user.roles,
    };
  }

  /**
   * Technical verification endpoint: Restricted to administrators only.
   */
  @Get('admin-test')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  adminTest(@CurrentUser() user: AuthenticatedUser) {
    return {
      message: 'Admin authorization test passed',
      user: {
        sub: user.sub,
        username: user.username,
        roles: user.roles,
      },
    };
  }

  /**
   * Technical verification endpoint: Restricted to buyers or administrators.
   */
  @Get('buyer-test')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('buyer', 'admin')
  buyerTest(@CurrentUser() user: AuthenticatedUser) {
    return {
      message: 'Buyer authorization test passed',
      user: {
        sub: user.sub,
        username: user.username,
        roles: user.roles,
      },
    };
  }
}
