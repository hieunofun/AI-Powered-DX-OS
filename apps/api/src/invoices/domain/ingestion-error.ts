import { HttpException } from '@nestjs/common';

export class IngestionError extends HttpException {
  constructor(public readonly errorCode: string, message: string, status = 422, ingestionId?: string) {
    super({ statusCode: status, errorCode, message, ...(ingestionId ? { ingestionId } : {}) }, status);
  }
  withIngestion(id: string): IngestionError {
    return new IngestionError(this.errorCode, (this.getResponse() as { message: string }).message, this.getStatus(), id);
  }
}
