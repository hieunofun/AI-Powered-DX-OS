import { HttpException } from '@nestjs/common';
export class MatchingError extends HttpException {
  constructor(errorCode: string, message: string, status: number) {
    super({ statusCode: status, errorCode, message }, status);
  }
}
