/* SPDX-License-Identifier: MIT */
import { Controller, DynamicModule, Get, HttpCode, Module, Param, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { EvidenceGuard, EvidenceErrorFilter } from '../../../platform/evidence/evidence.controller';
import { EVIDENCE_CONTEXT, EvidenceContextResolver } from '../../../platform/evidence/evidence-context';
import { EvidenceContext, fail } from '../../../platform/evidence/evidence.types';
import { AiMediationService } from './mediation.service';
interface MediationRequest extends Request { evidenceContext: EvidenceContext; }
@Controller('apps/openresolve/v1/ai')
@UseGuards(EvidenceGuard)
@UseFilters(EvidenceErrorFilter)
export class AiMediationController {
  constructor(private readonly service: AiMediationService) {}
  private json(request: MediationRequest) {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.header('Content-Type') || '')) fail('UNSUPPORTED_MEDIA_TYPE', 415);
    return request.body;
  }
  @Post('cases/:id/explanations') @HttpCode(202)
  request(@Req() request: MediationRequest, @Param('id') id: string) {
    return this.service.request(request.evidenceContext, id, this.json(request), request.header('Idempotency-Key'));
  }
  @Get('explanations/:id')
  detail(@Req() request: MediationRequest, @Param('id') id: string) { return this.service.detail(request.evidenceContext, id); }
  @Post('explanations/:id/proposals') @HttpCode(201)
  propose(@Req() request: MediationRequest, @Param('id') id: string) {
    return this.service.propose(request.evidenceContext, id, this.json(request), request.header('Idempotency-Key'));
  }
  @Get('proposals/:id')
  proposal(@Req() request: MediationRequest, @Param('id') id: string) { return this.service.proposalDetail(request.evidenceContext, id); }
  @Post('proposals/:id/approval') @HttpCode(200)
  approve(@Req() request: MediationRequest, @Param('id') id: string) {
    return this.service.attachApproval(request.evidenceContext, id, this.json(request), request.header('Idempotency-Key'));
  }
  @Post('proposals/:id/execute') @HttpCode(200)
  execute(@Req() request: MediationRequest, @Param('id') id: string) {
    return this.service.execute(request.evidenceContext, id, this.json(request), request.header('Idempotency-Key'));
  }
}
@Module({})
export class AiMediationModule {
  static register(service: AiMediationService, resolver: EvidenceContextResolver): DynamicModule {
    if (!service || !resolver?.resolve) throw new Error('AI mediation requires a verified current membership resolver.');
    return { module: AiMediationModule, controllers: [AiMediationController], providers: [
      { provide: AiMediationService, useValue: service }, { provide: EVIDENCE_CONTEXT, useValue: resolver }, EvidenceGuard, EvidenceErrorFilter,
    ], exports: [AiMediationService] };
  }
}
