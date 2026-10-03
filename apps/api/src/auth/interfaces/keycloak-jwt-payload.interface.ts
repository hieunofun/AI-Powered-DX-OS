export interface KeycloakJwtPayload {
  sub: string;
  iss: string;
  exp: number;
  iat: number;
  preferred_username?: string;
  email?: string;
  realm_access?: {
    roles?: string[];
  };
  resource_access?: Record<string, { roles?: string[] }>;
  aud?: string | string[];
  [key: string]: unknown;
}
