# Authorized extractive explanations and actions — issue #54

Candidate branch `feat/54-ai-action-gateway` composes pending #46/#26/#41/#38. The module is opt-in and the main AppModule is unchanged. Production #43 authority, owning #50 policy/decision/action adapters, proposed API/schema/migrations and independent review remain integration gates. This candidate does not create a production Case/Decision, invoke a bank, or establish completed system acceptance.

## Grounding and disclosure

`MediationCaseSource` must resolve actual current tenant/case/resource grants, persisted confirmed facts, source version and CLEAN evidence/hash/retention under the caller's transaction. No permissive fallback exists. The worker separately reads and verifies actual private original bytes through EvidenceService for both the current requester and current processor. UUIDs, client fields and model content do not grant access. A changed snapshot fails instead of replacing an old request's source.

Gemini receives bounded question/fact text and temporary F1..F32 aliases. It may return only selected aliases and a registered tool suggestion. Tenant/case/fact/evidence IDs and authority are absent from the provider input structure. Confirmed values remain untrusted data: model output cannot add prose, citations, arbitrary tools, risk, approval or execution. The server renders exact selected fact values and source hash/version citations. Required missing codes come from the owner snapshot; no supported selected fact yields NO_SUPPORTED_ANSWER, and a missing required fact yields MISSING_EVIDENCE. This intentionally supports extractive explanations, not arbitrary financial conclusions or enterprise RAG. A frontend must render supplied text as text, never executable markup.

The backend disclosure policy permits fictional synthetic input or explicitly approved paid documents. The key stays in the ignored backend env. The replaceable Gemini adapter uses the existing request/token budget port, input counting, bounded response stream, strict finish/schema validation, deadline and safe errors. Local budgeting is per adapter instance; production distributed budgeting is an explicit composition requirement. Ambiguous requests do not refund reservations.

## Registered actions

| Tool | Risk | Arguments and behavior |
| --- | --- | --- |
| case.read_summary | R0 | Selected confirmed fact IDs; current read-only hash receipt; never invokes the side-effect executor |
| case.request_evidence | R1 | Only currently missing registered codes; independent owner-verified approval required |
| case.add_note | R2 | Only fact IDs cited in the explanation; note content must be rendered by the owning executor; independent approval required |
| Any transfer, unknown tool or R3 | R3/unknown | Always denied; no registered executor, URL, arbitrary code or SQL argument |

The sequence is explicit proposal → strict schema/source validation → current published policy → independent verified decision where required → current authorized transactional execution. A policy cannot downgrade registry risk or remove R1/R2 approval. `MediationApproval.verify` must inspect the actual decision, exact proposal/policy hashes, current approver rights, SoD and revocation in the same SQL transaction. Attaching a decision UUID does not create an approval. The proposer cannot approve their own action. Execution rechecks requester, executor, approver, decision, policy, snapshot and control epoch.

`MediationExecutor.executeInTransaction` is mandatory for R1/R2. It applies only the registered local command using the same SQL client and stable proposal ID. Its mutation, immutable receipt, history and idempotency result commit or roll back together. Nontransactional HTTP, external provisioning and payment are unsupported. Repeated/concurrent execution returns one committed receipt and produces no second mutation. No model callback invokes this port.

## Durability, controls and routes

The request and original PENDING acknowledgement are committed before 202/provider work. SQL stores the frozen authorized snapshot, question, requester, prompt/model/run/usage, original acknowledgement, bounded lease/failure history, proposal/policy hashes, verified approval and execution receipt. Append-only history/command tables and source/proposal/terminal-result triggers preserve records. Proposed SQL reserves no numbered migration and does not backfill legacy tenants.

The worker permits two local slots, 120-second leases and three persisted attempts. Backoff honors bounded provider Retry-After. A stale lease cannot finalize. A tenant control row must explicitly exist and be enabled. Mutating transactions lock the control epoch; a disable/re-enable invalidates old proposals. Checks run before/after provider calls and before finalization/execution. An in-flight hosted request may finish; output is withheld after a failed current check. Disabling does not erase authorized history or reverse a committed action. There is no public control-administration or fake approval endpoint.

All POSTs require JSON UTF-8 and Idempotency-Key. The verified context guard and safe shared Error DTO are reused. The bounded parser-error normalization also used by #51 preserves 413/415 responses.

| Method | Proposed route under `/apps/openresolve/v1/ai` | Result |
| --- | --- | --- |
| POST | `/cases/{id}/explanations` | 202 shared Operation |
| GET | `/explanations/{id}` | Authorized current-source explanation |
| POST | `/explanations/{id}/proposals` | 201 policy-validated proposal |
| GET | `/proposals/{id}` | Authorized proposal/receipt |
| POST | `/proposals/{id}/approval` | Verify and attach an actual owner decision |
| POST | `/proposals/{id}/execute` | Explicit current-authorized local execution |

The common operation-reader port composes with EvidenceService. `packages/contracts/opendx/proposed/issue54-mediation.schema.json` is proposed separately from accepted v1. Body/query IDs cannot select another tenant. Current snapshot drift can block reading an old explanation through this candidate endpoint; original history remains retained for owning historical-access integration.

## Evidence and reproduction

All 683 API unit tests (43 suites), 243 HTTP tests (11 suites), API build/lint and accepted contract validation passed. The new module/provider/validation contributes 45 unit cases and nine actual Nest HTTP cases with labelled SQL/evidence/identity/model/policy/decision doubles. The latest primitive-type checks were rerun in all three new unit suites and the HTTP suite. Exact-SHA CI and actual-service results are recorded after their runs complete.

The [latest actual Gemini report](evidence/issue54-explanation-evaluation-20261015140538842.json) records a fixed team-authored fictional corpus: exact relevant aliases dev **4/4**, held-out **4/4**; server missing-code equality **8/8**; sixteen HTTP attempts and 9,727 conservative reserved tokens. Gold labels were first opened after all outputs. The eight-sample p95 was 7,240 ms. Model calls are real; authorization/confirmed facts in this standalone relevance evaluation are explicit offline fixtures, and no action was executed. The [first run](evidence/issue54-explanation-evaluation-20261015135248771.json) is retained; rerunning the same four held-out cases does not add independent samples. This small corpus is not independent production accuracy or a provider bill. All source hashes and failures are retained; the live command is restricted to the hash-pinned synthetic manifest.

```powershell
npm.cmd ci --no-audit --no-fund
npm.cmd run build:api
npm.cmd run test:api
npm.cmd run test:e2e --workspace=apps/api -- --runInBand
npm.cmd run lint:api
npm.cmd run test:contracts
# Real hosted selection, synthetic allowlist only; never print/export the backend key.
node infra/mediation/evaluate-selection.cjs --live --env-file <ignored-backend-env-path>
# Separate real persistence/storage/scanner acceptance, no provider secret required.
docker compose -f infra/mediation/compose.yaml up -d --build
node infra/mediation/validate-runtime.cjs --wait-ready
docker compose -f infra/mediation/compose.yaml stop
```

The isolated `opendx-issue54` project uses loopback 15454/19454/33154 and independent retained volumes. The separate AI mediation acceptance workflow exercises actual PostgreSQL/MinIO/pinned fresh ClamAV/Nest. Its SQL membership/case/confirmed-fact/policy/decision/action adapters are explicitly **fixtures**, and its selection provider is an explicit deterministic double. Actual hosted selection is proven by the separate report above. Real fixture SQL rollback is not production #50 integration or process-kill recovery. Timestamped reports export immutable requests/proposals/history/action hashes and exact sources, including failures. Actual-service acceptance is pending its first published run; a workflow file is not a passing result.

No dependency or upstream fork is added. Existing exact versions/notices remain in `OPEN_SOURCE_COMPONENTS.md`. The team-authored work is mediation, strict extractive output, registered action boundary, durable SQL/history and acceptance orchestration; Gemini and the databases/scanner/frameworks remain upstream services.
