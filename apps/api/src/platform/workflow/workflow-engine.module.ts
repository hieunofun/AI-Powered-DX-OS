import { Module } from '@nestjs/common';
import { FlowableTransport } from './flowable.transport';

@Module({providers:[FlowableTransport],exports:[FlowableTransport]})
export class WorkflowEngineModule {}
