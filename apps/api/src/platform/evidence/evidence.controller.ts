/* SPDX-License-Identifier: MIT */
import { ArgumentsHost, CanActivate, Catch, Controller, ExceptionFilter, ExecutionContext, Get, HttpCode,
  HttpException, Inject, Injectable, Param, Post, Put, Query, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { EvidenceService } from './evidence.service';
import { EvidenceContext, EvidenceError, fail } from './evidence.types';
import { contextValid, UUID } from './file-safety';
import { EVIDENCE_CONTEXT, EvidenceContextResolver } from './evidence-context';

interface EvidenceRequest extends Request { evidenceContext: EvidenceContext; correlationId: string; }
@Injectable()
export class EvidenceGuard implements CanActivate {
  constructor(@Inject(EVIDENCE_CONTEXT) private readonly resolver: EvidenceContextResolver) {}
  async canActivate(host: ExecutionContext): Promise<boolean> {
    const request = host.switchToHttp().getRequest<EvidenceRequest>();
    const response = host.switchToHttp().getResponse<Response>();
    const requested = request.header('X-Correlation-ID');
    request.correlationId = requested && UUID.test(requested) ? requested : randomUUID();
    response.setHeader('X-Correlation-ID', request.correlationId);
    if (requested && !UUID.test(requested)) fail('INVALID_REQUEST');
    request.evidenceContext = await this.resolver.resolve(request);
    contextValid(request.evidenceContext);
    return true;
  }
}
@Catch()
export class EvidenceErrorFilter implements ExceptionFilter {
  catch(cause: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<EvidenceRequest>();
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) { response.destroy(); return; }
    const correlation = request.correlationId || randomUUID();
    const parser = cause && typeof cause === 'object' ? cause as { type?: string; status?: number } : undefined;
    const parserStatus = parser?.type === 'entity.too.large' && parser.status === 413 ? 413 :
      ['charset.unsupported', 'encoding.unsupported'].includes(parser?.type) && parser.status === 415 ? 415 : undefined;
    const status = cause instanceof EvidenceError ? cause.getStatus() : cause instanceof HttpException && cause.getStatus() < 500 ? cause.getStatus() : parserStatus || 503;
    const code = cause instanceof EvidenceError ? cause.code : status === 413 ? 'FILE_TOO_LARGE' : status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' :
      status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : status < 500 ? 'INVALID_REQUEST' : 'DEPENDENCY_UNAVAILABLE';
    response.setHeader('X-Correlation-ID', correlation);
    if (status === 429) response.setHeader('Retry-After', '1');
    response.status(status).json({ code, message: 'Evidence operation failed: ' + code + '.', correlation_id: correlation,
      retryable: cause instanceof EvidenceError ? cause.retryable : status === 503,
      ...(cause instanceof EvidenceError && cause.operationId ? { operation_id: cause.operationId } : {}) });
  }
}
@Controller('platform/v1')
@UseGuards(EvidenceGuard)
@UseFilters(EvidenceErrorFilter)
export class EvidenceController {
  constructor(private readonly service: EvidenceService) {}
  @Post('evidence')
  register(@Req() request: EvidenceRequest) {
    return this.service.register(request.evidenceContext, request.body, request.header('Idempotency-Key'));
  }
  @Get('evidence')
  page(@Req() request: EvidenceRequest, @Query() query: Record<string, unknown>) {
    if (Object.keys(query).some(key => !['limit', 'cursor', 'q', 'retention_class'].includes(key)) ||
      query.limit !== undefined && (typeof query.limit !== 'string' || !/^[1-9][0-9]{0,2}$/.test(query.limit)) ||
      query.cursor !== undefined && typeof query.cursor !== 'string' ||
      query.q !== undefined && typeof query.q !== 'string' || query.retention_class !== undefined && typeof query.retention_class !== 'string') fail('INVALID_REQUEST');
    return this.service.page(request.evidenceContext, query.limit === undefined ? 25 : Number(query.limit), query.cursor as string,
      { ...(query.q !== undefined ? { q: query.q as string } : {}), ...(query.retention_class !== undefined ? { retentionClass: query.retention_class as 'STANDARD' | 'RESTRICTED' } : {}) });
  }
  @Get('evidence/:id')
  detail(@Req() request: EvidenceRequest, @Param('id') id: string) { return this.service.detail(request.evidenceContext, id); }
  @Put('evidence/:id/content')
  @HttpCode(202)
  upload(@Req() request: EvidenceRequest, @Param('id') id: string) {
    // Keep the connection alive long enough to deliver a bounded validation error.
    const source = { [Symbol.asyncIterator]: () => request.iterator({ destroyOnReturn: false }) };
    return this.service.upload(request.evidenceContext, id, source, request.header('Content-Type'), request.header('Idempotency-Key'));
  }
  @Get('operations/:id')
  operation(@Req() request: EvidenceRequest, @Param('id') id: string) { return this.service.operation(request.evidenceContext, id); }
  @Get('evidence/:id/content')
  async download(@Req() request: EvidenceRequest, @Param('id') id: string, @Res() response: Response): Promise<void> {
    await this.service.withCleanBytes(request.evidenceContext, id, 'evidence.download', async (bytes, recheck) => {
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Disposition', 'attachment; filename="evidence-' + id + '.bin"');
      response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Cache-Control', 'private, no-store');
      response.setHeader('Content-Length', bytes.length);
      const timer = setTimeout(() => response.destroy(), 30000);
      try {
        for (let offset = 0; offset < bytes.length; offset += 65536) {
          await recheck();
          if (response.destroyed) throw new Error('Download closed.');
          if (!response.write(bytes.subarray(offset, offset + 65536))) await new Promise<void>((resolve, reject) => {
            const closed = () => { response.off('drain', drained); reject(new Error('Download closed.')); };
            const drained = () => { response.off('close', closed); resolve(); };
            response.once('close', closed); response.once('drain', drained);
          });
        }
        await new Promise<void>((resolve, reject) => {
          const closed = () => reject(new Error('Download closed.'));
          response.once('close', closed);
          response.end(() => { response.off('close', closed); resolve(); });
        });
      } finally { clearTimeout(timer); }
    });
  }
}
