# ADR-004 — Extract working infrastructure behind compatible headless ports

Date: 2026-10-14 (Asia/Saigon). Status: proposed implementation in #40.

## Accepted foundation and scope

Use ADR-001/002 from merged PR #67, verified on freshly fetched develop `02b67484e2c177d215b38779988e206a008f402b`. #37's foundation acceptance is verified and closed. #40 is independent of the unmerged #22 qualification and #38 provider PRs. No code from either is included here.

## Decision

Extract existing JWT identity verification/guards/decorators, PostgreSQL access and generic Flowable transport into `apps/api/src/platform/`. Export a `PlatformModule` that can be composed as a headless Nest application context without business modules or the web application. These are working adapters and public TypeScript ports, not new public HTTP APIs.

Legacy auth/database paths re-export the same classes/interfaces/decorators. Their wrapper modules re-export the platform modules while preserving `/auth/me`, global providers and dependency-injection token identity. Existing pack/domain services continue using those paths during the incremental migration; do not rename routes or tables.

Generic Flowable transport retains bounded requests, exact string/boolean variables, history/tasks, claim/complete and ambiguous-outcome classification. It has no business process key, role/stage enum, BPMN file path or domain policy. The legacy Flowable adapter subclasses the transport and keeps the verified business definition/hash/process-key guard. Business workflow orchestration, matching, reservations, frozen history and financial rules remain in their existing modules. The adapter's config override applies the existing process-key guard to inherited calls too.

The core exports identity and data interfaces alongside concrete adapters. Existing environment variable names and compatibility defaults are preserved. Core composition does not grant new rights, fabricate tenant context or bypass gateway/backend verification. Tenant/membership/resource authorization and backfill remain #43; generic versioned workflow/task HTTP APIs and durable semantics remain #45. Reusable infrastructure alone does not satisfy those later issues.

## Executable boundary

Check all platform TypeScript imports/re-exports/require/dynamic import/import types using the existing TypeScript parser/resolver. Resolve project-local targets; allow platform and explicitly neutral shared primitives/contracts. Reject domain/pack/legacy imports, unresolved local imports, computed module loading and business vocabulary in identifiers/string literals. The composition root outside platform may wire packs. Check positive/negative checker fixtures and run it in CI without removing existing checks.

This is a static import/vocabulary boundary, not a claim to sandbox arbitrary JavaScript or validate transitive third-party supply chains. Avoid new runtime dependencies or a plugin framework. Onboarding/evidence/policy/decision ports are implemented only in their scoped issues.

## Compatibility and validation

No data migration, storage change or production deployment is required. Re-export identity is verified; headless composition compiles without PO/receipt/financial workflow modules. Transport tests use explicitly simulated responses to check generic behavior and failure classification. Existing unit/Nest E2E tests remain, and preserved full CI exercises actual Keycloak/APISIX/PostgreSQL/Flowable/matching/audit/browser flows on the PR's actual HEAD. Those real checks are required before merge/acceptance. No independent peer approval is fabricated; request B/C review.
