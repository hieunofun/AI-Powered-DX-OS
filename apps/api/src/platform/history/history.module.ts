/* SPDX-License-Identifier: MIT */
import { Controller, DynamicModule, Get, Header, Module, Param, Query, Req, UseFilters, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { EvidenceGuard, EvidenceErrorFilter } from '../evidence/evidence.controller';
import { EVIDENCE_CONTEXT, EvidenceContextResolver } from '../evidence/evidence-context';
import { EvidenceContext } from '../evidence/evidence.types';
import { HistoryQueryService } from './history-query.service';
interface HistoryRequest extends Request { evidenceContext: EvidenceContext; }
@Controller('platform/v1/history')
@UseGuards(EvidenceGuard)
@UseFilters(EvidenceErrorFilter)
export class HistoryController {
  constructor(private readonly service: HistoryQueryService) {}
  @Get(':stream/events') @Header('Cache-Control', 'no-store')
  events(@Req() request: HistoryRequest, @Param('stream') stream: string, @Query() query: Record<string, unknown>) {
    return this.service.events(request.evidenceContext, stream, query);
  }
  @Get(':stream/cases') @Header('Cache-Control', 'no-store')
  cases(@Req() request: HistoryRequest, @Param('stream') stream: string, @Query() query: Record<string, unknown>) {
    return this.service.cases(request.evidenceContext, stream, query);
  }
}
@Module({})
export class HistoryModule {
  static register(service: HistoryQueryService, resolver: EvidenceContextResolver): DynamicModule {
    if (!service || !resolver?.resolve) throw new Error('History reads require verified current identity/membership.');
    return { module: HistoryModule, controllers: [HistoryController], providers: [
      { provide: HistoryQueryService, useValue: service }, { provide: EVIDENCE_CONTEXT, useValue: resolver }, EvidenceGuard, EvidenceErrorFilter,
    ] };
  }
}
