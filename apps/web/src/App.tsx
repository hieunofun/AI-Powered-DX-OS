import React, { useEffect, useState, useCallback } from 'react';
import './App.css';
import { useAuth } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';

interface ApiHealthState {
  status: 'checking' | 'connected' | 'disconnected';
  message?: string;
}

interface ApiResponseState {
  endpoint: string;
  statusCode?: number;
  data?: unknown;
  error?: string;
}

export const App: React.FC = () => {
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';
  const { isAuthenticated, isLoading, user, roles, login, logout, getToken } = useAuth();

  const [apiHealth, setApiHealth] = useState<ApiHealthState>({ status: 'checking' });
  const [activeTab, setActiveTab] = useState<'overview' | 'protected' | 'admin'>('overview');
  const [apiResponse, setApiResponse] = useState<ApiResponseState | null>(null);
  const [callingApi, setCallingApi] = useState<boolean>(false);

  useEffect(() => {
    let isMounted = true;
    fetch(`${apiBaseUrl}/health`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (isMounted) {
          setApiHealth({
            status: data.status === 'ok' ? 'connected' : 'disconnected',
            message: `Service: ${data.service || 'unknown'}`,
          });
        }
      })
      .catch((err) => {
        if (isMounted) {
          setApiHealth({
            status: 'disconnected',
            message: err.message || 'Connection failed',
          });
        }
      });

    return () => {
      isMounted = false;
    };
  }, [apiBaseUrl]);

  const callEndpoint = useCallback(
    async (endpoint: string, includeAuth: boolean = true) => {
      setCallingApi(true);
      setApiResponse(null);
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };

        if (includeAuth) {
          const token = await getToken();
          if (token) {
            headers.Authorization = `Bearer ${token}`;
          }
        }

        const res = await fetch(`${apiBaseUrl}${endpoint}`, { headers });
        let data: unknown;
        try {
          data = await res.json();
        } catch {
          data = await res.text();
        }

        setApiResponse({
          endpoint,
          statusCode: res.status,
          data,
        });
      } catch (err) {
        setApiResponse({
          endpoint,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setCallingApi(false);
      }
    },
    [apiBaseUrl, getToken],
  );

  return (
    <div className="container">
      <header className="header">
        <h1>SmartProcure Pay</h1>
        <p className="subtitle">
          Open-Source Smart Procure-to-Pay &amp; 3-Way e-Invoice Reconciliation Platform
        </p>

        <div className="status-bar">
          <div className="badge badge-green">
            <span className="badge-dot"></span>
            Frontend: Running
          </div>
          <div className={`badge ${apiHealth.status === 'connected' ? 'badge-green' : 'badge-amber'}`}>
            <span className="badge-dot"></span>
            Backend API ({apiBaseUrl}): {apiHealth.status.toUpperCase()}
          </div>
          <div className={`badge ${isAuthenticated ? 'badge-green' : 'badge-amber'}`}>
            <span className="badge-dot"></span>
            Keycloak Auth: {isLoading ? 'INITIALIZING' : isAuthenticated ? 'AUTHENTICATED' : 'UNAUTHENTICATED'}
          </div>
        </div>
      </header>

      {/* Identity & Session Card */}
      <section className="card">
        <h2>
          <span>Identity Provider &amp; SSO State</span>
          <span className={`tag ${isAuthenticated ? 'tag-active' : ''}`}>
            {isAuthenticated ? 'Active Session' : 'No Session'}
          </span>
        </h2>

        {isLoading ? (
          <p>Verifying Keycloak SSO session...</p>
        ) : !isAuthenticated ? (
          <div>
            <p>
              You are currently not authenticated. Log in via Keycloak OpenID Connect to obtain a JWT access token with role claims.
            </p>
            <div className="alert-box alert-info">
              <strong>Demo Test Accounts (DEV ONLY - password: <code>DemoPassword123!</code>):</strong>
              <ul style={{ marginTop: '0.5rem', paddingLeft: '1.25rem' }}>
                <li><code>admin.demo</code> (Role: <code>admin</code>)</li>
                <li><code>buyer.demo</code> (Role: <code>buyer</code>)</li>
                <li><code>warehouse.demo</code> (Role: <code>warehouse</code>)</li>
                <li><code>accountant.demo</code> (Role: <code>accountant</code>)</li>
                <li><code>finance.demo</code> (Role: <code>finance_manager</code>)</li>
              </ul>
            </div>
            <div className="btn-group">
              <button className="btn btn-primary" onClick={() => login()}>
                Log In via Keycloak
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div className="alert-box alert-success">
              <p><strong>Logged in as:</strong> {user?.username} ({user?.name || user?.username})</p>
              <p><strong>Email:</strong> {user?.email || 'N/A'}</p>
              <p><strong>Identity (sub):</strong> {user?.sub}</p>
              <p><strong>Realm Roles:</strong> {roles.length > 0 ? roles.join(', ') : 'None'}</p>
            </div>
            <div className="btn-group">
              <button className="btn btn-danger" onClick={() => logout()}>
                Log Out
              </button>
            </div>
          </div>
        )}
      </section>

      {/* RBAC Technical Validation Endpoints */}
      <section className="card">
        <h2>
          <span>Backend RBAC Technical Validation</span>
          <span className="tag">Issue #3 Endpoints</span>
        </h2>
        <p>
          Execute live calls against NestJS API authentication and role authorization guards.
        </p>

        <div className="btn-group">
          <button
            className="btn btn-secondary"
            disabled={callingApi}
            onClick={() => callEndpoint('/auth/me', true)}
          >
            GET /auth/me (Authenticated User)
          </button>
          <button
            className="btn btn-secondary"
            disabled={callingApi}
            onClick={() => callEndpoint('/auth/buyer-test', true)}
          >
            GET /auth/buyer-test (buyer | admin)
          </button>
          <button
            className="btn btn-secondary"
            disabled={callingApi}
            onClick={() => callEndpoint('/auth/admin-test', true)}
          >
            GET /auth/admin-test (admin only)
          </button>
          <button
            className="btn btn-secondary"
            disabled={callingApi}
            onClick={() => callEndpoint('/auth/me', false)}
          >
            GET /auth/me (No Token &rarr; 401)
          </button>
        </div>

        {callingApi && <p style={{ color: 'var(--accent-blue)' }}>Executing request...</p>}

        {apiResponse && (
          <div style={{ marginTop: '1rem' }}>
            <div
              className={`alert-box ${
                apiResponse.statusCode === 200
                  ? 'alert-success'
                  : apiResponse.statusCode === 403
                  ? 'alert-error'
                  : 'alert-info'
              }`}
            >
              <strong>Endpoint:</strong> {apiResponse.endpoint} |{' '}
              <strong>Status:</strong> {apiResponse.statusCode ? `HTTP ${apiResponse.statusCode}` : 'Error'}
              {apiResponse.statusCode === 200 && ' (Authorized - Success)'}
              {apiResponse.statusCode === 401 && ' (401 Unauthorized - Missing or Invalid Token)'}
              {apiResponse.statusCode === 403 && ' (403 Forbidden - Insufficient Role)'}
            </div>
            <pre className="code-block">
              {JSON.stringify(apiResponse.data || apiResponse.error, null, 2)}
            </pre>
          </div>
        )}
      </section>

      {/* Route Protection Demo Tabs */}
      <section className="card">
        <h2>
          <span>Frontend Route Protection</span>
          <span className="tag">Guards Demo</span>
        </h2>

        <div className="tab-nav">
          <button
            className={`tab-btn ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={() => setActiveTab('overview')}
          >
            Public Overview
          </button>
          <button
            className={`tab-btn ${activeTab === 'protected' ? 'active' : ''}`}
            onClick={() => setActiveTab('protected')}
          >
            Protected User Area
          </button>
          <button
            className={`tab-btn ${activeTab === 'admin' ? 'active' : ''}`}
            onClick={() => setActiveTab('admin')}
          >
            Admin Only Area
          </button>
        </div>

        {activeTab === 'overview' && (
          <div>
            <p>
              This is a public view accessible by any visitor without requiring Keycloak authentication.
            </p>
          </div>
        )}

        {activeTab === 'protected' && (
          <ProtectedRoute>
            <div className="alert-box alert-success">
              <h3>Protected User Area</h3>
              <p>
                Successfully authorized. This area is visible to any authenticated user regardless of specific realm roles.
              </p>
              <p>Current user: <strong>{user?.username}</strong></p>
            </div>
          </ProtectedRoute>
        )}

        {activeTab === 'admin' && (
          <ProtectedRoute requiredRoles={['admin']}>
            <div className="alert-box alert-success">
              <h3>Admin Only Area</h3>
              <p>
                Successfully authorized. This area is strictly restricted to accounts possessing the <code>admin</code> realm role.
              </p>
              <p>Admin user: <strong>{user?.username}</strong></p>
            </div>
          </ProtectedRoute>
        )}
      </section>

      {/* Architecture & Roadmap */}
      <main className="grid">
        <section className="card">
          <h2>
            DX-OS Open-Core
            <span className="tag">Phase 0/1/2 Foundation</span>
          </h2>
          <p>
            Standardized open-core infrastructure layer providing identity, API gateway, relational storage, object store, and immutable ledger capabilities.
          </p>
          <ul className="service-list">
            <li className="service-item">
              <span>PostgreSQL (Relational Store)</span>
              <span className="tag tag-active">Foundation Active</span>
            </li>
            <li className="service-item">
              <span>Keycloak (SSO / RBAC)</span>
              <span className="tag tag-active">Integrated (Issue #3)</span>
            </li>
            <li className="service-item">
              <span>Apache APISIX (API Gateway)</span>
              <span className="tag">Planned (Issue #4)</span>
            </li>
            <li className="service-item">
              <span>MinIO (Object Storage)</span>
              <span className="tag">Planned (Phase 3)</span>
            </li>
            <li className="service-item">
              <span>Flowable (BPMN Engine)</span>
              <span className="tag">Planned (Phase 4)</span>
            </li>
            <li className="service-item">
              <span>ImmuDB (Immutable Ledger)</span>
              <span className="tag">Planned (Phase 5)</span>
            </li>
          </ul>
        </section>

        <section className="card">
          <h2>
            Procure-to-Pay Application
            <span className="tag">Roadmap</span>
          </h2>
          <p>
            Domain business capabilities for the Procure-to-Pay lifecycle.
          </p>
          <ul className="service-list">
            <li className="service-item">
              <span>Purchase Order Lifecycle</span>
              <span className="tag">Planned (Issue #5)</span>
            </li>
            <li className="service-item">
              <span>Goods Receipt (GRN) Intake</span>
              <span className="tag">Planned (Issue #6)</span>
            </li>
            <li className="service-item">
              <span>e-Invoice Ingestion Pipeline</span>
              <span className="tag">Planned (Issue #7)</span>
            </li>
            <li className="service-item">
              <span>Deterministic 3-Way Matching Engine</span>
              <span className="tag">Planned (Issue #8)</span>
            </li>
            <li className="service-item">
              <span>Exception &amp; Approval Workflow</span>
              <span className="tag">Planned (Issue #9)</span>
            </li>
            <li className="service-item">
              <span>Cryptographic Audit Sealing</span>
              <span className="tag">Planned (Issue #10)</span>
            </li>
          </ul>
        </section>
      </main>

      <footer className="footer">
        SmartProcure-Pay &bull; OLP 2026 Open Source Software Competition &bull; Licensed under MIT
      </footer>
    </div>
  );
};

export default App;
