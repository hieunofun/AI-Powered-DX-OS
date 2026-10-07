# Invoice, approval and audit workspace (Issue #24)

This workspace extends the procurement UI in PR #32. Its feature branch contains that unmerged foundation. PR #32 needs maintainer review before this dependent change is merged into `develop`; documentation synchronization remains PR #31.

## Running the application

Use the existing Compose setup, database migrations and configured demo realm. Bootstrap Flowable and the ledger using the repository's existing scripts before testing terminal invoice workflows:

```sh
docker compose up -d --build
docker compose exec -T smartprocure-api node infra/workflow/bootstrap-flowable.cjs
docker compose exec -T smartprocure-api node infra/audit/bootstrap-immudb.cjs
```

Open `http://localhost:9080` so frontend and authenticated APIs use the gateway origin. Default demo users are `accountant.demo`, `buyer.demo`, `warehouse.demo`, `finance.demo` and `admin.demo`; the imported development realm documents their demo password. Override development credentials for any external deployment.

## Business flow and boundaries

- Buyer/warehouse create and issue a PO, then finalize GRNs. Accountant/admin open **Invoices** or **Import invoice** on the PO detail. Search for an active PO and select one XML, PDF or both.
- Supported XML is the project SmartProcureInvoice v1 profile and the implemented Matbao/MIFI PBan 2.0.0 subset. Actual content and server-configured size limits are validated by the API. An `.xml` extension alone does not establish validity.
- PDF-only intake creates a persisted `OCR_REQUIRED` ingestion with `NOT_CONFIGURED`; it creates no invoice row. Failed intake links its persisted ingestion identifier where available. Reload that link to inspect the saved status before submitting corrected files. There is no general ingestion index in the current API; keep the returned link.
- Invoice detail exposes decimal-string amounts, original file hashes and the matching result. Start matching explicitly. Comparison rows display PO terms, accepted receipt quantities, previously matched consumption and invoice values from the saved match evidence. All discrepancy codes are visible; unknown codes remain visible with a fallback label. Policy/tolerance snapshots are preserved. This UI does not implement semantic AI.
- Start workflow explicitly after matching. Eligible clean invoices take STP; clean invoices above the configured STP cap require finance approval. Exception tasks follow persisted roles. **My tasks** returns at most 200 open/claimed tasks, as bounded by the existing API.
- Claim a task before completing it as a regular user. Another user's claim cannot be completed by that user. Admin overrides are labeled separately. This UI requires a nonblank reason for every decision, capped at 2,000 characters. `APPROVE_WITH_ADJUSTMENT` records a decision and explanation; it does not modify invoice amounts. Credit-note decisions are recorded, without sending a vendor message.
- `READY_FOR_PAYMENT` means clearance for the payment step. No bank transfer or CFO legal signature is implemented by this workspace.
- Accountants, finance managers and admins may inspect and verify audit packages and download JSON/PDF. Seal state is separate from current verification. Each verification/export reports `VERIFIED`, `TAMPERED`, `LEDGER_MISMATCH` or `UNAVAILABLE`; an unavailable result may intentionally use HTTP 503. Unknown, incomplete or contradictory verification replies are rejected. Export response headers identify that export's own status; JSON also must agree with it. A denied export is not downloaded.
- Each export runs verification anew. PDF attaches the JSON for that PDF's own timestamp. PDF bytes themselves are not ledger-anchored and the reports have no legal digital signature. The ImmuDB eligibility decision remains Issue #22.
- Admin can request seal recovery on eligible terminal invoices. Failed/ambiguous workflow operations require inspecting persisted state and the existing operator recovery tools; the UI does not automatically retry a financial decision.

## Acceptance checks

```sh
npm ci
npm run build
npm run lint
npm test
npm run test:e2e --workspace=apps/api
npx playwright install --with-deps chromium
node infra/web/bootstrap-web-fixtures.cjs
npm run test:browser --workspace=apps/web
```

Fixture bootstrap and the controlled corruption scenario reject `NODE_ENV=production`. Configure fixture `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER` and `POSTGRES_PASSWORD` to match the development database. Non-default browser/identity origins use `WEB_BASE_URL`, `GATEWAY_BASE_URL` and `TEST_KEYCLOAK_URL`. `PLAYWRIGHT_CHANNEL=chrome` permits using an installed Chrome locally; CI installs Playwright Chromium.

The six added browser scenarios use real SSO, APISIX, PostgreSQL, MinIO, Flowable and native ledger proof verification:

1. XML persists, matches, starts clean STP, survives reload and exports verified JSON/PDF; responsive audit widths are checked.
2. A price exception is claimed and approved with explanation by a real buyer session; the original invoice amount remains unchanged.
3. Missing accepted receipts route to warehouse; a credit-note request stays in invoice `EXCEPTION` and the final package can be verified.
4. PDF remains OCR-required; malformed XML and duplicate invoice numbers leave inspectable failed ingestion evidence.
5. Actual role/missing-token failures are checked. Unavailable ledger responses, contradictory verification and denied exports are additionally injected at read endpoints to test presentation; these injections do not prove a physical outage.
6. Only each test's own `WEB24-*` synthetic fixture has source file-hash metadata and a ledger-receipt hash deliberately changed. The actual verifier exposes tampering/mismatch. Both values are restored in `finally`, and verification must pass again. No historical ledger entries or audit packages are deleted or rewritten.

The APISIX policy allows 100 requests per 60 seconds per source IP. Each added financial scenario waits for its own fresh quota window; retries are disabled. A complete browser run takes several minutes. Runs retain synthetic business/audit records rather than resetting the database. Browser traces/auth storage are not saved. Screenshots and downloads stay in ignored Playwright output.

Backend HTTP tests mock orchestration/auth, while the browser lifecycle tests exercise actual services. CI also retains the existing complete backend, Flowable and ledger acceptance validators. Check the PR's exact head/run before reporting that verification passed.

## UI guidance

The existing procurement visual tokens and controls are reused. The `ui-ux-pro-max` error-recovery/inline-error guidance fits this web application. React-specific searches returned React 19/server guidance, which did not fit React 18; the implementation uses the existing cancellable-resource hook and general async-error guidance instead. No unverified design system output is persisted.

## Remaining limitations

PO optimistic versioning is retained; GRN drafts still lack backend version protection. OCR, AI semantic matching, PKI signatures, external tax-risk data, vendor messaging and bank execution remain separate issues. Hash-route draft guards warn on workspace links/reload/closing, with the same browser-back limitation as PR #32. Supplier maintenance and policy editing are outside this UI issue.
