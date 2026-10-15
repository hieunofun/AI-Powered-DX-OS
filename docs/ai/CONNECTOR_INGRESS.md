# External and IT/OT ingress — issue #51

Review candidate on `feat/51-cross-system-connectors`, composing pending #46 (and #38/#41/#26). The opt-in module is not enabled in the main AppModule. Production tenant/grant adapters (#43), the actual Case processor (#53), proposed contracts/migrations and independent review remain integration gates. No Case, decision, inventory change, payment or completed system acceptance is asserted.

## Independent source contracts

`POST /apps/openresolve/v1/connectors/external-orders/{sourceId}/events` accepts `openresolve.external-order.v1`. `POST /apps/openresolve/v1/connectors/receiving-sensors/{sourceId}/events` accepts `openresolve.receiving-sensor.v1`. Their strict schemas differ; the registered server-side source fixes tenant, principal, kind and the simulation flag. Source administration is not exposed. The request cannot supply tenant/actor/URL/local PO authority.

Composition requires a verified current identity resolver, `rawBody: true` or equivalent bounded raw capture, global `EvidenceErrorFilter`, source registry/current authority, authorized source-to-PO mapping, transactional Case target and lineage writer. Parsed JSON is never reconstructed as original evidence. JSON UTF-8 bodies are limited to 64 KiB. Invalid encoding, extra keys, unsafe sequences, invalid/future timestamps and unsupported family/schema fail before persistence. Historical/offline timestamps are preserved. Proposed JSON Schema is `packages/contracts/opendx/proposed/issue51-connectors.schema.json`; it does not change accepted v1 contracts.

Every accepted event stores exact original bytes, SHA-256, canonical content hash, source/native ID, schema, source time, receive time and correlation. A SQL transaction commits the immutable observation, raw receipt and original PENDING acknowledgement before returning 202. Same-key exact replay returns that acknowledgement; key reuse for another payload conflicts. Canonical reencoding deduplicates the logical observation while retaining each distinct raw receipt. A different canonical payload under the same native ID creates a separate conflicting observation linked to the original. Append-only triggers protect bytes, anchors and original metadata.

`GET /apps/openresolve/v1/connectors/observations/{id}` and the common operation reader apply current source/resource authorization. Lease/retry state is durable: two local worker slots, 120-second leases, three attempts, retained failure records and backoff. Stale workers cannot finalize another lease. Recreated workers reuse the same persisted witness ID. Production scheduling and workload identity are owner composition responsibilities.

## Processing and handoff

The worker rechecks its current rights and the original source's current grant. It losslessly encodes original JSON as base64 in a supported XML witness, labels trusted simulated sources in the filename, uploads/readbacks private bytes, and requires actual CLEAN scanner state and matching hashes before domain use. This codec preserves provenance; it does not certify source authenticity or make JSON a supported evidence media type.

The source-to-order mapping resolves an authorized tenant/source external key in the same transaction. Exact decimal comparison checks frozen supplier/currency/item/quantity/price/tax against the master. Receiving quantity is explicitly **cumulative**, never added into GRN/inventory. Final short count yields SHORT_DELIVERY; damaged quality yields QUALITY; unknown/reversed/contradictory events or changed master/order fields yield SOURCE_CONFLICT. Same sequence/value and non-final short counts do not duplicate cases. Conflicting readings do not become the next accepted baseline.

The mandatory Case target rechecks processor/source membership, mapping/PO version, and every CLEAN witness/hash/ACL inside the transaction. It persists shared `CaseRequest`/`EventEnvelope` shapes to an actual **PENDING case-intent outbox**. It does not create an A-owned Case. Outbox, immutable source/master/witness lineage and observation completion commit together; an exception rolls them back while preserving original bytes and reusable evidence. Native snapshots retain simulation/schema/time/hash; PO snapshots freeze the authorized version. The shared canonical raw-evidence snapshot avoids collisions with OCR lineage.

## Verification and reproduction

Unit/HTTP suites explicitly use SQL/storage/AV/identity/catalog doubles. Before publication, all 678 API unit tests (43 suites), 242 HTTP tests (11 suites), API build/lint and accepted contract validation passed. The HTTP count includes eight new actual Nest/raw-parser tests. These checks alone do not prove runtime service integration.

The isolated `opendx-issue51` Compose project binds only loopback ports 15451/19451/33151 and retains independent PostgreSQL/MinIO/ClamAV volumes. It applies only proposed SQL in that fixture; no numbered production migration or legacy backfill is supplied. Scanner startup updates definitions in the foreground; the runner requires engine 1.4.6, fresh definitions and a complete stream result. Unavailable/stale scanners cannot be bypassed.

```powershell
npm.cmd ci --no-audit --no-fund
npm.cmd run build:api
npm.cmd run test:api
npm.cmd run test:e2e --workspace=apps/api -- --runInBand
npm.cmd run lint:api
npm.cmd run test:contracts
docker compose -f infra/connectors/compose.yaml config --quiet
docker compose -f infra/connectors/compose.yaml up -d --build
node infra/connectors/validate-runtime.cjs --wait-ready
docker compose -f infra/connectors/compose.yaml stop
```

The separate `Connector ingress acceptance` CI job runs this actual-service procedure. Timestamped `docs/ai/evidence/issue51-ingress-runtime-*.json` artifacts retain failures, exact source/support hashes, native bytes and state exports, measured worker durations and environmental limitations. A successful check run must correspond to the reviewed SHA; no report is claimed until produced. Local Docker engine startup was unavailable during initial verification, so publishing the draft does not assert local runtime acceptance.

`simulate-external-orders.cjs` and `simulate-receiving-sensors.cjs` are independent clients making real loopback HTTP requests. Tokens come through environment only. They do not implement production ERP/PLC protocols, hardware connectivity, transport signatures or a digital twin. The fixture uses static server identities plus actual SQL memberships/source/processor/PO grants, not production SSO. Injected exceptions after actual SQL test atomic rollback/recreated-worker behavior, not process-kill or coordinated restore. No AI key or model call is used by this acceptance.

No new dependency is introduced. Existing component versions, notices and license gates remain in `OPEN_SOURCE_COMPONENTS.md`; new orchestration/SQL/contracts are team-authored.
