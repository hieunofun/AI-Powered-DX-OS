# Architectural Attribution & Contributions

This document delineates the boundary between third-party open-source building blocks and the original software contributions developed by the **SmartProcure-Pay** team.

---

## 1. Reused Open Source Components

Issue #23 adds original React PO/GRN workspaces, typed authenticated requests, four-place fixed-scale quantity helpers, bounded supplier/fulfillment reads and real browser acceptance scenarios. Playwright is development tooling; `caniuse-lite` is unchanged build-time compatibility data with attribution recorded in [the component inventory](OPEN_SOURCE_COMPONENTS.md).

SmartProcure-Pay leverages proven, industry-grade open-source platforms to establish a robust infrastructure layer (based on the DX-OS Open-Core architecture):

- **Keycloak** (Apache-2.0): Leveraged for centralized authentication, OAuth2/OIDC token exchange, and Role-Based Access Control (RBAC).
- **Apache APISIX** (Apache-2.0): Leveraged as the cloud-native API Gateway for microservices routing, SSL termination, and rate limiting.
- **PostgreSQL** (PostgreSQL License): Leveraged as the enterprise relational data store for structured operational records and transactional consistency.
- **MinIO** (GNU AGPLv3): Leveraged as S3-compatible high-performance object storage for raw invoice payloads (XML, PDF, scans).
- **Flowable** (Apache-2.0): Leveraged as the BPMN 2.0 orchestration engine for managing complex approval workflows and exception hierarchies.
- **ImmuDB** (Apache-2.0): Leveraged as the cryptographic immutable ledger to seal reconciliation decisions and audit packages.
- **Prometheus & Grafana** (Apache-2.0 / AGPLv3): Leveraged for real-time telemetry, operational metrics, and monitoring dashboards.

All reused components are consumed as unmodified external services via Docker orchestration and standard APIs.

---

## 2. Built by SmartProcure-Pay Team

> [!IMPORTANT]
> **Status: Planned team contributions (Phase 0)**.
> In accordance with Phase 0 project boundaries, the items listed below represent the planned original contributions to be implemented in upcoming milestones. None of the business logic modules below are claimed as completed in the initial bootstrap phase.

The core business value and algorithmic differentiation created specifically by the SmartProcure-Pay development team include:

1. **Procurement Domain Model**: Domain-driven data models and relational schemas unifying Purchase Orders, Goods Receipts, and Invoices.
2. **Purchase Order Business Logic**: Lifecycle management of POs, budget verification, item line allocation, and status progression.
3. **Goods Receipt Business Logic**: Inventory intake recording, partial fulfillment tracking, and warehouse variance logging.
4. **Invoice Ingestion Pipeline**: Multi-format ingestion adapter supporting XML electronic invoices, PDF extraction, and schema normalization.
5. **3-Way Matching Engine**: High-performance algorithmic engine reconciling PO ↔ GRN ↔ Invoice lines across quantity, price, tax, and currency.
6. **Semantic Matching Policy**: Intelligent rule evaluation layer supporting customizable tolerance thresholds and line-item reconciliation heuristics.
7. **Exception Workflow**: Automated discrepancy routing, quarantine states, and financial supervisor resolution paths.
8. **Audit Package Builder**: Cryptographic packager generating deterministic SHA-256 hashes and tamper-evident audit receipts for ImmuDB sealing.
9. **Business Dashboard**: Unified procurement and finance analytical interface displaying reconciliation rates, variance analysis, and cash flow readiness.

---

## 3. Modified Open Source Code

- **Current Status**: None.
- All external dependencies and platforms currently utilized or planned are incorporated as external services or standard libraries without source code forks or direct modifications.
- If any upstream open-source code is customized or modified in future phases, detailed diffs, original upstream commit hashes, and licensing attributions will be documented in this section.
