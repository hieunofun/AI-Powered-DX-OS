import { Module, Global } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { IdentityModule } from '../platform/identity/identity.module';

@Global()
@Module({
  controllers: [AuthController],
  imports: [IdentityModule],
  exports: [IdentityModule],
})
export class AuthModule {}

