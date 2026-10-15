# Onboarding pack candidate (#60)

The separate `onboarding` pack records two evidenced acknowledgements and a fixed access request, then reuses generic identity, data, private evidence, lineage and Flowable APIs for an independent approval or rejection. Completion records a reviewed request; `provisioning_state` is always `NOT_PROVISIONED`. There is no account, permission, payment or token provisioning adapter.

This is an integration candidate. Pending PR71/#40 and #46 are composed explicitly. Production tenant authority #43, owner decision #50 and registered Capability Pack SDK #59 remain unresolved dependencies. The acceptance runtime provides **SQL-backed fixtures** for those three contracts and scripted distinct requester/reviewer/worker principals. These are not production adapters, independent human review, completed #59 integration or grounds to close the issue. No permissive registry/decision adapter is exported by the pack.

## HTTP contract

The host explicitly composes `OnboardingModule.register(service, verifiedContextResolver)`. It must supply the required current SDK, evidence and independent decision ports, transactional lineage and generic workflow engine. This module is not activated by the legacy main application. Tenant selection is checked against current membership; request bodies cannot set tenant, requester, roles, workflow, scopes or outcomes. All successful views use `Cache-Control: private, no-store` and existing error/correlation conventions.

| Method /packs/onboarding/v1 | Body | Result |
| --- | --- | --- |
| POST /cases | `display_label`, 1–160 characters | 201 case |
| GET /cases/{id} | none | 200 authorized case |
| POST /cases/{id}/checklist/{code} | `evidence_id`, `acknowledged: true`, `expected_revision` 0–9 | 200 case |
| POST /cases/{id}/access-requests | `access_profile` | 202 durable common operation |
| POST /cases/{id}/decisions | `decision_ref` pointing to an actual owner decision | 202 durable common operation |
| GET /operations/{id} | none | 200 operation after current case authorization |

POST requires `Idempotency-Key`. Unknown body/query fields are rejected. Checklist codes are `WELCOME_ACK` and `ACCESS_POLICY_ACK`; both require accepted CLEAN bytes with matching hashes and current requester/resource authority. Receipt revisions append, stop at ten and freeze on submission. Profiles are `DOCS_READ_ONLY` (`INTERNAL_DOCS_READ`) and `TEAM_WORKSPACE` (also `TEAM_WORKSPACE_VIEW`); these scopes describe the reviewed request only. The server freezes request/checklist/manifest/policy hashes. Decision input cannot claim an action or approval: the mandatory owner port supplies and revalidates the actual independent decision, version, subject/policy hashes and immutable snapshot.

## Workflow, recovery and history

The versioned manifest declares seven permissions, five published events and the exact workflow hash. A mandatory SDK binding checks registration, compatible core, enabled state, declared permissions and current tenant/resource grants in each SQL transaction. Versioned workflow and policy bindings cannot drift for an existing case. The tenant reviewer group and actual deployed definition ID are pinned server side.

The pack-owned PostgreSQL intent commits before each engine write. Two local worker slots, two-minute durable leases, three bounded safe attempts and read-only manual reconciliation prevent blind redispatch after ambiguous writes. Core `FlowableTransport` starts `onboarding_access_review_v1`; its single `access_review` user task has no service/provisioning tasks. The worker checks business key, definition, task/process binding and tenant candidate group. Actual current owner approval is checked before claiming/completing for its approver. Finalization requires actual ended process/task history, that approver and the matching **task-local** `applicationOperationId`. A timeout after successful start/claim/complete must be reconciled against native engine history before further writes. Current requester/worker/file/decision revocation withholds finalization even if the engine already ended.

Case history, idempotency responses, receipt/source snapshots and PENDING pack events commit in the same transaction as shared lineage. PostgreSQL guards immutable original identity, submitted facts, decision/process/task bindings and terminal records. Pending events have no owning #59 dispatcher consumption proof. Run the proposed SQL only against the explicitly named isolated fixture or after coordinated production migration review. Stop keeps volumes/history; do not remove them during recovery. Recover through `OnboardingWorker.reconcile()` under the separate current reconciliation permission; there is no public worker/reconcile endpoint and no unconditional retry/reset command.

## Verification and timing

```sh
npm ci
npm run build:api
npm run test:api
npm run test:e2e --workspace=apps/api -- --runInBand
npm run test:contracts
npm run test:boundaries
npm run test:platform --workspace=apps/api
node infra/onboarding/verify-core.cjs
docker compose -f infra/onboarding/compose.yaml up -d --build
node infra/onboarding/validate-runtime.cjs --wait-ready
docker compose -f infra/onboarding/compose.yaml stop
```

The generic pre-pack compatibility preparation is separately recorded in [ONBOARDING_CORE_BASE.md](../project4/ONBOARDING_CORE_BASE.md). Baseline `14e6e89530e390b2ee6882f1ec1843855a4f8583` pins all 42 platform files. Acceptance checks zero subsequent core diff/untracked additions, exact hashes and the unchanged owning boundary checker. `core-baseline.json` preserves the original preparation/pack start times; generation refuses to reset them. A reviewed manifest revision uses `prepare-pack.cjs --manifest-only`.

Local API/web build and lint, 676 unit cases, 241 HTTP cases (seven new), four web cases, accepted contracts, four boundary checks and five headless/transport cases passed. Proposed DTOs are in `packages/contracts/opendx/proposed/issue60-onboarding.schema.json`, separately from the accepted API; HTTP tests validate case/operation outputs against them. Actual isolated runtime is still being verified. Unit/HTTP doubles do not count as runtime acceptance. The runtime workflow retains successful and failed reports under `docs/ai/evidence/issue60-onboarding-runtime-*.json`, including actual commit, source hashes, native engine IDs, SQL counts and fixture labels. Its measured fixture integration time ends at the first actually completed case, starts before fixture binding/deployment and is separate from total pack implementation wall time. Actual owning #59 SDK integration time remains `null` until that dependency exists. Tiny synthetic timings do not establish production latency.

## Reuse and licenses

No new npm dependency is added. New pack TypeScript, SQL, BPMN, manifest and acceptance scripts are team-authored MIT. Existing Flowable OSS 8.0.0 is reused through the unchanged generic transport, with official Docker manifest pinned at `sha256:708dfa32f27b93180bb6e7a30684d881d995fe257f5b8413e14b20a55c25672d`; [upstream](https://github.com/flowable/flowable-engine/tree/flowable-8.0.0), Apache-2.0, existing dependency ledger/notices retained. Historic task-local variable behavior is documented by the [upstream REST API](https://www.flowable.com/open-source/docs/bpmn/ch14-REST). No Flowable source is copied or modified. Existing PostgreSQL 16, source-built pinned MinIO, ClamAV 1.4.6 and npm dependencies retain their existing revisions/licenses/notices; this pack changes no vendor implementation or eligibility conclusion in #22. ClamAV must load definitions no older than 24 hours; stale/unavailable scanning fails closed.
