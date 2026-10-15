/* SPDX-License-Identifier: MIT */
import { Controller, DynamicModule, HttpCode, Module, Param, Post, Get, Req, UseFilters, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { EvidenceGuard, EvidenceErrorFilter } from '../evidence/evidence.controller';
import { EVIDENCE_CONTEXT, EvidenceContextResolver } from '../evidence/evidence-context';
import { EvidenceContext } from '../evidence/evidence.types';
import { DraftService } from './draft.service';
interface DraftRequest extends Request { evidenceContext: EvidenceContext; }
@Controller('platform/v1')
@UseGuards(EvidenceGuard)
@UseFilters(EvidenceErrorFilter)
export class DraftController {
  constructor(private readonly service: DraftService) {}
  @Post('evidence/:id/extractions') @HttpCode(202)
  request(@Req() request: DraftRequest, @Param('id') id: string) {
    return this.service.request(request.evidenceContext, id, request.body, request.header('Idempotency-Key'));
  }
  @Get('extraction-drafts/:id')
  detail(@Req() request: DraftRequest, @Param('id') id: string) { return this.service.detail(request.evidenceContext, id); }
  @Post('extraction-drafts/:id/corrections') @HttpCode(200)
  correct(@Req() request: DraftRequest, @Param('id') id: string) {
    return this.service.correct(request.evidenceContext, id, request.body, request.header('Idempotency-Key'));
  }
  @Post('extraction-drafts/:id/confirmations') @HttpCode(202)
  confirm(@Req() request: DraftRequest, @Param('id') id: string) {
    return this.service.confirm(request.evidenceContext, id, request.body, request.header('Idempotency-Key'));
  }
}
@Module({})
export class DraftModule {
  static register(service: DraftService, resolver: EvidenceContextResolver): DynamicModule {
    if (!service || !resolver?.resolve) throw new Error('Drafts require a verified context resolver.');
    return { module: DraftModule, controllers: [DraftController], providers: [
      { provide: DraftService, useValue: service }, { provide: EVIDENCE_CONTEXT, useValue: resolver }, EvidenceGuard, EvidenceErrorFilter,
    ], exports: [DraftService] };
  }
}
