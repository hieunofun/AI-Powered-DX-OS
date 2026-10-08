# Changelog

Notable changes are recorded using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). No version has been tagged or released yet; the existing package version does not establish a published release. Dates below are implementation PR merge dates in Asia/Saigon.

## [Unreleased]

### Added

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

- Procurement workspaces replace the diagnostic-only start page; platform checks remain separate. Reuse Keycloak initialization under StrictMode, preserve bookmark routes and permit clearing the optional PO delivery date.

- Replace obsolete Phase 0 status/attribution with the implemented backend baseline and explicit remaining UI/OCR/AI/trust/payment scope.
- Document the gateway runtime URL, workflow/ledger bootstrap, reference seed and local-versus-live-stack test boundaries.

### Licensing

- Review the unchanged `caniuse-lite` CC-BY-4.0 browser dataset as a scoped build-data exception, retaining attribution and notices; Playwright is pinned Apache-2.0 development tooling. This does not resolve runtime ledger Issue #22.

- Record the integrated ImmuDB server/client 1.11.0 as BUSL-1.1 source-available; Apache-2.0 is its future Change License. Preserve the scoped existing policy exception and track competition eligibility in [Issue #22](https://github.com/hieunofun/SmartProcure-Pay/issues/22).

### Release gates

- Operational UI and reproducible demo scenarios, a licensing decision, real-stack acceptance and genuine peer review remain prerequisites for a tagged MVP demo release.
