import { Module } from '@nestjs/common';
import { IdentityModule } from './identity/identity.module';
import { DatabaseModule } from './data/database.module';
import { WorkflowEngineModule } from './workflow/workflow-engine.module';

@Module({imports:[IdentityModule,DatabaseModule,WorkflowEngineModule],exports:[IdentityModule,DatabaseModule,WorkflowEngineModule]})
export class PlatformModule {}
