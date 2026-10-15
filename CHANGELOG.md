# Changelog

Notable changes are recorded using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). No version has been tagged or released yet; the existing package version does not establish a published release. Dates below are implementation PR merge dates in Asia/Saigon.

## [Unreleased]

### Added

- System acceptance candidate (#66): read-only BRS/GitHub release qualification audit, native isolated hot/cold PostgreSQL restore rehearsal with exact hashes/BIGINT preservation and actual SELECT-only role checks, plus scoped workload/resource evidence. Integrated AT-01..12 and owner production/restore/review gates remain explicit.

- AI quality/security evaluation candidate (#63): fixed-denominator OCR/mapping/grounded-answer scorers, separately frozen synthetic document-injection corpus and source-bound citation metrics, malicious upload/tenant/worker/tool probes with retained failures and explicit owner integration gates.

- Proposed AI mediation (#54): source-bound extractive Gemini explanations, server missing-evidence reporting, closed R0–R2 action registry with R3/transfer denial, current policy/independent decision/transactional execution ports, persisted leases/idempotency/history and tenant control epochs. Real synthetic model evaluation and labelled runtime fixtures are separate; production #43/#50 integration remains gated.

- Proposed reviewed item mapping (#25): preserve exact deterministic identities, use a separate Gemini alias suggestion prompt for unresolved items, enforce tenant/PO candidate ownership and durable human decisions with transactional authorization/outbox. Add fictional dev/held-out evaluation, explicit fallback, immutable history and real SQL/storage/AV acceptance evidence; production domain integration remains pending.

- Proposed external-order and cumulative receiving-sensor ingress (#51): immutable native receipts before acknowledgement, independent source schemas, tenant/source authorization, replay/conflict handling, bounded durable workers, CLEAN evidence witnesses and atomic pending case-intent/lineage handoff. Independent loopback HTTP simulators and isolated runtime acceptance retain their limitations; production #43/#53 integration and review remain gates.

- Proposed separate cold history (#57): immutable source snapshots/lineage, atomic live/backfill cursors and runs, committed capture-watermark pagination, current ACL/retention/hold enforcement and explicitly scoped case/time/error metrics. SELECT-only reporting composition and separate-database acceptance remain distinct from production #43/#50 integration.

- Proposed evidence lineage (#46): atomic raw/run/correction/confirmation snapshots and typed links, immutable history/deduplication, authorized graph pagination with encrypted cursors, literal filename/retention search and a verified identity/current membership boundary. Production #43 and match/decision integration remain pending.

- Issue #26 (draft): durable PDF/image OCR suggestions, trusted PDF text spans, append-only corrections, exact invoice validation and atomic reviewed confirmation/outbox. The bounded PDF parser uses PDF.js 6.4.299 and proposes Node 24; real synthetic Gemini/PG/MinIO/AV acceptance is recorded, with tenant/domain integration gates explicit.

- Issue #38 (local review candidate): replaceable backend Gemini extraction adapter with bounded HTTP/deadline/quota/token controls, untrusted field suggestions and provenance; versioned synthetic Vietnamese PDF dev/held-out corpus and exact-field evaluation tooling. Runtime OCR intake/persistence remains gated by #37/#41/#26.

- Issue #41 (draft): tenant-scoped evidence registration/upload/read ports, private source hashes, durable scan leases/retries, ClamAV quarantine and guarded clean-byte delivery. An isolated PostgreSQL/MinIO/clamd fixture exercises the runtime; production tenant composition and migration integration await review.

- Issue #24: Vietnamese XML/PDF intake status, saved three-way comparison, role-based task decisions and native audit verification/JSON/PDF export workspaces. Add direct invoice-case lookup and explicit export-status headers; CI runs 11 real browser scenarios.

- Issue #23: Vietnamese PO/GRN lists, detail views and guarded draft/lifecycle actions; bounded supplier lookup and finalized receipt quantities. Real browser acceptance and exact-decimal tests run in CI.

- 2026-10-03: Executable React/NestJS monorepo, health endpoint, Docker foundation and CI - [Issue #1](https://github.com/hieunofun/SmartProcure-Pay/issues/1), [PR #11](https://github.com/hieunofun/SmartProcure-Pay/pull/11).
- 2026-10-04: PostgreSQL domain model, constraints, indexes and reference seed - [Issue #2](https://github.com/hieunofun/SmartProcure-Pay/issues/2), [PR #12](https://github.com/hieunofun/SmartProcure-Pay/pull/12).
- 2026-10-04: Keycloak OIDC/PKCE and backend JWT/RBAC - [Issue #3](https://github.com/hieunofun/SmartProcure-Pay/issues/3), [PR #13](https://github.com/hieunofun/SmartProcure-Pay/pull/13).
- 2026-10-04: Apache APISIX routing, authentication, CORS and rate-limit validation - [Issue #4](https://github.com/hieunofun/SmartProcure-Pay/issues/4), [PR #14](https://github.com/hieunofun/SmartProcure-Pay/pull/14).
- 2026-10-04: Purchase order API/lifecycle, exact financial arithmetic and optimistic locking - [Issue #5](https://github.com/hieunofun/SmartProcure-Pay/issues/5), [PR #15](https://github.com/hieunofun/SmartProcure-Pay/pull/15).
- 2026-10-04: Goods receipt API/lifecycle, cumulative accepted quantities and policy audit - [Issue #6](https://github.com/hieunofun/SmartProcure-Pay/issues/6), [PR #16](https://github.com/hieunofun/SmartProcure-Pay/pull/16).
- 2026-10-05: XML invoice adapters, private MinIO storage, file hashes and ingestion recovery; PDF-only input remains pending OCR - [Issue #7](https://github.com/hieunofun/SmartProcure-Pay/issues/7), [PR #17](https://github.com/hieunofun/SmartProcure-Pay/pull/17).
- 2026-10-05: Deterministic three-way matching, discrepancy evidence, historical policies and concurrency validation - [Issue #8](https://github.com/hieunofun/SmartProcure-Pay/issues/8), [PR #18](https://github.com/hieunofun/SmartProcure-Pay/pull/18).
- 2026-10-06: Flowable invoice approval/exception workflow, role tasks, STP and durable recovery - [Issue #9](https://github.com/hieunofun/SmartProcure-Pay/issues/9), [PR #19](https://github.com/hieunofun/SmartProcure-Pay/pull/19).
- 2026-10-07: Canonical/Merkle audit evidence, native ImmuDB proofs, recovery and JSON/PDF reports - [Issue #10](https://github.com/hieunofun/SmartProcure-Pay/issues/10), [PR #20](https://github.com/hieunofun/SmartProcure-Pay/pull/20).
- 2026-10-07: DX-OS component responsibilities, confirmed team accounts and reviewable next-delivery specifications - [Issue #21](https://github.com/hieunofun/SmartProcure-Pay/issues/21).

### Changed

- Issue #34: reserve effective invoice quantities independently of the original matching outcome. Recheck current PO/receipt capacity before durable approving intents and recovery, retain claims through ambiguous outcomes, release rejected/credit-note claims and block GRN cancellation that removes their stock. New matching uses 3WM-1.1; historical snapshots and seals remain unchanged. CI adds seven real quantity scenarios.

- Procurement workspaces replace the diagnostic-only start page; platform checks remain separate. Reuse Keycloak initialization under StrictMode, preserve bookmark routes and permit clearing the optional PO delivery date.

- Replace obsolete Phase 0 status/attribution with the implemented backend baseline and explicit remaining UI/OCR/AI/trust/payment scope.
- Document the gateway runtime URL, workflow/ledger bootstrap, reference seed and local-versus-live-stack test boundaries.

### Licensing

- Review the unchanged `caniuse-lite` CC-BY-4.0 browser dataset as a scoped build-data exception, retaining attribution and notices; Playwright is pinned Apache-2.0 development tooling. This does not resolve runtime ledger Issue #22.

- Record the integrated ImmuDB server/client 1.11.0 as BUSL-1.1 source-available; Apache-2.0 is its future Change License. Preserve the scoped existing policy exception and track competition eligibility in [Issue #22](https://github.com/hieunofun/SmartProcure-Pay/issues/22).

### Release gates

- Operational UI and reproducible demo scenarios, a licensing decision, real-stack acceptance and genuine peer review remain prerequisites for a tagged MVP demo release.

## Unreleased — Project 4 foundation

- Preserve the annotated PR3 code baseline; document contribution gates and the 36-item issue mapping.
- Propose core/pack, tenancy and compatibility ADRs; add OpenAPI/JSON Schemas and synthetic contract fixtures with CI validation.
- Runtime PR3 routes remain unchanged; PR4 targets await review and implementation.
