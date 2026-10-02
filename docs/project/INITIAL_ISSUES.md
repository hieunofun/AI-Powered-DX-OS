# Initial Project Backlog Issues (Phase 0 Baseline)

This document contains the foundational backlog of the initial 10 issues designed for **SmartProcure-Pay**. Each issue includes a comprehensive specification: Description, Scope, Acceptance Criteria, Out of Scope, and Dependencies.

---

## Issue #1: [BOOTSTRAP] Project bootstrap & Docker foundation
- **Labels**: `bootstrap`, `documentation`, `open-source`
- **Description**: Establish the baseline monorepo workspace, core directory layout, environment configuration templates, initial container orchestration skeleton, and open-source governance guidelines.
- **Scope**:
  - Monorepo folder layout (`apps/`, `services/`, `packages/`, `infra/`, `database/`, `docs/`).
  - Environment variable template (`.env.example`) with complete placeholders.
  - Initial `docker-compose.yml` defining the internal network bridge and primary database service skeleton.
  - Project governance baseline: `README.md`, `LICENSE`, `CHANGELOG.md`, `CONTRIBUTING.md`, `OPEN_SOURCE_COMPONENTS.md`, `OUR_CONTRIBUTIONS.md`, and `LICENSE_POLICY.md`.
  - Git workflow conventions (`main`, `develop`, `feature/*`, `fix/*`, `docs/*`).
- **Acceptance Criteria**:
  - [ ] All required directories exist and are tracked by Git using `.gitkeep` where empty.
  - [ ] `.gitignore` prevents tracking `.env`, secrets, build artifacts, and node_modules.
  - [ ] `docker-compose.yml` config passes validation and declares `smartprocure-network`.
  - [ ] Open-source licensing policies and verified component registries are committed.
- **Out of Scope**:
  - Implementation of application business logic or backend APIs.
  - Starting production-heavy containers prior to service bootstrap.
- **Dependencies**: None.

---

## Issue #2: [DATA] Design PostgreSQL domain schema
- **Labels**: `data`
- **Description**: Design and implement the relational domain database schema for procurement, warehouse receiving, electronic invoicing, reconciliation, and audit logs.
- **Scope**:
  - DDL migrations for core entities:
    - `suppliers` (Vendor profile, tax ID, payment terms)
    - `purchase_orders` & `purchase_order_items` (PO headers, line quantities, unit prices, tax, delivery deadlines)
    - `goods_receipts` & `goods_receipt_items` (GRN header, warehouse receiver, received qty, damaged qty)
    - `invoices` & `invoice_items` (Invoice header, digital invoice number, line descriptions, amounts, VAT)
    - `match_results` (3-way matching run outcomes, discrepancy types, line-level flags)
    - `approval_cases` (Approval tracking, state transitions, assigned actors)
    - `audit_records` (Event timeline, actor, cryptographic hash, sealing status)
  - Indexing strategy on foreign keys, invoice lookup numbers, and matching status fields.
  - Seed scripts for realistic test scenarios (matched cases, partial deliveries, price variances).
- **Acceptance Criteria**:
  - [ ] Migration scripts run cleanly against a fresh PostgreSQL 16 instance.
  - [ ] Foreign keys, cascading constraints, and uniqueness checks are strictly enforced.
  - [ ] Seed data populates valid procurement transactions and error variance cases.
- **Out of Scope**:
  - No ORM/API business logic implementation in this issue (pure schema & migrations).
- **Dependencies**: Issue #1.

---

## Issue #3: [IDENTITY] Integrate Keycloak SSO & RBAC
- **Labels**: `identity`, `security`
- **Description**: Integrate Keycloak as the centralized OpenID Connect (OIDC) identity provider with Role-Based Access Control (RBAC) tailored for the Procure-to-Pay lifecycle.
- **Scope**:
  - Keycloak realm configuration export/import for `smartprocure`.
  - Definition of standard enterprise roles:
    - `admin`: System administration & global configuration
    - `buyer`: Creation and management of Purchase Orders
    - `warehouse`: Inventory intake, Goods Receipt recording
    - `accountant`: Invoice ingestion, matching review, payment scheduling
    - `finance_manager`: Exception approval, dispute resolution, payment authorization
  - Client application configuration for frontend web and backend API services.
  - JWT token validation middleware / configuration.
- **Acceptance Criteria**:
  - [ ] Keycloak container initializes with pre-configured realm and role definitions.
  - [ ] Users with designated roles receive valid JWTs with mapped role claims.
  - [ ] API services can verify tokens offline using Keycloak JWKS public keys.
- **Out of Scope**:
  - Custom UI login page theming (use Keycloak default theme initially).
  - External LDAP / Active Directory federation.
- **Dependencies**: Issue #1, Issue #2.

---

## Issue #4: [GATEWAY] Integrate Apache APISIX API Gateway
- **Labels**: `gateway`, `security`
- **Description**: Deploy and configure Apache APISIX as the unified entry point for microservices routing, authentication enforcement, rate limiting, and traffic observability.
- **Scope**:
  - Route definitions forwarding traffic to web UI, core API, and backend microservices.
  - Authentication plugin integration (`openid-connect` or `jwt-auth`) validating tokens issued by Keycloak.
  - Global CORS policies supporting local and staging frontend origins.
  - Rate limiting plugins to protect sensitive endpoints (e.g. invoice ingestion).
  - Access logging and Prometheus metrics exporter integration.
- **Acceptance Criteria**:
  - [ ] APISIX routes public endpoints and securely blocks unauthorized requests.
  - [ ] Valid Keycloak bearer tokens pass through with enriched user identity headers.
  - [ ] CORS preflight requests succeed for configured frontend domains.
- **Out of Scope**:
  - Custom Lua plugin development unless built-in plugins cannot meet requirements.
- **Dependencies**: Issue #1, Issue #3.

---

## Issue #5: [PROCUREMENT] Implement Purchase Order module
- **Labels**: `procurement`
- **Description**: Implement the backend business service and domain logic for managing the Purchase Order (PO) lifecycle from draft to approved and issued status.
- **Scope**:
  - CRUD operations for Purchase Orders and nested PO item lines.
  - Validation rules: supplier verification, unit prices, tax calculation, total amount consistency.
  - State machine transitions: `DRAFT` ──► `PENDING_APPROVAL` ──► `ISSUED` ──► `PARTIALLY_FULFILLED` ──► `COMPLETED` / `CANCELLED`.
  - RBAC enforcement: only users with `buyer` or `admin` roles can create or modify POs.
- **Acceptance Criteria**:
  - [ ] RESTful API endpoints for PO management documented with OpenAPI/Swagger.
  - [ ] Unit and integration test coverage for PO creation, item calculations, and state transitions.
  - [ ] Concurrent update handling and optimistic locking for PO modifications.
- **Out of Scope**:
  - External ERP automated synchronization (e.g. SAP / Oracle connectors).
- **Dependencies**: Issue #2, Issue #3.

---

## Issue #6: [WAREHOUSE] Implement Goods Receipt module
- **Labels**: `warehouse`
- **Description**: Implement the warehouse intake service to record physical shipments, inspect goods against issued Purchase Orders, and register Goods Receipt Notes (GRN).
- **Scope**:
  - Goods Receipt creation linked to an active `ISSUED` Purchase Order.
  - Line-level intake recording: received quantity, rejected/damaged quantity, package lot numbers.
  - Partial shipment handling and cumulative fulfillment calculation against PO lines.
  - Automated updates to PO fulfillment status upon GRN submission.
  - Role enforcement restricted to `warehouse` and `admin` actors.
- **Acceptance Criteria**:
  - [ ] API permits recording multiple GRNs against a single PO until order is fulfilled.
  - [ ] Prevents recording excess quantity beyond configurable over-delivery thresholds.
  - [ ] Integration tests verify cumulative quantity updates across multiple shipments.
- **Out of Scope**:
  - Barcode / RFID hardware scanner integrations.
- **Dependencies**: Issue #2, Issue #5.

---

## Issue #7: [INVOICE] Implement invoice ingestion pipeline
- **Labels**: `invoice`
- **Description**: Build an ingestion pipeline for electronic invoices supporting structured XML (e.g., Vietnam e-invoice standard formats), PDF documents, and secure archival in MinIO object storage.
- **Scope**:
  - Multi-part invoice upload endpoint accepting XML and PDF payloads.
  - MinIO client integration storing raw files in an isolated `invoices` bucket with metadata.
  - XML Parser extracting core attributes: Seller Tax Code, Buyer Tax Code, Invoice Number, Date, Line Items, Unit Prices, VAT rates, and Grand Total.
  - Fallback pipeline scaffolding for OCR extraction from scanned PDF/images.
  - Persistence of parsed invoice header and lines into PostgreSQL database.
- **Acceptance Criteria**:
  - [ ] Uploaded files are successfully persisted in MinIO with SHA-256 integrity checksums.
  - [ ] Standard XML electronic invoice parses deterministically into database entities.
  - [ ] Error handling captures corrupted or non-standard format files gracefully.
- **Out of Scope**:
  - Full-fledged custom ML OCR model training (use open-source OCR fallback wrappers where needed).
- **Dependencies**: Issue #1, Issue #2.

---

## Issue #8: [MATCHING] Implement 3-Way Matching Engine
- **Labels**: `matching`
- **Description**: Implement the deterministic core 3-Way Matching reconciliation engine comparing Purchase Orders, Goods Receipts, and Invoices across business rules.
- **Scope**:
  - Algorithmic matching pipeline evaluating the triad:
    1. PO (Authorized purchase terms)
    2. GRN (Physically received inventory)
    3. Invoice (Vendor financial claim)
  - Rule evaluation matrix:
    - Supplier identification (Tax code & legal entity match)
    - Item code & description alignment
    - Quantity consistency: `Invoice Qty <= GRN Qty <= PO Qty`
    - Unit price consistency: `Invoice Unit Price == PO Unit Price`
    - Tax rate & currency equivalence
    - Grand total reconciliation within defined tolerances (e.g., rounding variances)
  - Detailed discrepancy flagging: Price variance, Quantity variance, Missing GRN, Unrecognized item.
  - Generation of structured `match_results` records.
- **Acceptance Criteria**:
  - [ ] 100% test coverage for standard match scenarios (perfect 3-way match, partial receipt, price mismatch, quantity mismatch, tax mismatch).
  - [ ] Clear discrepancy codes returned for every failing line item.
  - [ ] High-throughput execution capable of sub-second matching for typical enterprise orders.
- **Out of Scope**:
  - Subjective fuzzy AI matching (handled in a separate semantic tolerance extension phase).
- **Dependencies**: Issue #2, Issue #5, Issue #6, Issue #7.

---

## Issue #9: [WORKFLOW] Implement invoice approval & exception workflow
- **Labels**: `workflow`
- **Description**: Orchestrate the business approval lifecycle, automatically routing successfully matched invoices for payment while sequestering mismatched invoices into exception queues.
- **Scope**:
  - Dual-path routing logic:
    - **Fast-Track Straight-Through Processing (STP)**: Perfectly matched invoices transition directly to `READY_FOR_PAYMENT`.
    - **Exception Path**: Invoices with discrepancies are placed in `DISCREPANCY_REVIEW` and assigned to designated roles based on variance type (Buyer for price variance, Warehouse for qty variance).
  - Flowable BPMN workflow definition for multi-level financial approvals above monetary thresholds.
  - Actions: Approve with adjustment, Reject invoice, Request vendor credit note.
- **Acceptance Criteria**:
  - [ ] Clean invoices pass straight to ready-for-payment without manual intervention.
  - [ ] Discrepancies generate actionable approval tasks for relevant role holders.
  - [ ] Audit trail records every workflow decision, reason code, and timestamp.
- **Out of Scope**:
  - Direct banking payment gateway or ERP disbursement triggers.
- **Dependencies**: Issue #3, Issue #8.

---

## Issue #10: [AUDIT] Implement immutable audit sealing
- **Labels**: `audit`, `security`
- **Description**: Build a cryptographic audit package builder and integrate ImmuDB to produce tamper-evident, verifiable proof for every reconciled Procure-to-Pay transaction.
- **Scope**:
  - Audit Package Assembly:
    - Serialized snapshot of PO, GRN, Invoice, Match Result, and Approval Sign-offs.
    - Deterministic SHA-256 cryptographic hash tree / digest calculation.
  - ImmuDB Client Integration:
    - Writing the signed transaction audit root into ImmuDB's append-only cryptographic ledger.
  - Verification API Endpoint:
    - External verification endpoint that fetches an audit package, recalculates the cryptographic hash, and verifies cryptographic proof against ImmuDB.
- **Acceptance Criteria**:
  - [ ] Every finalized matching transaction is sealed into ImmuDB with an immutable receipt.
  - [ ] Verification endpoint accurately detects any simulated database record tampering.
  - [ ] Proof of immutability can be exported as a standalone JSON/PDF cryptographic verification report.
- **Out of Scope**:
  - Public blockchain anchoring (ImmuDB zero-trust cryptographic verification is sufficient).
- **Dependencies**: Issue #1, Issue #2, Issue #8, Issue #9.
