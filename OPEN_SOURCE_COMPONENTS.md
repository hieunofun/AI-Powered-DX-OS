# Open Source Components Inventory

This document tracks all external open-source software (OSS) components evaluated and planned for integration into **SmartProcure-Pay**. 

Every license listed below has been verified against the official upstream repository in compliance with open-source governance guidelines.

---

## Component Registry

| Component | Repository | Version | License | Role | Integration Type | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Keycloak** | [keycloak/keycloak](https://github.com/keycloak/keycloak) | `24.0.5` | Apache-2.0 | Identity & Access Management (SSO, OIDC, RBAC) | Docker Service | Integrated (Pinned known-working version) |
| **Apache APISIX** | [apache/apisix](https://github.com/apache/apisix) | `3.19.0` | Apache-2.0 | API Gateway (Reverse proxy, rate limiting, routing, JWT validation) | Docker Service | Integrated (Issue #4) |
| **PostgreSQL** | [postgres/postgres](https://github.com/postgres/postgres) | `16-alpine` | PostgreSQL License | Primary Relational Data Store (Domain models, ledger transactions) | Docker Service | Service Defined |
| **MinIO** | [minio/minio](https://github.com/minio/minio) | `RELEASE.2024-03-30` | GNU AGPLv3 | S3-Compatible Object Storage (Raw invoices: PDF, XML, images) | Docker Service | Planned |
| **Flowable** | [flowable/flowable-engine](https://github.com/flowable/flowable-engine) | `6.8.x` | Apache-2.0 | BPMN 2.0 Business Process Engine (Discrepancy & approval workflows) | Docker Service | Planned |
| **ImmuDB** | [codenotary/immudb](https://github.com/codenotary/immudb) | `v1.9.x` | Apache-2.0 | Cryptographic Immutable Ledger (Tamper-evident audit trail sealing) | Docker Service | Planned |
| **Prometheus** | [prometheus/prometheus](https://github.com/prometheus/prometheus) | `v2.51.x` | Apache-2.0 | System & Business Metrics Monitoring | Docker Service | Planned |
| **Grafana** | [grafana/grafana](https://github.com/grafana/grafana) | `10.4.x` | GNU AGPLv3 | Operational & Observability Dashboards | Docker Service | Planned |
| **React** | [facebook/react](https://github.com/facebook/react) | `^18.3.1` | MIT | Web UI Frontend Application Framework | Dependency | Integrated |
| **keycloak-js** | [keycloak/keycloak](https://github.com/keycloak/keycloak/tree/main/packages/keycloak-js) | `24.0.5` | Apache-2.0 | Frontend OIDC Client Adapter with PKCE Authorization | Dependency | Integrated |
| **NestJS** | [nestjs/nest](https://github.com/nestjs/nest) | `^10.3.9` | MIT | Backend Application Framework & Modular Services | Dependency | Integrated |
| **jsonwebtoken** | [auth0/node-jsonwebtoken](https://github.com/auth0/node-jsonwebtoken) | `^9.0.3` | MIT | JSON Web Token (JWT) Verification and Claims Extraction | Dependency | Integrated |
| **jwks-rsa** | [auth0/node-jwks-rsa](https://github.com/auth0/node-jwks-rsa) | `^3.2.2` | MIT | Retrieval and Caching of RSA Signing Keys from JWKS Endpoints | Dependency | Integrated |
| **@types/jsonwebtoken** | [DefinitelyTyped/DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) | `^9.0.10` | MIT | TypeScript Type Definitions for jsonwebtoken | Dependency | Integrated |
| **Vite** | [vitejs/vite](https://github.com/vitejs/vite) | `^5.3.1` | MIT | Frontend Build Tooling & Development Server | Dependency | Integrated |
| **TypeScript** | [microsoft/TypeScript](https://github.com/microsoft/TypeScript) | `^5.4.5` | Apache-2.0 | Static Type Checking and Code Compilation | Dependency | Integrated |
| **Supertest** | [ladjs/supertest](https://github.com/ladjs/supertest) | `^7.0.0` | MIT | HTTP Assertions for E2E Health Testing | Dependency | Integrated |
| **Jest** | [jestjs/jest](https://github.com/jestjs/jest) | `^29.7.0` | MIT | Test Runner and Assertion Framework | Dependency | Integrated |
| **ESLint** | [eslint/eslint](https://github.com/eslint/eslint) | `^8.57.1` | MIT | Pluggable JavaScript & TypeScript Linter | Dependency | Integrated |
| **typescript-eslint** | [typescript-eslint/typescript-eslint](https://github.com/typescript-eslint/typescript-eslint) | `^7.18.0` | BSD-2-Clause | Tooling for TypeScript Linting Integration | Dependency | Integrated |
| **eslint-plugin-react-hooks** | [facebook/react](https://github.com/facebook/react/tree/main/packages/eslint-plugin-react-hooks) | `^4.6.2` | MIT | React Hooks Rules Enforcement | Dependency | Integrated |
| **eslint-plugin-react** | [jsx-eslint/eslint-plugin-react](https://github.com/jsx-eslint/eslint-plugin-react) | `^7.37.5` | MIT | React-Specific Linting Rules | Dependency | Integrated |
| **pg** | [brianc/node-postgres](https://github.com/brianc/node-postgres) | `^8.23.1` | MIT | PostgreSQL Client for Node.js (Connection pooling, transactional SQL) | Dependency | Integrated (Issue #5) |
| **class-validator** | [typestack/class-validator](https://github.com/typestack/class-validator) | `^0.14.4` | MIT | Decorator-based DTO validation | Dependency | Integrated (Issue #5) |
| **class-transformer** | [typestack/class-transformer](https://github.com/typestack/class-transformer) | `^0.5.1` | MIT | Object transformation and type conversion | Dependency | Integrated (Issue #5) |
| **@nestjs/swagger** | [nestjs/swagger](https://github.com/nestjs/swagger) | `^7.4.2` | MIT | OpenAPI (Swagger) module for NestJS | Dependency | Integrated (Issue #5) |
| **swagger-ui-express** | [scottie1984/swagger-ui-express](https://github.com/scottie1984/swagger-ui-express) | `^5.0.1` | MIT | Serve Swagger UI assets from Express | Dependency | Integrated (Issue #5) |
| **decimal.js** | [MikeMcl/decimal.js](https://github.com/MikeMcl/decimal.js) | `^10.6.0` | MIT | Arbitrary-precision decimal arithmetic for financial calculations | Dependency | Integrated (Issue #5) |

---

## License Compliance & Version Notes

1. **Keycloak Versioning Review**:
   - Pinned known-working version: `24.0.5`.
   - Keycloak `26.8.0` (released October 2026) was evaluated. Keycloak 26 introduced substantial breaking changes in realm JSON export format, role mapping locations, Infinispan Marshalling, and session persistence requirements. Furthermore, `keycloak-js` on npm currently only extends up to `26.2.4`.
   - To avoid unnecessary pipeline flakiness and maintain reproducible zero-configuration realm import, `24.0.5` is pinned as the known-working baseline. Upgrading to the 26.x series is cataloged as a planned security-hardening follow-up.

2. **Apache APISIX Versioning & Architecture Review**:
   - Pinned exact stable upstream release: `3.19.0` (Docker image: `apache/apisix:3.19.0-debian`, released September 28, 2026, licensed under Apache-2.0).
   - Upstream evaluation confirmed `3.19.0` fixes previous batch request DoS vulnerabilities, introduces enhanced `claim_validator.audience` enforcement, and provides mature standalone mode (`config_provider: yaml`).
   - Deployment mode: **Standalone data plane**. By declaring routes, upstreams, and plugins directly in Git (`infra/apisix/apisix.yaml`), we avoid the operational overhead and failure points of a dedicated etcd cluster for single-node development and CI while ensuring complete infrastructure reproducibility.

3. **Permissive Licenses (Apache-2.0, MIT, PostgreSQL License)**:
   - Permissive licenses allow distribution, modification, and integration with minimal obligations beyond preserving copyright notices and disclaimers.
   - SmartProcure-Pay's MIT License is fully compatible with consuming these upstream projects.

3. **AGPL-3.0 Components (MinIO, Grafana)**:
   - MinIO and Grafana are used as unmodified external services (deployed via container orchestration).
   - Any distribution or deployment license obligations must be respected in accordance with their respective upstream licenses.
   - For internal guidelines on adding new dependencies, see [License Policy](docs/open-source/LICENSE_POLICY.md).
