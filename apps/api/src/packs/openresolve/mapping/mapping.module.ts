/* SPDX-License-Identifier: MIT */
import { Controller, DynamicModule, Get, HttpCode, Module, Param, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { EVIDENCE_CONTEXT, EvidenceContextResolver } from '../../../platform/evidence/evidence-context';
import { EvidenceGuard, EvidenceErrorFilter } from '../../../platform/evidence/evidence.controller';
import { EvidenceContext } from '../../../platform/evidence/evidence.types';
import { ReviewedMappingService } from './mapping.service';
type MappingRequest = Request & { evidenceContext: EvidenceContext };
@Controller('apps/openresolve/v1')
@UseGuards(EvidenceGuard)
@UseFilters(EvidenceErrorFilter)
export class MappingController {
  constructor(private readonly service: ReviewedMappingService) {}
  @Post('verified-invoices/:id/item-mapping-suggestions')
  @HttpCode(202)
  request(@Req() req: MappingRequest, @Param('id') id: string) { return this.service.request(req.evidenceContext, id, req.body, req.header('Idempotency-Key')); }
  @Get('item-mapping-suggestions/:id')
  detail(@Req() req: MappingRequest, @Param('id') id: string) { return this.service.detail(req.evidenceContext, id); }
  @Post('item-mapping-suggestions/:id/confirmations')
  @HttpCode(202)
  confirm(@Req() req: MappingRequest, @Param('id') id: string) { return this.service.confirm(req.evidenceContext, id, req.body, req.header('Idempotency-Key')); }
}
@Module({})
export class ReviewedMappingModule {
  static register(service: ReviewedMappingService, resolver: EvidenceContextResolver): DynamicModule {
    if (!service || !resolver?.resolve) throw new Error('Reviewed mapping requires a current verified context.');
    return { module: ReviewedMappingModule, controllers: [MappingController], providers: [
      { provide: ReviewedMappingService, useValue: service }, { provide: EVIDENCE_CONTEXT, useValue: resolver }, EvidenceGuard, EvidenceErrorFilter,
    ] };
  }
}
