# Gemini extraction adapter — issue #38

Local implementation candidate on `feat/38-ai-provider-contract`, based on `develop@32d8594`. PR #67/#37 was not merged when this work began; integration remains blocked. Rebase onto the newly fetched develop and check contracts again after merge. This change does not close #38 or implement the #26 OCR persistence/review API.

## Boundary and resulting behavior

`apps/api/src/ai/extraction` provides a generic server-only `ExtractionProvider`, the Nest injection token `AI_EXTRACTION_PROVIDER`, a disabled implementation and the Gemini adapter. `AiExtractionModule` exports the provider and can be overridden in tests or replaced by another backend adapter. The module is intentionally not imported by `AppModule` or `InvoicesModule`: existing XML ingestion and PDF `OCR_REQUIRED` behavior continue until an authorized CLEAN-evidence worker and durable drafts are available in #41/#26.

The caller selects fields from a registered pack schema; arbitrary public field definitions are not accepted as a future API. The adapter sends bytes and field descriptions, without tenant IDs, actor metadata, storage URLs or API keys in the JSON body. PDF/PNG/JPEG signatures and 20 MiB limits are checked; `text/plain` is an internal synthetic-evaluation input, not an additional public upload type. A future worker must verify effective tenant, resource ACL, source revision/hash, CLEAN state and schema/pack permission immediately before dispatch. The adapter alone cannot establish tenant isolation or perform antivirus scanning.

Gemini's response is independently validated: every requested field appears once; unknown paths/properties, duplicate paths, numeric decimals, invalid dates/currencies, invented values for MISSING, invalid confidence, tools, non-JSON/truncated/oversized output are rejected. Suggested values remain strings. All source locations are UNKNOWN/PROVIDER_NO_LOCATION; no bbox/page is fabricated. Success is always REVIEW_REQUIRED with provider/model/prompt/run provenance. It never approves, persists a verified invoice, calculates a financial verdict or performs a tool action. Pack-specific precision/totals/supplier validation and immutable correction/confirmation remain #26.

## Configuration and failure policy

Set backend environment variables from `.env.example`; never put a Gemini key into frontend/VITE variables or commit `.env`.

| Setting | Default | Meaning |
| --- | --- | --- |
| AI_PROVIDER | disabled | Explicitly select gemini for the adapter/evaluation |
| GEMINI_API_KEY | empty | Backend-only key; required when enabled |
| GEMINI_MODEL | gemini-3.8-flash | Selected model identifier; record returned modelVersion |
| AI_DOCUMENT_POLICY | synthetic-only | Real data additionally requires approved-paid configuration and server-approved classification |
| AI_TIMEOUT_MS | 30000 | One deadline covering counting, generation and response reading; maximum 120000 |
| AI_REQUESTS_PER_MINUTE / DAY | 20 / 100 | Count every outbound HTTP RPC, including countTokens |
| AI_MAX_INPUT_TOKENS | 8192 | Reject oversized prompts before generation |
| AI_MAX_OUTPUT_TOKENS | 4096 | Provider generation cap |
| AI_TOKENS_PER_DAY | 100000 | Reserve counted input plus the full output cap before generation |

`countTokens` receives the same input/system instruction/schema as generation. A reservation is never refunded on timeout, malformed output or an ambiguous provider result. The quota implementation uses UTC fixed windows **per adapter instance** and resets on process restart; it is not a distributed or durable spending limit and does not enforce a USD invoice cap. Deploy only one evaluation worker with these local limits. A multi-worker production integration must replace `ProviderBudget` with an atomic shared store, validate counting/billing assumptions and configure provider-project billing limits. No price is hard-coded.

Transport has a fixed Google HTTPS origin, rejects redirects, bounds each response envelope to 1 MiB and never logs raw documents/provider bodies/keys. Provider errors expose only a bounded internal failure code, retryability, optional Retry-After and a run ID. 429 honors Retry-After; 5xx/network/timeout are retryable; invalid input/output, rejected credentials and exhausted budget are not automatically retried. **There is no adapter retry**: #41 workers must persist provenance/attempts and enforce reviewed retries after inspecting ambiguous outcomes. Public HTTP error mapping belongs to the future worker/API.

## Evaluation corpus and commands

`infra/ai/datasets/vn-synthetic-v1` contains eight entirely fictional Vietnamese text PDFs and readable text sources, 4 development and 4 held-out documents. Nine fields per case cover diacritics, decimal strings, fractional quantities, zero VAT, absent required data, different currency, values above JavaScript's safe integer range and a document-injection sample. These are digital PDFs, not scanned-document OCR evidence. Font notices remain in `infra/audit/fonts/OFL.txt`. Gold labels are stored separately and are never included in provider requests. Held-out documents must not be used for prompt tuning; this small public synthetic corpus cannot establish production quality or prompt-injection resistance.

From the repository root:

```powershell
npm.cmd ci
node infra/ai/validate-dataset.cjs
npm.cmd run test --workspace=apps/api -- --runTestsByPath src/ai/extraction/gemini-extraction.provider.spec.ts src/ai/extraction/evaluation.spec.ts src/ai/extraction/dataset.spec.ts
# Optional reproducible source generation; revalidate hashes after regeneration.
node infra/ai/create-synthetic-dataset.cjs
```

Offline predictions must have `{dataset_version:"vn-synthetic-v1",split:"held-out",predictions:[{id,fields}|{id,error}]}`. Evaluate actual captured outputs, or explicitly labeled test predictions:

```powershell
node infra/ai/evaluate.cjs --split=held-out --predictions=path/to/predictions.json --out=path/to/report.json
```

For an explicitly authorized live run on these synthetic PDFs only, set AI_PROVIDER=gemini and GEMINI_API_KEY in your ignored `.env`; review model access/quotas/billing first:

```powershell
node --env-file=.env infra/ai/evaluate.cjs --split=dev --live --out=dev-report.json
# Freeze prompt/config before using the held-out split.
node --env-file=.env infra/ai/evaluate.cjs --split=held-out --live --out=heldout-report.json
```

Every selected case contributes to the denominator, including failed or omitted predictions. Reports show total and per-field correct/total counts, exact status/string accuracy, complete cases, failure count and provenance. Equivalent differently padded decimals are not silently normalized. Confidence is provider-reported and uncalibrated; evaluation never treats it as a calibrated probability. Offline scores are labeled OFFLINE_PREDICTIONS and cannot be reported as live provider quality.

## Observed validation on 2026-10-14

After the owner supplied a backend key, one live run was made for each split with the same `generic-fields-v1` prompt and `gemini-3.8-flash` model. Development: 4/4 complete cases, 36/36 fields correct, 0 failed cases. Held-out: 4/4 complete cases, 36/36 fields correct, 0 failed cases. Each of the nine fields scored 4/4 in each split. Raw synthetic predictions, provider run IDs, source/prompt hashes and token reservations are in [development evidence](evidence/vn-synthetic-v1-dev-live.json) and [held-out evidence](evidence/vn-synthetic-v1-heldout-live.json). These small digital-PDF results do not establish scanned-document or production accuracy; confidence calibration was not evaluated.

Local checks passed: API+web build, API+web lint, 486 API unit tests across 31 suites (32 new tests), 207 Nest E2E tests across 8 suites, 4 web decimal unit tests, dataset integrity and `git diff --check`. Nest E2E uses existing dependency doubles and is separate from Docker-stack acceptance. No fresh Docker/browser-stack regression or remote CI was run for this branch. Node v24.14.0 was used; CI still needs to verify Node 20 on the integrated commit.

Local HTTP integration tests use an explicitly labeled fake Gemini server and validate dispatch/credentials/response behavior. Scanned-PDF quality, domain confirmation, worker authorization/quarantine, distributed budgeting and latest-contract CI/peer review remain integration gates. The supplied key stays in the ignored local `.env`, outside the commit and frontend build.

Official sources: [generation](https://ai.google.dev/api/generate-content), [counting](https://ai.google.dev/api/tokens), [models](https://ai.google.dev/gemini-api/docs/models), [pricing](https://ai.google.dev/gemini-api/docs/pricing), [terms](https://ai.google.dev/gemini-api/terms). Free-service data may be used to improve Google's products; paid-service processing follows the applicable service/data-processing terms. The default synthetic-only policy avoids submitting business documents before disclosure review.
