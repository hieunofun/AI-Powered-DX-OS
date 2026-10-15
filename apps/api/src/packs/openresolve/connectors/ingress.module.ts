/* SPDX-License-Identifier: MIT */
import { Controller, DynamicModule, Get, HttpCode, Module, Param, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { EVIDENCE_CONTEXT, EvidenceContextResolver } from '../../../platform/evidence/evidence-context';
import { EvidenceGuard, EvidenceErrorFilter } from '../../../platform/evidence/evidence.controller';
import { EvidenceContext, fail } from '../../../platform/evidence/evidence.types';
import { ConnectorIngressService } from './ingress.service';
import { SourceKind } from './ingress.types';
type IngressRequest = Request & { evidenceContext: EvidenceContext; correlationId: string; rawBody?: Buffer };
@Controller('apps/openresolve/v1/connectors')
@UseGuards(EvidenceGuard)
@UseFilters(EvidenceErrorFilter)
export class ConnectorIngressController {
  constructor(private readonly service: ConnectorIngressService) {}
  private receive(request: IngressRequest, sourceId: string, kind: SourceKind) {
    const type = request.header('Content-Type') || '';
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) fail('UNSUPPORTED_MEDIA_TYPE', 415);
    // Composition must enable Nest rawBody:true or install a bounded raw route parser before JSON middleware.
    const bytes = request.rawBody || (Buffer.isBuffer(request.body) ? request.body : undefined);
    if (!bytes && (!request.body || typeof request.body === 'object' && Object.keys(request.body).length === 0)) fail('INVALID_REQUEST');
    if (!bytes) fail('DEPENDENCY_UNAVAILABLE', 503);
    return this.service.receive(request.evidenceContext, sourceId, kind, bytes, request.header('Idempotency-Key'), request.correlationId);
  }
  @Post('external-orders/:id/events')
  @HttpCode(202)
  order(@Req() request: IngressRequest, @Param('id') id: string) { return this.receive(request, id, 'EXTERNAL_ORDER'); }
  @Post('receiving-sensors/:id/events')
  @HttpCode(202)
  receiving(@Req() request: IngressRequest, @Param('id') id: string) { return this.receive(request, id, 'RECEIVING_SENSOR'); }
  @Get('observations/:id')
  detail(@Req() request: IngressRequest, @Param('id') id: string) { return this.service.detail(request.evidenceContext, id); }
}
@Module({})
export class ConnectorIngressModule {
  static register(service: ConnectorIngressService, resolver: EvidenceContextResolver): DynamicModule {
    if (!service || !resolver?.resolve) throw new Error('Connector ingress requires a verified tenant/service resolver.');
    return { module: ConnectorIngressModule, controllers: [ConnectorIngressController], providers: [
      { provide: ConnectorIngressService, useValue: service }, { provide: EVIDENCE_CONTEXT, useValue: resolver }, EvidenceGuard, EvidenceErrorFilter,
    ] };
  }
}
