import React, { useEffect, useState } from 'react';
import './App.css';

interface ApiHealthState {
  status: 'checking' | 'connected' | 'disconnected';
  message?: string;
}

export const App: React.FC = () => {
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';
  const [apiHealth, setApiHealth] = useState<ApiHealthState>({ status: 'checking' });

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

  return (
    <div className="container">
      <header className="header">
        <h1>SmartProcure Pay</h1>
        <p className="subtitle">
          Open-Source Smart Procure-to-Pay & 3-Way e-Invoice Reconciliation Platform
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
        </div>
      </header>

      <main className="grid">
        {/* Section 1: DX-OS Open-Core Placeholder */}
        <section className="card">
          <h2>
            DX-OS Open-Core
            <span className="tag">Phase 0/1 Foundation</span>
          </h2>
          <p>
            Standardized open-core infrastructure layer providing identity, API gateway, relational storage, object store, and immutable ledger capabilities.
          </p>
          <ul className="service-list">
            <li className="service-item">
              <span>PostgreSQL (Relational Store)</span>
              <span className="tag">Foundation Active</span>
            </li>
            <li className="service-item">
              <span>Apache APISIX (API Gateway)</span>
              <span className="tag">Planned (Phase 2)</span>
            </li>
            <li className="service-item">
              <span>Keycloak (SSO / RBAC)</span>
              <span className="tag">Planned (Phase 2)</span>
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

        {/* Section 2: Procure-to-Pay Application Placeholder */}
        <section className="card">
          <h2>
            Procure-to-Pay Application
            <span className="tag">Roadmap</span>
          </h2>
          <p>
            Domain business capabilities for the Procure-to-Pay lifecycle. No business logic or domain schema implemented in Bootstrap phase.
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
              <span>Exception & Approval Workflow</span>
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
