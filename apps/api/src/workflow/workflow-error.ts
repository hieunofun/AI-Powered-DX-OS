import { HttpException } from '@nestjs/common';
export class WorkflowError extends HttpException {
  constructor(errorCode: string, message: string, status = 503) { super({ errorCode, message }, status); }
}

