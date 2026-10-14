/* SPDX-License-Identifier: MIT */
import { Controller, DynamicModule, Get, Module, Param, Query, Req, UseFilters, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { EVIDENCE_CONTEXT, EvidenceContextResolver } from '../evidence/evidence-context';
import { EvidenceGuard, EvidenceErrorFilter } from '../evidence/evidence.controller';
import { EvidenceContext, fail } from '../evidence/evidence.types';
import { LineageService } from './lineage.service';
@Controller('platform/v1/evidence')
@UseGuards(EvidenceGuard)
@UseFilters(EvidenceErrorFilter)
export class LineageController {
  constructor(private readonly service: LineageService) {}
  @Get(':id/lineage')
  page(@Req() request: Request & { evidenceContext: EvidenceContext }, @Param('id') id: string, @Query() query: Record<string, unknown>) {
    if (Object.keys(query).some(key => !['limit', 'cursor'].includes(key)) ||
      query.limit !== undefined && (typeof query.limit !== 'string' || !/^[1-9][0-9]{0,2}$/.test(query.limit)) ||
      query.cursor !== undefined && typeof query.cursor !== 'string') fail('INVALID_REQUEST');
    return this.service.page(request.evidenceContext, id, query.limit === undefined ? 25 : Number(query.limit), query.cursor as string);
  }
}
@Module({})
export class LineageModule {
  static register(service: LineageService, resolver: EvidenceContextResolver): DynamicModule {
    if (!service || !resolver?.resolve) throw new Error('Lineage requires a verified server context resolver.');
    return { module: LineageModule, controllers: [LineageController], providers: [
      { provide: LineageService, useValue: service }, { provide: EVIDENCE_CONTEXT, useValue: resolver }, EvidenceGuard, EvidenceErrorFilter,
    ] };
  }
}
