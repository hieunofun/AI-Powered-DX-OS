import { Injectable } from '@nestjs/common';

export interface HealthCheckResult {
  status: 'ok' | 'error';
  service: string;
  timestamp: string;
  version: string;
}

@Injectable()
export class HealthService {
  check(): HealthCheckResult {
    return {
      status: 'ok',
      service: 'smartprocure-api',
      timestamp: new Date().toISOString(),
      version: '0.1.0',
    };
  }
}
