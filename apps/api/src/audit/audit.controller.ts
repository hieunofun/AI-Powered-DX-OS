import { Body,Controller,Get,Param,ParseUUIDPipe,Post,Res,UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { AuditSealService } from './audit-seal.service';
import { AuditReportService } from './audit-report.service';
import { AuditError } from './audit-error';

@Controller('audit/invoices')
@UseGuards(JwtAuthGuard,RolesGuard)
@Roles('admin','accountant','finance_manager')
export class AuditController {
  constructor(private readonly audit:AuditSealService,private readonly reports:AuditReportService) {}
  @Get(':invoiceId') detail(@Param('invoiceId',new ParseUUIDPipe()) id:string) {return this.audit.detail(id);}
  @Get(':invoiceId/verify') async verify(@Param('invoiceId',new ParseUUIDPipe()) id:string,@CurrentUser() actor:AuthenticatedUser,@Res() res:Response) {
    const {result}=await this.audit.verify(id,actor.sub);
    res.setHeader('Cache-Control','no-store');return res.status(result.verificationStatus==='UNAVAILABLE'?503:200).json(result);
  }
  @Get(':invoiceId/report.json') async json(@Param('invoiceId',new ParseUUIDPipe()) id:string,@CurrentUser() actor:AuthenticatedUser,@Res() res:Response) {
    const report=await this.reports.json(id,actor.sub);
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Disposition','attachment; filename="audit-'+id+'.json"');
    return res.status(report.verificationStatus==='UNAVAILABLE'?503:200).json(report);
  }
  @Get(':invoiceId/report.pdf') async pdf(@Param('invoiceId',new ParseUUIDPipe()) id:string,@CurrentUser() actor:AuthenticatedUser,@Res() res:Response) {
    const {report,bytes}=await this.reports.pdf(id,actor.sub);
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition','attachment; filename="audit-'+id+'.pdf"');
    return res.status(report.verificationStatus==='UNAVAILABLE'?503:200).send(bytes);
  }
  @Post(':invoiceId/seal') @Roles('admin')
  async seal(@Param('invoiceId',new ParseUUIDPipe()) id:string,@CurrentUser() actor:AuthenticatedUser,@Body() body:any,@Res() res:Response) {
    if(body && (typeof body!=='object' || Array.isArray(body) || Object.keys(body).length)) throw new AuditError('INVALID_AUDIT_INPUT','Seal accepts no client business data.',400);
    return res.status(200).json(await this.audit.seal(id,actor.sub));
  }
}
