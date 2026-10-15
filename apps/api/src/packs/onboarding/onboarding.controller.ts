/* SPDX-License-Identifier: MIT */
import { Controller, Get, HttpCode, Param, Post, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { EvidenceGuard, EvidenceErrorFilter } from '../../platform/evidence/evidence.controller';
import { EvidenceContext, fail } from '../../platform/evidence/evidence.types';
import { OnboardingService } from './onboarding.service';
interface OnboardingRequest extends Request { evidenceContext: EvidenceContext; }
@Controller('packs/onboarding/v1')
@UseGuards(EvidenceGuard)
@UseFilters(EvidenceErrorFilter)
export class OnboardingController {
  constructor(private readonly service: OnboardingService) {}
  private response(request: OnboardingRequest, response: Response) {
    response.setHeader('Cache-Control', 'private, no-store');
    if (Object.keys(request.query).length) fail('INVALID_REQUEST');
    return request.evidenceContext;
  }
  @Post('cases')
  create(@Req() request: OnboardingRequest, @Res({ passthrough: true }) response: Response) {
    return this.service.create(this.response(request, response), request.body, request.header('Idempotency-Key'));
  }
  @Get('cases/:id')
  detail(@Req() request: OnboardingRequest, @Res({ passthrough: true }) response: Response, @Param('id') id: string) {
    return this.service.detail(this.response(request, response), id);
  }
  @Post('cases/:id/checklist/:code')
  @HttpCode(200)
  checklist(@Req() request: OnboardingRequest, @Res({ passthrough: true }) response: Response, @Param('id') id: string, @Param('code') code: string) {
    return this.service.recordChecklist(this.response(request, response), id, code, request.body, request.header('Idempotency-Key'));
  }
  @Post('cases/:id/access-requests')
  @HttpCode(202)
  submit(@Req() request: OnboardingRequest, @Res({ passthrough: true }) response: Response, @Param('id') id: string) {
    return this.service.submit(this.response(request, response), id, request.body, request.header('Idempotency-Key'));
  }
  @Post('cases/:id/decisions')
  @HttpCode(202)
  decide(@Req() request: OnboardingRequest, @Res({ passthrough: true }) response: Response, @Param('id') id: string) {
    return this.service.decide(this.response(request, response), id, request.body, request.header('Idempotency-Key'));
  }
  @Get('operations/:id')
  async operation(@Req() request: OnboardingRequest, @Res({ passthrough: true }) response: Response, @Param('id') id: string) {
    const operation = await this.service.operation(this.response(request, response), id);
    if (!operation) fail('NOT_FOUND', 404); return operation;
  }
}
