# Headless core extraction evidence (#40)

Date: 2026-10-14 (Asia/Saigon). Base: freshly fetched `origin/develop@02b67484e2c177d215b38779988e206a008f402b`. Branch: `feat/40-headless-core`. Dependency #37 is accepted/closed after merged PR #67, peer approval and exact-HEAD CI. #22/#38 implementation code is not included.

## Observable change

- `PlatformModule` composes actual JWT verification/guards, PostgreSQL access and generic Flowable transport with no business modules/controllers/BPMN files. Public typed ports and concrete adapters live under `apps/api/src/platform/`.
- Existing auth/database/decorator/guard paths re-export the exact same tokens. `/auth/me`, existing role behavior and all compatibility APIs remain callable through their existing modules.
- The legacy Flowable adapter retains business process-key/definition/hash policy; inherited engine calls use generic core transport while applying the original pack config guard. Business workflow orchestration, reservations, financial calculations and historical snapshots remain outside platform.
- TypeScript AST/resolution checks reject core imports/re-exports/require/dynamic imports/import types into legacy/domain modules, unresolved/computed loading and business identifiers/literals. Workspace symlinks are resolved before external classification. The checker is static policy, not arbitrary-JavaScript sandboxing.

## Local validation

Windows, Node 24.16.0 / npm 11.13.0; CI uses Node 20. No new dependency or lockfile version change.

| Check | Result and limits |
| --- | --- |
| `npm ci`, `npm run build`, `npm run lint` | Passed |
| `npm run test:contracts` | Passed: 23 operations / 43 definitions, 32 positive + 13 negative fixtures and 32 embedded examples. No new runtime API acceptance inferred |
| `npm run test:boundaries` | Passed: 19 platform TypeScript files, zero business imports/vocabulary; 4 positive/negative checker tests |
| `npm run test:platform --workspace=apps/api` | Passed: 5 tests, including headless real-provider composition, identical legacy tokens, absent business modules, exact generic variables and read/refused/ambiguous transport outcomes. HTTP responses are explicit doubles |
| `npm run test:api` | Passed: 454 tests in 28 suites |
| `npm run test:e2e --workspace=apps/api -- --runInBand` | Passed: 207 tests in 8 suites. Nest auth/repository/engine boundaries include existing doubles; not real-stack proof |
| `npm run test:web` | Passed: 4 exact-decimal tests |
| `git diff --check` | Passed |

Initial simultaneous unit/parallel E2E runs exhausted the host's memory, causing file-read errors and timeouts. The full suites were rerun sequentially with bounded Node heap and unchanged assertions/timeouts; both then passed. This is an environment failure/recovery record, not a waived test or code regression disguised as a pass.

## CI and acceptance gates

The PR retains all original full-stack/browser steps and adds boundary/headless-composition checks. Actual Keycloak/APISIX/PostgreSQL/MinIO/Flowable/matching/audit/browser regression must pass on the PR's current HEAD; links/SHA are recorded in the issue/PR. No local complete real-stack rerun is claimed for this extraction. Peer review, merge and acceptance are still required before Done/closure.

No data migration, production deployment or new tenant/resource model is part of #40. #43 and #45 remain separate dependent issues; this extraction does not implement their tenant/task API acceptance, Onboarding or AT-01..12. See [ADR-004](adr/004-headless-core-extraction.md).
