# Open Source Components Inventory

This document tracks all external open-source software (OSS) components evaluated and planned for integration into **SmartProcure-Pay**. 

Every license listed below has been verified against the official upstream repository in compliance with open-source governance guidelines.

---

## Component Registry

| Component | Repository | Version | License | Role | Integration Type | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Keycloak** | [keycloak/keycloak](https://github.com/keycloak/keycloak) | `24.0.x` | Apache-2.0 | Identity & Access Management (SSO, OIDC, RBAC) | Docker Service | Planned |
| **Apache APISIX** | [apache/apisix](https://github.com/apache/apisix) | `3.9.x` | Apache-2.0 | API Gateway (Reverse proxy, rate limiting, routing, JWT validation) | Docker Service | Planned |
| **PostgreSQL** | [postgres/postgres](https://github.com/postgres/postgres) | `16-alpine` | PostgreSQL License | Primary Relational Data Store (Domain models, ledger transactions) | Docker Service | Service Defined |
| **MinIO** | [minio/minio](https://github.com/minio/minio) | `RELEASE.2024-03-30` | GNU AGPLv3 | S3-Compatible Object Storage (Raw invoices: PDF, XML, images) | Docker Service | Planned |
| **Flowable** | [flowable/flowable-engine](https://github.com/flowable/flowable-engine) | `6.8.x` | Apache-2.0 | BPMN 2.0 Business Process Engine (Discrepancy & approval workflows) | Docker Service | Planned |
| **ImmuDB** | [codenotary/immudb](https://github.com/codenotary/immudb) | `v1.9.x` | Apache-2.0 | Cryptographic Immutable Ledger (Tamper-evident audit trail sealing) | Docker Service | Planned |
| **Prometheus** | [prometheus/prometheus](https://github.com/prometheus/prometheus) | `v2.51.x` | Apache-2.0 | System & Business Metrics Monitoring | Docker Service | Planned |
| **Grafana** | [grafana/grafana](https://github.com/grafana/grafana) | `10.4.x` | GNU AGPLv3 | Operational & Observability Dashboards | Docker Service | Planned |
| **React** | [facebook/react](https://github.com/facebook/react) | `^18.3.1` | MIT | Web UI Frontend Application Framework | Dependency | Integrated |
| **NestJS** | [nestjs/nest](https://github.com/nestjs/nest) | `^10.3.9` | MIT | Backend Application Framework & Modular Services | Dependency | Integrated |
| **Vite** | [vitejs/vite](https://github.com/vitejs/vite) | `^5.3.1` | MIT | Frontend Build Tooling & Development Server | Dependency | Integrated |
| **TypeScript** | [microsoft/TypeScript](https://github.com/microsoft/TypeScript) | `^5.4.5` | Apache-2.0 | Static Type Checking and Code Compilation | Dependency | Integrated |
| **Supertest** | [ladjs/supertest](https://github.com/ladjs/supertest) | `^7.0.0` | MIT | HTTP Assertions for E2E Health Testing | Dependency | Integrated |
| **Jest** | [jestjs/jest](https://github.com/jestjs/jest) | `^29.7.0` | MIT | Test Runner and Assertion Framework | Dependency | Integrated |

---

## License Compliance Notes

1. **Permissive Licenses (Apache-2.0, MIT, PostgreSQL License)**:
   - Permissive licenses allow distribution, modification, and integration with minimal obligations beyond preserving copyright notices and disclaimers.
   - SmartProcure-Pay's MIT License is fully compatible with consuming these upstream projects.

2. **AGPL-3.0 Components (MinIO, Grafana)**:
   - MinIO and Grafana are used as unmodified external services (deployed via container orchestration).
   - Any distribution or deployment license obligations must be respected in accordance with their respective upstream licenses.
   - For internal guidelines on adding new dependencies, see [License Policy](file:///d:/dự%20án%20đi%20thi/docs/open-source/LICENSE_POLICY.md).
