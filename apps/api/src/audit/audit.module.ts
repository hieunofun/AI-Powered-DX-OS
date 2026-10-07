import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { AuditController } from './audit.controller';
import { AuditRepository } from './audit.repository';
import { AuditSealService } from './audit-seal.service';
import { AuditReportService } from './audit-report.service';
import { ImmudbClient } from './immudb/immudb.client';
@Module({imports:[DatabaseModule,AuthModule],controllers:[AuditController],
  providers:[AuditRepository,AuditSealService,AuditReportService,ImmudbClient],exports:[AuditRepository,AuditSealService,ImmudbClient]})
export class AuditModule {}
