# Procurement workspace acceptance (Issue #23)

The browser workspace replaces the authentication diagnostics landing page with operational PO and GRN lists, detail views and draft forms. Diagnostics remain at `#/diagnostics` for administrators. The invoice/matching/task UI is a separate Issue #24 deliverable.

## Run

Use the repository Docker Compose stack and open **http://localhost:9080**. Port 3000 in Docker serves static Nginx assets and does not proxy `/api`; the APISIX origin is required. During frontend development, Vite on port 3000 proxies `/api` to APISIX on port 9080.

```sh
npm ci
npm run build
npm run lint
npm run test
npm run test:e2e --workspace=apps/api
docker compose up -d --build
npx playwright install chromium
node infra/web/bootstrap-web-fixtures.cjs
npm run test:browser --workspace=apps/web
```

Wait for the Compose services to become healthy before running browser tests. Fixture bootstrap runs on the host using the standard PostgreSQL environment variables; if `.env` overrides database credentials, export the same values into the host process. Fixtures add two clearly identified synthetic `WEB-E2E-*` suppliers and keep existing rows. They are development/CI data with intentionally synthetic tax identifiers, not supplier/tax verification evidence. Tests create their own PO/GRN records through the real API and preserve audit history. Run against a development database.

APISIX protected routes use a shared 100-requests/60-seconds quota per source IP. If other integration validators just ran, let that window expire before browser acceptance. CI waits one existing window after the earlier validators; it does not alter the gateway policy. This avoids attributing a prior suite's HTTP 429 to a failed browser persistence assertion.

`WEB_BASE_URL` defaults to `http://localhost:9080`; `GATEWAY_BASE_URL` defaults to the same origin. `TEST_KEYCLOAK_URL` defaults to `http://localhost:8080`. `TEST_DEMO_PASSWORD` defaults to the checked-in development realm's demo password. For an already installed Chrome, set `PLAYWRIGHT_CHANNEL=chrome`. CI installs Chromium instead. No API token or SSO storage state is saved to disk. Traces are disabled; browser screenshots/results are Git-ignored and not uploaded automatically.

## Coverage and limits

| Scenario | Evidence |
| --- | --- |
| Buyer creates and edits a PO; reload preserves it; issue locks content; cancellation retains reason | Browser actions, persisted API snapshot |
| Fractional prices remain strings, including the fourth decimal place | Actual browser POST payload and server-computed rendered total |
| Clear optional delivery date | Browser edit and persisted API `null` |
| Warehouse cannot edit PO; can create, edit and finalize GRN | Separate real SSO session and actual API writes |
| Rejected goods require a reason; over-delivery is blocked | Form validation and actual receive endpoint failure |
| Partial then full receipt; cancelling a finalized receipt reverses fulfillment | Real GRN transitions and cumulative PostgreSQL-backed API response |
| Stale PO draft returns 409 without overwriting pending input | Concurrent real API edit followed by browser submission |
| Accountant read-only; invalid pagination rejected; missing token rejected | Real SSO, API 403/400/401 responses |
| 401/403 presentation and retry | Explicitly injected failed **read** responses; lifecycle tests use real services |
| No page overflow at 375/768/1024/1440px and landscape; error-summary focus; dialog Escape restores focus | Browser assertions and local screenshots |

The UI does not execute payment or validate vendor tax status. Amounts and quantities stay as strings; quantity comparisons/subtraction use four-place `bigint` arithmetic. Financial totals are calculated and rounded to two places by the existing backend calculator, while unit prices retain up to four places. A remaining quantity below zero explicitly indicates over-delivery.

PO writes use the API's `expectedVersion`. Existing GRN APIs lock transitions but do **not** expose a draft version; simultaneous GRN draft edits can still overwrite each other. This UI cannot claim optimistic locking for GRN drafts. Reload/closing and workspace links warn on changed drafts; browser Back does not provide a draft-history guarantee. New supplier maintenance remains outside this issue: the UI searches an existing active supplier catalog, with blocked/inactive suppliers disabled.

The design-system search did not produce a verified operational dashboard layout. The implementation uses general enterprise guidance: semantic blue/neutral tokens, readable tables, system fonts, keyboard focus, labeled inputs and reduced motion. No generated landing-page template or unverified search output was persisted.
