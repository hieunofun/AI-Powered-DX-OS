import React from 'react';
import { useAuth } from './AuthContext';

interface ProtectedRouteProps {
  requiredRoles?: string[];
  children: React.ReactNode;
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ requiredRoles, children }) => {
  const { isAuthenticated, isLoading, roles, hasAnyRole, login } = useAuth();

  if (isLoading) {
    return (
      <div className="card" style={{ padding: '2rem', textAlign: 'center' }}>
        <p>Verifying authentication session...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="card" style={{ borderLeft: '4px solid #f59e0b', padding: '1.5rem' }}>
        <h3>Authentication Required</h3>
        <p style={{ margin: '0.75rem 0', color: '#6b7280' }}>
          You must be logged in through Keycloak SSO to access this protected area.
        </p>
        <button
          onClick={() => login()}
          style={{
            padding: '0.5rem 1rem',
            backgroundColor: '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          Log In via Keycloak
        </button>
      </div>
    );
  }

  if (requiredRoles && requiredRoles.length > 0 && !hasAnyRole(requiredRoles)) {
    return (
      <div className="card" style={{ borderLeft: '4px solid #ef4444', padding: '1.5rem' }}>
        <h3 style={{ color: '#dc2626' }}>403 Forbidden</h3>
        <p style={{ margin: '0.75rem 0', color: '#374151' }}>
          Access denied. Your account lacks the required role to view this section.
        </p>
        <div style={{ fontSize: '0.875rem', color: '#6b7280' }}>
          <p>
            <strong>Required role(s):</strong> {requiredRoles.join(', ')}
          </p>
          <p>
            <strong>Your current role(s):</strong> {roles.length > 0 ? roles.join(', ') : 'None'}
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
};
