export interface AuthenticatedUser {
  sub: string;
  username: string;
  email?: string;
  roles: string[];
}
