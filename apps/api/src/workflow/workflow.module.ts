import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { WorkflowController } from './workflow.controller';
import { WorkflowService } from './workflow.service';
import { WorkflowRepository } from './workflow.repository';
import { FlowableClient } from './flowable/flowable.client';
@Module({imports:[AuthModule,DatabaseModule],controllers:[WorkflowController],
  providers:[WorkflowService,WorkflowRepository,FlowableClient],exports:[WorkflowService,WorkflowRepository,FlowableClient]})
export class WorkflowModule {}

