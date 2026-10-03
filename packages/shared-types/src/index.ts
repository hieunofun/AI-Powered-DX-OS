/**
 * @smartprocure/shared-types
 * Shared TypeScript domain models and interfaces
 */
export interface HealthResponse {
  status: 'ok' | 'error';
  service: string;
  timestamp?: string;
  version?: string;
}
