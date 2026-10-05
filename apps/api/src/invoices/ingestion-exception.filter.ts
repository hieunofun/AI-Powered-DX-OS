import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { Response } from 'express';
import { IngestionError } from './domain/ingestion-error';

@Catch()
export class IngestionExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof IngestionError) { response.status(error.getStatus()).json(error.getResponse()); return; }
    const statusCode = error instanceof HttpException ? error.getStatus() : 500;
    const errorCode = statusCode === 413 ? 'FILE_TOO_LARGE' : statusCode === 400 ? 'INVALID_REQUEST'
      : statusCode === 401 ? 'UNAUTHORIZED' : statusCode === 403 ? 'FORBIDDEN' : 'INTERNAL_ERROR';
    const message = statusCode === 413 ? 'Upload exceeds the configured limit.' : statusCode === 400
      ? 'Invalid request fields, identifiers or multipart upload.' : statusCode === 401 ? 'Authentication required.'
      : statusCode === 403 ? 'Insufficient role.' : 'Request could not be completed.';
    response.status(statusCode).json({ statusCode, errorCode, message });
  }
}
