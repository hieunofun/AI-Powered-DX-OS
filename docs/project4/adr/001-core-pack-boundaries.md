# ADR-001 — Keep the modular monolith and extract reusable core ports

Date: 2026-10-14. Status: proposed, awaiting peer review in P4-02 #37. Owner A; reviewers B/C. This records a design choice for review, not a completed refactor.

## Context and code evidence

PR3 already provides a NestJS modular API, React/Vite web, Keycloak, APISIX, PostgreSQL, MinIO and Flowable. `apps/api/src/app.module.ts` wires domain modules directly; `workflow/workflow.service.ts` imports domain TASK_ROLES and knows invoice snapshots; `invoices/invoices.service.ts` rejects structured OCR results because persistence is absent. Identity principal has sub/username/roles but no tenant. Existing matching and durable workflow reservations must survive.

## Decision

Retain apps/api and apps/web. Introduce `apps/api/src/platform/{identity,tenancy,evidence,workflow,policy,decision,audit,integration}` incrementally in P4-06 and later issues. Contracts live in the existing `packages/contracts/opendx/v1`. Add `apps/api/src/packs/{openresolve,onboarding}` only when extracting the relevant modules. These are target paths, not directories created by this foundation PR.

The composition root can import platform and packs. Platform imports ports, shared primitives and generic contracts; it cannot import packs, current purchase-orders/goods-receipts/invoices/matching modules, business DTOs, PO/GRN/Invoice/Employee/Payroll names or pack-specific role/stage enums. Pack code imports platform public ports and its own domain code. Keep current domain modules in place until a narrow PR moves them. A composition root is the sole exception for wiring; it contains no business rule. An import-boundary checker is acceptance for #40, not falsely declared implemented here.

| Layer | Owns | Does not own |
| --- | --- | --- |
| Core, headless | Verified principal/tenant, resource grants, evidence primitives, generic workflow/tasks, policy snapshots, decision records, outbox/inbox and audit ports | Business entity schemas, matching rules, procurement/HR states |
| H-P-D-I, apps/web | Shared inbox, process inspection, evidence and AI review workspaces; vi-VN business UI | Backend authorization or direct DB/storage/admin-secret access |
| OpenResolve pack | PO/receipt/QC/invoice/exception rules, exact matching/reservations, domain workflow definitions | Independent SSO/storage/engine implementations |
| Onboarding pack | Candidate/checklist/access-request rules and schemas | HR-specific modifications to core |

Business packs use generic subject/ResourceRef and versioned schemas. Pack-specific payloads stay behind their schema IDs; the platform checks schema registration/permissions without interpreting invoice or employee fields. Domain parsers and financial validators run in OpenResolve; the platform OCR port produces untrusted generic drafts. Business UI calls gateway API only.

## Data ownership and compatibility migration

Core owns evidence/extraction/correction/confirmation metadata, grants, task mirrors, generic durable operations, versioned policy/decision metadata and outbox/inbox. Packs own their business tables and rules. Shared PostgreSQL is retained; namespace ownership does not require separate databases. No pack queries another pack's tables. Read through authorized ports or consume events with references and reauthorize reads.

Keep migrations 001-014 and the PR3 endpoints unchanged in this PR. Later tenant migration: inventory counts/hashes and FK relationships; create a configured default tenant UUID; backfill all existing domain rows and linked files/workflow/audit records; add NOT NULL and tenant-aware composite FKs/unique keys/indexes after validation. Revisit global invoice-number/supplier uniqueness under the same tenant boundary. Each query includes tenant predicate; transaction-scoped context avoids pooled-connection tenant leakage. PostgreSQL RLS is defense-in-depth pending #43 specification, never a replacement for service/resource checks.

Existing MinIO objects lack tenant prefixes. Create an explicit tenant→legacy-object mapping, copy if needed into tenant-scoped private keys, verify bytes/hash/size before switching references, retain the originals until rollback/retention policy permits removal. Do not infer legal ownership from a filename. Workflow instance/task business keys and historic receipts remain mapped to the default tenant; preserve Flowable engine IDs and verified trust state. Backfill provenance marks its migration source/version, not a fabricated original actor.

Deploy adapters for legacy routes and snake_case target routes with explicit mapping. Keep PR3 role checks and decimal semantics while adding tenant/resource checks; never map legacy `admin` into unrestricted cross-tenant data access. Preserve reservation transaction locks and uncertain-dispatch reconciliation. Upgrades use forward recovery; prohibit deleting volumes or rewriting finalized history. Verify counts, hashes, constraint checks and PR3 integration regressions before cutover. DDL/order/batch sizes are further specification in #43/#62.

## Alternatives

- Rewrite into microservices: adds deployment/transaction/migration costs before reuse is proven; rejected for this wave.
- Rename/move every module immediately: obscures behavior review and increases conflicts; rejected.
- Keep procurement vocabulary in a nominal core: prevents independent reuse and violates blueprint boundary; rejected.
- Introduce a dynamic plugin framework/broker now: no immediate requirement; defer hot lifecycle to P4-41 and broker adoption until measured need. Use durable operations/outbox first.

## Consequences and review gates

Each extraction PR must preserve old regression and demonstrate a generic consumer. Onboarding #60 must call the same identity/workflow/evidence/decision ports with zero HR-specific core diff. Shared-file integration owner A coordinates AppModule/contracts/CI/lockfile/migration numbers. Generic evidence does not prove authenticity or legal validity. Ledger licensing/adapter selection remains #22; no choice or downgrade is made here.
