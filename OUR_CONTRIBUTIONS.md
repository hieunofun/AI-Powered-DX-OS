# Attribution and original contributions

Implementation baseline: `develop@42dd7a3`, 7 October 2026. This inventory distinguishes integrated third-party software from project-authored modules. It does not assign copyright or contributions to an unidentified team member. Exact upstream versions, licenses and notices are in [OPEN_SOURCE_COMPONENTS.md](OPEN_SOURCE_COMPONENTS.md).

## Integrated third-party components

| Component | Upstream license | Reused capability and integration |
| --- | --- | --- |
| Keycloak | Apache-2.0 | External OIDC identity provider; project-authored realm configuration and JWT/RBAC integration |
| Apache APISIX | Apache-2.0 | External gateway; project-authored routing/authentication/rate-limit configuration |
| PostgreSQL | PostgreSQL License | External relational store; project-authored schema, triggers and migrations |
| MinIO | AGPL-3.0 | Unmodified external object store built from pinned upstream source; project-authored Docker build and file linkage |
| Flowable REST | Apache-2.0 | External BPMN engine; project-authored process definition, orchestration adapters and recovery |
| ImmuDB server / official Go client 1.11.0 | **BUSL-1.1** | Source-available external ledger and linked proof client, with a scoped policy exception |
| React / Vite / NestJS / supporting packages | Respective inventory licenses | Frameworks and tooling for project-authored web/API code |
| PDFKit / Noto Sans | MIT / SIL OFL-1.1 | PDF renderer and bundled Unicode font; retained upstream notices |

Prometheus and Grafana are planned deployments. APISIX exports metrics, but a fully deployed observability stack is not claimed. BUSL is not currently Apache-2.0 or an OSI-approved license; the ledger's competition eligibility remains [Issue #22](https://github.com/hieunofun/SmartProcure-Pay/issues/22).

Issue #23 adds original React PO/GRN workspaces, typed authenticated requests, four-place fixed-scale quantity helpers, bounded supplier/fulfillment reads and real browser acceptance scenarios. Playwright is development tooling; `caniuse-lite` is unchanged build-time compatibility data with attribution recorded in [the component inventory](OPEN_SOURCE_COMPONENTS.md).

Issue #24 adds original invoice intake/evidence screens, role-based approval workspaces and audit verification/report UX, plus bounded invoice-case lookup and explicit report verification-status headers. No AI, OCR, legal signature or bank execution is attributed to this change.

## Implemented project-authored work

| Original contribution | Implementation evidence |
| --- | --- |
| Monorepo, executable application skeleton and CI acceptance pipeline | [PR #11](https://github.com/hieunofun/SmartProcure-Pay/pull/11) |
| Procurement domain schema, relational consistency, exact numeric boundaries and reference seed | [PR #12](https://github.com/hieunofun/SmartProcure-Pay/pull/12), migrations 001-014 |
| Identity adapter, backend JWT audience verification, role guards and frontend PKCE integration | [PR #13](https://github.com/hieunofun/SmartProcure-Pay/pull/13) |
| Gateway policies and gateway/backend trust boundaries | [PR #14](https://github.com/hieunofun/SmartProcure-Pay/pull/14) |
| Purchase order lifecycle, decimal arithmetic, optimistic locking and audit writes | [PR #15](https://github.com/hieunofun/SmartProcure-Pay/pull/15) |
| Goods receipts, accepted/rejected quantity rules, fulfillment and concurrency protection | [PR #16](https://github.com/hieunofun/SmartProcure-Pay/pull/16) |
| Secure XML adapters, bounded ingestion, private raw-file archival and duplicate handling | [PR #17](https://github.com/hieunofun/SmartProcure-Pay/pull/17) |
| Deterministic item resolution, three-way rules, historical policy snapshots and real acceptance fixtures | [PR #18](https://github.com/hieunofun/SmartProcure-Pay/pull/18) |
| Exception BPMN, STP/role routing, decisions and durable workflow recovery | [PR #19](https://github.com/hieunofun/SmartProcure-Pay/pull/19) |
| Canonical/Merkle audit package construction, ledger adapter, native proof verifier, recovery and JSON/PDF reports | [PR #20](https://github.com/hieunofun/SmartProcure-Pay/pull/20) |

The official proof client supplies the cryptographic primitives. Project-authored verifier orchestration and reporting do not relicense the linked BUSL dependency. Financial rules and domain processes are application code; the underlying databases/gateway/process engines are reused services.

## Planned original work

- Operational PO/GRN/invoice/approval/audit UI.
- Semantic item-matching suggestions with model provenance and recorded confirmation.
- Actual OCR extraction with field review; the current PDF provider is a pending stub.
- Invoice signature trust verification, tax-risk source integration and any later CFO PKI/payment integration.
- Operational analytics, a versioned demo and validated long-term retention/recovery procedures.

These are not implementation claims. Their scope and completion criteria are in the [next backlog](docs/project/MVP_ROADMAP.md).

## Upstream source changes and notices

No modified upstream service fork is claimed by this baseline. MinIO is built from unmodified pinned source, while the project maintains build/configuration files and adapters. Retain upstream license/copyright notices in images and distributions, including BUSL for ImmuDB, the MIT notice for the XML dependency, and OFL for Noto Sans. Future upstream modifications must record source commit, patch and license separately.
