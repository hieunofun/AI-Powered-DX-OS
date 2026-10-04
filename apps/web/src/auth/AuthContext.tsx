import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { keycloak } from './keycloak';

export interface UserProfile {
  sub: string;
  username: string;
  email?: string;
  name?: string;
}

export interface AuthContextType {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: UserProfile | null;
  roles: string[];
  hasRole: (role: string) => boolean;
  hasAnyRole: (roles: string[]) => boolean;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  getToken: () => Promise<string | undefined>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const INTERNAL_ROLES = new Set([
  'default-roles-smartprocure',
  'offline_access',
  'uma_authorization',
]);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [roles, setRoles] = useState<string[]>([]);

  const extractUserInfo = useCallback(() => {
    if (!keycloak.authenticated || !keycloak.tokenParsed) {
      setUser(null);
      setRoles([]);
      return;
    }

    const parsed = keycloak.tokenParsed;
    setUser({
      sub: parsed.sub || '',
      username: (parsed.preferred_username as string) || parsed.sub || 'unknown',
      email: parsed.email as string | undefined,
      name: parsed.name as string | undefined,
    });

    const realmRoles = (parsed.realm_access?.roles || []) as string[];
    const normalizedRoles = realmRoles.filter((r) => !INTERNAL_ROLES.has(r));
    setRoles(normalizedRoles);
  }, []);

  useEffect(() => {
    let isMounted = true;

    keycloak
      .init({
        onLoad: 'check-sso',
        pkceMethod: 'S256',
        checkLoginIframe: false,
      })
      .then((authenticated) => {
        if (!isMounted) return;
        setIsAuthenticated(authenticated);
        if (authenticated) {
          extractUserInfo();
        }
        setIsLoading(false);
      })
      .catch(() => {
        if (!isMounted) return;
        setIsAuthenticated(false);
        setIsLoading(false);
      });

    keycloak.onTokenExpired = () => {
      keycloak.updateToken(30).catch(() => {
        setIsAuthenticated(false);
        setUser(null);
        setRoles([]);
      });
    };

    keycloak.onAuthLogout = () => {
      setIsAuthenticated(false);
      setUser(null);
      setRoles([]);
    };

    return () => {
      isMounted = false;
    };
  }, [extractUserInfo]);

  const login = useCallback(async () => {
    await keycloak.login();
  }, []);

  const logout = useCallback(async () => {
    await keycloak.logout({
      redirectUri: window.location.origin,
    });
  }, []);

  const getToken = useCallback(async (): Promise<string | undefined> => {
    if (!keycloak.authenticated) {
      return undefined;
    }
    try {
      await keycloak.updateToken(30);
      return keycloak.token;
    } catch {
      setIsAuthenticated(false);
      return undefined;
    }
  }, []);

  const hasRole = useCallback(
    (role: string): boolean => {
      return roles.includes(role);
    },
    [roles],
  );

  const hasAnyRole = useCallback(
    (targetRoles: string[]): boolean => {
      return targetRoles.some((r) => roles.includes(r));
    },
    [roles],
  );

  const contextValue = useMemo<AuthContextType>(
    () => ({
      isAuthenticated,
      isLoading,
      user,
      roles,
      hasRole,
      hasAnyRole,
      login,
      logout,
      getToken,
    }),
    [isAuthenticated, isLoading, user, roles, hasRole, hasAnyRole, login, logout, getToken],
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
