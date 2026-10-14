# Foundation validation evidence

Local worktree based on develop@32d8594102e649d8f3dc2196325c6827911bbd82, 2026-10-14 (Asia/Saigon). Local environment: Windows PowerShell, Node v24.16.0, npm 11.13.0. CI uses Node 20; its exact-SHA result is reported separately. Target routes are not implemented by this PR.

| Check | Observed result |
| --- | --- |
| npm run test:contracts | PASS: OpenAPI 3.0.3; 43 definitions, 23 operations, 32 positive + 13 negative fixtures, 32 embedded examples; references/permissions/idempotency/error coverage checked offline |
| npm run build | PASS: API tsc and web tsc/Vite build |
| npm run lint | PASS: API + web ESLint |
| npm run test:api | PASS: 28 suites, 454 tests |
| npm run test:e2e --workspace=apps/api | PASS: 8 suites, 207 tests; suite logs expected simulated DB failure, and Jest reported an existing worker teardown/open-handle warning |
| npm run test:web | PASS: 4 Playwright unit decimal tests |
| git diff --check | PASS before commit |

Nest E2E tests use their existing test doubles; they are not the real Docker-stack validators. Local real PostgreSQL/MinIO/Flowable/ledger/browser acceptance was not rerun for this documentation/contract change. The unchanged full-stack regression pipeline runs on the draft PR; report its actual URL/SHA/conclusion separately, never substitute baseline CI. Review/merge, PR4 runtime and AT-01..12 evidence remain pending.

Development validator license notices and lock integrity are recorded in OPEN_SOURCE_COMPONENTS.md. No previous locked package version changed; new validation packages are dev-only. No runtime/DDL/router modifications or PR3 test changes were made.
