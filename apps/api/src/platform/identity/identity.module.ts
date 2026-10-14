import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';

@Module({providers:[AuthService,JwtAuthGuard,RolesGuard],exports:[AuthService,JwtAuthGuard,RolesGuard]})
export class IdentityModule {}
