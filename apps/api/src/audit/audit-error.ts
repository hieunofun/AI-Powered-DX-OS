import { HttpException } from '@nestjs/common';
export class AuditError extends HttpException {
  constructor(public readonly errorCode: string, message: string, status=503) {
    super({errorCode,message},status);
  }
}
