# API conventions, authorization and failure semantics

Status: proposed review contract, P4-02 #37, 2026-10-14. Existing API routes keep their current camelCase fields and error shapes; these target snake_case contracts are not exposed by this PR.

## Representation

- IDs are server-generated UUID strings; external source IDs are separate provenance strings. Timestamps are UTC RFC3339 with Z; dates YYYY-MM-DD. Revision is a positive integer for optimistic concurrency.
- API major version appears in path. Contract artifact version 0.1.0 is a review candidate for target API v1, not a deployed core release. Additive changes require compatibility review; breaking changes need a new major/migration plan.
- List pages: `items`, optional `next_cursor` (absent means final page). Default limit 25, range 1..100; stable sort created_at DESC,id DESC. Cursor is opaque, integrity-protected and bound to tenant/principal/filter; invalid or reused under another context returns 400, no rows leaked. Reauthorize every page. No offset/total requirement in first-wave APIs.
- Strict request objects reject unknown fields, tenant_id, actor or timestamps. Response metadata includes server-derived tenant_id. Filenames are untrusted display text; never storage keys. Generated object keys use tenant/<UUID>/evidence/<UUID>/revision/<n> inside a private bucket; bucket/keys are not public API authorization inputs.
- Financial values are plain decimal strings without exponent, sign, commas or locale formatting: quantity/unit_price at most 14 whole + 4 fractional digits; amount at most 16 whole + 2 fractional digits; VAT fraction 0..1 at four decimals. Writes with excess precision fail 422; do not silently round input. Deterministic arithmetic rounds line subtotal/tax HALF_UP at two decimals to preserve PR3, sums rounded lines, and validates declared totals. Quantity must be positive on invoice lines, nonnegative on receipt accounting. Legacy canonical response pads scales; target accepts valid plain strings and persisted output pads the relevant scale. A zero tax rate is valid.

## Permission and resource checks

| API | Required action | Resource/state check |
| --- | --- | --- |
| context | context.read | Active user/service membership; return effective tenant/grants |
| evidence registration/upload | evidence.register / evidence.upload | Own tenant, allowed retention class; upload only PENDING_UPLOAD and unexpired entitlement |
| evidence list/detail/download | evidence.read / evidence.download | Tenant + resource ACL; download additionally CLEAN |
| extraction request/read | extraction.request / extraction.read | CLEAN bytes, permitted schema/pack, authorized source asset |
| correction/confirmation | extraction.correct / extraction.confirm | Resource ACL, REVIEW_REQUIRED, exact expected_revision; only approved schema fields |
| operation read | operation.read | Tenant + permission on original resource; no job metadata leakage |
| workflow/task | workflow.start / task.read / task.claim / task.complete | Tenant, candidate action grants, pack availability; definition/version and task revision; SoD where sensitive |
| policy/decision/replay | policy.read / decision.evaluate / decision.read / decision.authorize / decision.replay | Tenant/resource/pack policy; authorizer must satisfy role and SoD; frozen authorized snapshots |
| OpenResolve case | openresolve.case.create / openresolve.case.read | Pack grant + authorized subject and all evidence |

Permissions in context are hints for UI; backend checks every request/resource. Pack manifests bound the service/tool allowlist; a declared permission does not grant it. A tenant admin remains scoped to their tenant. Actor/timestamps/corrections audit values are server-produced. Additional delegation rules remain future specification.

## Intake states and quarantine

Registration returns 201 evidence with PENDING_UPLOAD/NOT_STARTED and a protected PUT content path, expiring in 15 minutes. Metadata has no bytes yet. Upload verifies byte limit, MIME/magic and checksum; XML max 5 MiB, PDF/PNG/JPEG max 20 MiB, matching the registration maximum. Do not fetch arbitrary external URLs. Media-specific/decompression/parser limits and AV product/license are #41 implementation specification; fail closed until configured.

Valid quarantine transitions: PENDING_UPLOAD→PENDING_SCAN→CLEAN or INFECTED or SCAN_FAILED. A persisted retry can move SCAN_FAILED→PENDING_SCAN; INFECTED cannot be overridden by users. Non-CLEAN assets remain NOT_STARTED and cannot OCR/download. XML follows the same file safety boundary before deterministic parsing; parse DTD/XXE/malformed/unsupported formats are rejected. CLEAN means scan allowed processing, not legal authenticity.

Processing transitions after CLEAN: NOT_STARTED→QUEUED→PROCESSING→REVIEW_REQUIRED→CONFIRMED; errors become FAILED, and explicitly eligible retry creates a new run/provenance. Revoke access if a later scan changes the asset's safety classification. Concurrent upload/scan/processing transitions use guarded revisions; stale workers cannot mark an old revision clean. GET metadata remains available under ACL even for blocked files.

## Extraction, correction and confirmation

ExtractionRequest selects a registered pack schema and STRUCTURED_PARSER or OCR. A supported structured XML parser is preferred; an unsupported format is not invented by AI. Provider/model/prompt/run are recorded; absent location means SourceReference UNKNOWN with a reason, never a made-up page/box. KNOWN pages are one-based; bbox [x0,y0,x1,y1] is normalized 0..1 with ordered bounds, text offsets are Unicode code points in the stored version's page text with end>start. Confidence is optional 0..1, provider-reported and uncalibrated unless evaluation proves otherwise.

Each required field has status EXTRACTED with a value or MISSING without an invented value. Corrections carry expected_revision and original/new values, stored append-only with server actor/time. For a MISSING field, omit previous_value and record that no original suggestion existed; for EXTRACTED fields previous_value is required to equal the persisted value. Reject unknown paths, duplicate paths, previous-value mismatch and stale revisions. Registration and draft schemas forbid client actor/tenant fields. Confirmation rechecks the latest revision/source CLEAN/ACL, all required review fields and deterministic pack schema/date/decimal/tax/total/supplier validation. No direct submitted verified-payload bypass: derive payload from persisted extraction+corrections. Store immutable confirmation/facts version and enqueue domain intake/matching transactionally. 202 means a confirmation/durable operation exists, not a matched or approved invoice. Repeated same key returns the original confirmation; different revision under a new key after CONFIRMED returns 409 INVALID_STATE. Revisions/rematching create new records and retain original raw bytes/suggestions/corrections.

## Errors and dependency behavior

All target errors contain code, message, correlation_id, retryable; optional operation_id and bounded non-PII details {path,code}. HTTP status is authoritative; responses always echo X-Correlation-ID. Client key/schema errors are never retryable automatically.

| HTTP | Codes / behavior |
| --- | --- |
| 400 | INVALID_REQUEST, TENANT_CONTEXT_REQUIRED; invalid header/cursor/shape |
| 401 | UNAUTHENTICATED; missing/expired/invalid token; refresh then reconsider request |
| 403 | FORBIDDEN, SOD_VIOLATION; in-tenant permission/approval denial |
| 404 | NOT_FOUND; absent or foreign-tenant resource, identical public response |
| 409 | IDEMPOTENCY_CONFLICT, REVISION_CONFLICT, INVALID_STATE, FILE_NOT_CLEAN, PACK_DISABLED; fetch current state/review, never blind retry |
| 413/415 | FILE_TOO_LARGE / UNSUPPORTED_MEDIA_TYPE |
| 422 | CHECKSUM_MISMATCH, INVALID_DECIMAL, DRAFT_INVALID, SNAPSHOT_UNAVAILABLE; validation/source/schema failures |
| 429 | QUOTA_EXCEEDED; Retry-After seconds; retry only the same idempotency key when safe |
| 503 | DEPENDENCY_UNAVAILABLE, RECONCILIATION_REQUIRED; return operation_id if persisted; inspect status before redispatch |

| Dependency | Required behavior |
| --- | --- |
| PostgreSQL before durable intent | 503, no accepted success; same-key retry after recovery |
| Object storage failure | Keep registration and operation error; no lost reference or clean classification; reconcile partial bytes before retry |
| AV timeout/error/unconfigured | SCAN_FAILED or PENDING_SCAN with retryable operation; never CLEAN, OCR or download |
| AI timeout/429/quota/budget/malformed output | FAILED/PENDING operation with provenance; manual/deterministic path remains; never confirmed data or approval from failed AI |
| Flowable ambiguous dispatch | RECONCILIATION_REQUIRED, retain reservations, inspect engine history/operation before retry |
| Audit seal unavailable for sensitive action | No executed success until durable audit policy gate; pending or fail-closed under reviewed risk policy |

Workers use bounded retries (maximum 3 safe attempts with jittered 1/2/4-second backoff), honor Retry-After/budget, persist attempts/next_attempt_at and stop on authZ/schema/permanent errors. Actual provider timeout/cost limits and manual retry authorization are specified in #38/#41/#54. Correlation IDs cannot grant rights. Logs avoid raw bytes/secrets and contain tenant-safe IDs.

## Events and later contracts

EventEnvelope is generic, versioned and holds authorized references, not public tenant documents/secrets. Persist outbox alongside state; consumer dedups by tenant+consumer+event_id in its transaction. Delivery is at least once, not global ordering; revisions guard stale application. Reauthorize referenced reads with scoped service identity. Outbox payload retention/retry/cleanup is specified in #46/#57/#62. Events report an occurred fact and cannot act as permission-bypassing commands.

Workflow/decision/pack/replay shapes establish dependencies, not publish/upgrade/task execution completeness. Definitions, policy rules and facts are pinned by version/hash; sensitive authorization rechecks SoD. Replay uses frozen facts and policy B and may append a separate simulation audit record; it cannot change a business transaction, historical decision or dispatch tools. See CONTRACT_STATUS for open design work.
