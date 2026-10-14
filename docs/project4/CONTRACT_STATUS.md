# Contract maturity and review decisions

All contracts are **proposed** in #37 until peer review and merge. First-wave means the shape/behavior is specified enough for that review; it does not mean runtime endpoints exist or issues can become Ready before merge. OpenAPI operation `x-contract-stage` distinguishes the first wave from skeletons.

| Contract | Defined in this draft | Needs subsequent specification / owner |
| --- | --- | --- |
| Core/pack boundary | Paths/import direction/ownership and no domain vocabulary in core | #40 executable import checks and adapter extraction, A |
| Tenant/principal | Verified active tenant, service/user kind, resource permission checks, 404 isolation | #43 Keycloak mapper/switching/backfill/RLS and grant administration, A |
| Evidence intake | Registration/upload/download, file limits/state/quarantine/hash/idempotency/failure | #41 AV engine/license/worker limits/decompression and cleanup, B |
| OCR review | SourceRef known/unknown, draft/correction/revision/confirmation, domain decimal payload | #38 provider/model/terms/budget and evaluation; #26 persistence/provider/supplier validation, B |
| Evidence lineage | Generic typed links/event refs/tenant ACL | #46 concrete links/search/retention permissions and pagination, B |
| Workflow/tasks | Versioned start/input refs, candidate permissions, task actions/durable operation | #45 definition registration/migration, complete/claim guards/delegation/reconciliation details, A |
| Policy | Version/effective/hash/schema refs and immutable snapshots | #48 rule DSL/parameters, publish/revoke/SoD/running-workflow policy, A |
| Decision | Frozen facts/evidence/policy/workflow/actor/result refs | #50 create/authorize/execute persistence and risk-tier audit policy; revision/hash/export threat model, A |
| Replay | Historical locked facts + policy B, SIMULATION/NONE, explicit errors | #56 supported evaluators/rule diff/missing-version/isolated execution details, A |
| Pack | Minimum version/permission/schema/workflow/event/evidence/migration manifest | #59 compatibility grammar/registry/install/disable/error behavior and SDK, A |
| OpenResolve | Draft payload, receipt quantity facts, case reason/state and BRS invariants | #53 domain state/action/compensation guards and migration, A |
| AI action mediation | Resource permissions, risk R0-R3 approval gate and R4 exclusion in ADR/BRS | #54 tool schemas/kill-switch/provenance/quotas; no AI-action endpoint promised yet, B |
| Onboarding | Reuse goal/permissioned workflow/evidence and sample manifest | #60 HR schema/checklist/access-request contract; no onboarding runtime/schema implemented here, B |
| Cold data/connectors/ops | Ownership/event/safety requirements | #51 source mappings, #57 retention/query, #65 drift/backup/restore mechanism; not target Ready yet |

First-wave APIs use `/extractions`, `/confirmations`, `/decisions/evaluations` and `/replays` as plural resource collections. Blueprint illustrative paths (`/decisions/evaluate`, `/{id}/authorize`, `/{id}/replay`) are examples, not existing routes. This draft standardizes the collection naming; reviewers can change it before merge. The AI illustrative actions:propose path is deferred until #54 specifies execution schemas.

## Existing versus target APIs

| Existing PR3 API (code evidence) | Target / migration |
| --- | --- |
| GET /auth/me, JWT realm roles | GET /platform/v1/context adds verified tenant/action context; old response kept |
| PO/GRN controllers at /purchase-orders, /goods-receipts | Remain in OpenResolve adapter; no rename in foundation |
| POST /invoices/ingest multipart purchaseOrderId+xml/pdf | Existing XML path unchanged. New generic evidence + extraction/correction/confirmation leads to pack ingest; explicit adapter maps snake_case→existing CanonicalInvoiceData |
| GET /invoices and /invoice-ingestions/:id | Retain current shapes/statuses; target Evidence/Operation are separate contracts |
| POST /invoices/:invoiceId/workflow/start, approval-cases/tasks/my-approval-tasks | Keep domain adapter; generic tasks/start introduced after #45; domain roles/BPMN stay in pack |
| GET/PATCH /workflow/policy | Existing mutable workflow config retained until #48 versioned migration; historic evaluation snapshots stay pinned |
| Audit JSON/PDF/verify endpoints | Keep PR3 proof/export/trust semantics; generic decision export is later #50/#22 |

No router/database/runtime change is part of this PR. Migration adapters must be covered by existing real-stack tests before replacing behavior. A fallback to an old route cannot bypass new tenant/clean-state gates after PR4 tenant cutover.

## Review checklist and open gates

- B validates field/source/confirmation/provider failure behavior and invoice schema against PR3 parsers.
- C validates H-P-D-I/client/error/cursor usefulness and vi-VN terminology.
- A validates tenant/action/resource/SoD/operations/compatibility and shared ownership.
- The logged account hieunofun must not self-approve; obtain at least one actual peer review and CI on latest SHA. Review requests are not recorded approvals.
- #22 selects ledger eligibility; current BUSL remains a release gate. #38 selects provider and exact allowed document disclosure/terms; #41 selects AV. No new runtime dependencies were adopted.
- After combined #36/#37 merge and acceptance, create #22 then #40 for A, #38 for B, #39 for C from newly fetched develop. Until then dependencies stay Blocked or Needs specification.
