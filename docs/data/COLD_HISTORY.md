# Separate cold history — issue #57

Candidate `feat/57-data-lifecycle` composes pending #46/#26/#41/#38. The opt-in HistoryModule is not enabled in the main AppModule. Production #43 current authority, owning #50 committed Case/Event/snapshot source, proposed contracts/migrations, retention administration and independent review remain gates. No complete production source adapter, process-kill/restore or system acceptance is claimed.

## Copy and preserve

`HistoryProjector` consumes a mandatory owning `CommittedHistorySource` and writes a separate cold PostgreSQL database. It verifies actual hot/cold database names differ before reading a source page. Neither projection nor reporting mutates hot records. No purge/delete endpoint or numbered production migration is supplied. Original evidence remains in its owning private store; cold data retains its exact source version/hash references.

The source must establish allocation/commit order for each tenant stream, an immutable epoch and a **committed** through-watermark. `withCommittedPage` must include every committed item in `(after, scannedThrough]`, hold current archive-worker authority/immutable source context until the cold callback commits, and fail if it cannot authorize the whole scanned prefix. It cannot hide denied rows and then advance. Source IDs, timestamps, schemas, correlations, original JSON snapshot values and canonical hashes are preserved. Fractional financial values must be strings; BIGINT cursors remain strings. Timestamps use the closed UTC seconds/three-millisecond-digit profile. These detailed contracts require owner review; there is no fabricated #50 fallback.

One cold SQL transaction persists immutable native snapshots, source/evidence DERIVED_FROM edges, cursor and run. Native event replay deduplicates; changed same-ID data conflicts rather than replacing originals. Live and independent UUID backfill jobs have separate cursors; a backfill freezes its source epoch/through-watermark. New live events cannot expand that job. Exceptions roll back data and progress together; recreated workers resume from committed state.

All jobs in a tenant stream share a cold transaction lock, preserving allocation/commit order of an internal cold capture sequence. Queries freeze that committed **capture** watermark, so later backfills cannot appear inside an earlier traversal. The native source sequence remains separate. Latest-case selection orders the native BIGINT column numerically; event paging orders the cold BIGINT column. Neither internal sequence is disclosed in public DTOs/cursors.

## Current disclosure and metrics

Proposed GET routes `/platform/v1/history/{stream}/events` and `/cases` require a verified current identity resolver. There is no client SQL, projection, grant or purge API. Private SELECT-only reporting credentials are composed separately from the cold writer. Actual write-denial verification is part of runtime acceptance; HTTP read-only routes alone do not prove it.

Each disclosed row rechecks current membership, full historical resource/field permissions, evidence ACL and current retention. Authority outages fail closed. An expired legal hold preserves stored originals and grants no normal read; an explicit current expired-history/auditor permission is required. `captured_retention` is the original immutable snapshot policy, not the current permission decision. Nothing here deletes retained history.

AES-256-GCM cursors bind tenant/principal/stream/mode/limit, a closed capture watermark and 15-minute expiry. Revoked/denied/expired rows are omitted; an empty page may still have an opaque continuation. Source rights are current on every page, rather than frozen as a grant. Keys stay backend-only. Responses use no-store caching and shared Error DTOs.

Cases count only the latest source version of each authorized case visible **in this page**, with scope `AUTHORIZED_VISIBLE_PAGE`. Metrics include coarse owner-attested ACTIVE/COMPLETED/ERROR counts, case duration/error breakdown and explicit SIMULATED/ACTUAL/MIXED origin. They do not redefine owning Case states or represent whole-tenant totals. Duration totals use exact BIGINT decimal strings; p95 describes visible completed-case business durations, not HTTP latency. Repeated events are not counted as extra cases.

## Verification and reproduction

All 669 API units/43 suites, 241 HTTP tests/11 suites, API build/lint and accepted contract validation passed. The three new unit suites contribute 31 cases and seven actual Nest HTTP cases with labelled SQL/source/identity/ACL/retention doubles. They cover committed cursor order, dedup/backfill, hash conflicts, rollback, current ACL and expiry/holds, private cursor binding, closed page metrics and tenant isolation. Actual-service and exact-SHA CI results are recorded after their runs complete.

```powershell
npm.cmd ci --no-audit --no-fund
npm.cmd run build:api
npm.cmd run test:api
npm.cmd run test:e2e --workspace=apps/api -- --runInBand
npm.cmd run lint:api
npm.cmd run test:contracts
docker compose -f infra/history/compose.yaml up -d
node infra/history/validate-runtime.cjs --wait-ready
docker compose -f infra/history/compose.yaml stop
```

The isolated `opendx-issue57` PostgreSQL fixture binds only loopback 15457 and retains its volume. It creates distinct `history_hot_issue57` and `history_cold_issue57` databases plus an unprivileged SELECT-only reporting account. Its source/Case/Event/evidence-reference/identity/ACL/retention ports are explicitly SQL-backed **synthetic fixtures**, not production #43/#50 or original evidence bytes/AV/model/ledger integration. The privileged fixture writer prepares data; reporting SQL cannot write either database. A controlled bad authority TCP port tests actual connection failure. Fault injection occurs after real cold rows/cursor/run SQL, not a killed process.

The [actual Cold history acceptance run](https://github.com/hieunofun/AI-Powered-DX-OS/actions/runs/38778246910/job/116571388328) passed **14 groups** for published source `780cf2e`. The [retained report](../ai/evidence/issue57-history-runtime-20261015173334393.json) records clean CI merge checkout `fc148fa`, exact source/support hashes verified against the published tree, seven original source events, seven cold snapshots, fourteen lineage edges, two checkpoints and eight committed projection runs. It proves separate databases, actual SELECT-only role INSERT denials in both databases, frozen source/backfill/capture pages, native dedup, actual SQL rollback/recreated/concurrent workers, current ACL/hold/auditor/tenant isolation, actual unavailable authority TCP and immutable hashes/checkpoints. Measured fixture calls were 13–36 ms; they are not production latency evidence.

Timestamped reports retain successes/failures and exact provenance. The owning source/identity/evidence-reference fixtures remain synthetic as stated above; green runtime does not resolve production/review gates. No provider secret or model request is needed. Proposed SQL applies only to a separate cold database and does not rewrite hot history or erase volumes.

No new dependency or upstream patch is added. Existing PostgreSQL, pg, Node crypto, Nest and Ajv versions/notices remain in `OPEN_SOURCE_COMPONENTS.md`; project-authored work is projection, transaction/idempotency, authorization-aware reads and acceptance orchestration.
