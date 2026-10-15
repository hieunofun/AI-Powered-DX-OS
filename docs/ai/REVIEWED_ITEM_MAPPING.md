# Reviewed item mapping — issue #25

Status: implementation candidate on `feat/25-semantic-suggestions`, composing pending #38/#41/#26/#46. Public route/schema additions are proposed for A/C review. Production #43 catalog/tenant authority, actual matching handoff and independent review remain gates. This document does not close #25.

## Rules

- Load only immutable confirmed invoice facts and the currently authorized tenant/PO catalog. No global candidate lookup. Reject foreign tenant/PO items, duplicate IDs, stale facts/catalog, unknown paths and oversized inputs before model dispatch. Profile supports 40 candidates; it never silently truncates a catalog.
- Preserve the existing deterministic resolver for exact SKU/description. Duplicate identities remain ambiguous; a model cannot break an exact duplicate tie. The resolver's type now accepts identity-only data without fabricated quantity/price fields; its runtime algorithm is unchanged.
- Semantic inference uses a separate disclosed Gemini prompt, not the OCR verbatim-extraction prompt. Only item descriptions/SKUs and allowed candidate IDs are sent. No tenant/PO/confirmation identifiers, quantities, prices, tax or payment facts enter model content. Strict schema, closed candidate set, full deadline, bounded response and conservative request/token reservations apply.
- Every suggestion, including a confident unique alias, remains REVIEW_REQUIRED. UNKNOWN/ambiguity/error never auto-matches. Timeout/quota/invalid output retains an explicit deterministic fallback and failure code. Authority failures block rather than becoming a successful fallback. Model confidence is uncalibrated.
- Requests/worker leases, original suggestion/catalog snapshot and server actor decisions are durable. Human selection may choose a currently authorized original-catalog item with a reason; record SUGGESTION/MANUAL origin. Explicit null selection records REJECTED with no outbox. Same command returns the original response; stale/new decisions cannot overwrite history.
- Recheck CLEAN actual bytes, current membership/resource grants, source/facts/catalog hashes and tenant/PO/item ownership. The outbox target requires an explicit authorization port inside the transaction; production must lock the PO/catalog consistently with catalog writers. Decision/outbox/idempotency update is atomic. PENDING is a durable handoff, not a matched invoice or approval. Existing match results and financial rules are never rewritten here.

## Proposed HTTP contract

| Method/path under `/apps/openresolve/v1` | Result |
| --- | --- |
| POST `verified-invoices/{confirmation_id}/item-mapping-suggestions` | Body `line_path`; 202 shared durable Operation |
| GET `item-mapping-suggestions/{id}` | Authorized operation, review suggestion and immutable decision if present |
| POST `item-mapping-suggestions/{id}/confirmations` | `expected_revision`, `selected_po_item_id` (UUID or explicit null), `reason`; 202 recorded decision/PENDING or NONE |

`verified-invoices` uses #26's immutable verified payload ref ID (the confirmation ID), not a legacy invoice ID. Commands require Idempotency-Key; identity comes from the mandatory server context resolver. The existing shared Operation reader can compose the mapping operation reader. Main AppModule remains opt-in. The separate review schema is `packages/contracts/opendx/proposed/issue25-mapping.schema.json`; it does not imply acceptance into the reviewed v1 OpenAPI.

## Evaluation

`infra/mapping/fixtures/vn-mapping-synthetic-v1` contains ten fictional item identities: four dev/six held-out, explicitly supplied catalog aliases, exact SKU, duplicate identities, unrelated input, ambiguous variants and prompt injection. Labels are separate and opened after actual model work. Deterministic and model paths have separate denominators; exact resolution+candidate-set and unique-MATCH precision are reported. This small corpus cannot establish production accuracy or calibrated confidence. Do not overwrite v1 or tune on held-out examples; publish failures and create a new independent dataset for later evaluation.

```powershell
npm.cmd run build:api
node infra/mapping/evaluate.cjs --live --env-file <ignored-server-env-path>
node infra/mapping/validate-reports.cjs
docker compose -f infra/mapping/compose.yaml config --quiet
docker compose -f infra/mapping/compose.yaml up -d
# Wait for actual scanner freshness/readiness; signatures are never bypassed.
node infra/mapping/validate-runtime.cjs --live --env-file <ignored-server-env-path>
npm.cmd run test --workspace=apps/api -- mapping matching/domain
npm.cmd run lint:api
docker compose -f infra/mapping/compose.yaml stop
```

The [actual model evaluation](evidence/issue25-mapping-evaluation-20261014230619864.json) reports dev exact 4/4 and held-out exact 6/6. Dev includes two deterministic and two Gemini paths; all six held-out cases use Gemini. Unique-MATCH precision is dev 2/2 and held-out 3/3; UNKNOWN/AMBIGUOUS outcomes are included in exact resolution+candidate-set denominators. Eight actual Gemini cases made 16 HTTP attempts, reserved 35,591 tokens and had nearest-rank p95 5,955 ms. No provider failure occurred. Aliases are explicitly supplied in this synthetic catalog; this is a small closed candidate task, not production accuracy. Token reservations/reported totals are not a billing statement.

The [final runtime report](evidence/issue25-mapping-runtime-20261014231153050.json) records nine passing groups on real PostgreSQL/MinIO/ClamAV: confirmed immutable facts, tenant/PO-predicated catalog, no dispatch before human review, foreign IDs/actor injection, actual decision+outbox rollback after an injected finalization error, stale catalog rejection, same-key replay, immutable decisions, independent transactional target denial and revoked SQL membership before further worker dispatch. Runtime source uses an exact-SKU deterministic path; real Gemini mapping is the separate evaluation above. Upstream OCR is explicitly a labelled bootstrap double; actual OCR is separately measured in #26. Identity is a static server resolver plus real SQL membership checks, not production Keycloak. PENDING outbox is not executed matching or payment. Both timestamped runtime runs are retained.

Local regression passed 670 API unit tests/43 suites, 242 HTTP E2E tests/11 suites (eight new schema-checked mapping HTTP cases), API build/lint and the existing 43-definition/23-operation contract validator. The proposed mapping schema is separately exercised against HTTP and recorded real-model results; it is not automatically approved by the existing v1 validator. The fixture uses independent project `opendx-issue25`, loopback ports 15425/19425/33125 and persistent volumes. Compose supports `!override`; stopping preserves data.

No new dependency is added. Gemini provider/model/terms, Node/Nest/PostgreSQL/JWT/PDF/AV notices remain in the existing inventories. Keys stay in the ignored backend environment. CI on the published SHA, peer review, A/C contract acceptance, production #43 authority/catalog writer locks, real matching adapter and legacy/system acceptance remain gates.
