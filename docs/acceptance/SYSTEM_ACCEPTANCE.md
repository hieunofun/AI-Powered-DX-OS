# System acceptance candidate (#66)

The candidate composes B-owned #63/#54/#25/#46/#26/#41/#38, #51 and #57 on `feat/66-release-acceptance`. Their independent source branches/PRs remain unmerged dependencies. #60/PR78 is a separate pinned headless-core/Onboarding composition and is not silently represented as one integrated production deployment here. A/C production tenant, workflow/decision/domain, UI, packaging and recovery contracts remain gates.

This work adds a native PostgreSQL hot/cold **component restore rehearsal**, exact row/hash/native-ID checks, a tiny-fixture latency/memory workload and a read-only acceptance audit. It does not claim completed AT-01..12, a production restore, a release, an upgrade or independent peer acceptance. The actual audit currently reports **0/12 integrated cases qualified, BLOCKED**. Closing issues or passing legacy/component CI is insufficient to change that status.

## Run the review candidate

```sh
npm ci
npm run build:api
node --test infra/acceptance/assess.test.cjs
node infra/acceptance/collect-github.cjs
node infra/acceptance/collect-github.cjs --require-release
docker compose -f infra/acceptance/compose.yaml up -d
node infra/acceptance/restore-rehearsal.cjs --isolated-rehearsal --wait-ready
docker compose -f infra/acceptance/compose.yaml stop
```

`--require-release` returns exit 2 while qualification is blocked. The read-only GitHub audit records current issue/PR states, inspected time, candidate SHA and tested Git commit. It uses an optional ephemeral Actions token only in request headers; no AI key is needed. It refuses truncated pagination. The BRS supplies all twelve scenario identities/hashes. A qualifying integrated result would require the exact candidate/scenario, current owner adapters, verified sources/native proofs and an independent approval on that candidate; the CLI currently supplies **no integrated results** because those adapters are absent. Fifteen reducer cases passed, including controls that reject component proof, old SHAs, self/old review, fixture authority, missing native proof and empty/duplicate/unknown scenario plans. The reducer's synthetic positive control is not actual system acceptance.

The native rehearsal starts explicitly named fixture source/restore containers and verifies their database identities. It appends three synthetic owner events through the actual #57 source/projector, including native sequences beginning at `9007199254740993` and the exact string amount `9007199254740993.00`. It awaits every controlled writer/job and closes the fixture HTTP host before the snapshots. There is no production worker-quiescence claim.

For each hot/cold database, the script creates a uniquely named **new empty** target, invokes real `pg_dump --format=custom --serializable-deferrable`, then `pg_restore --single-transaction --exit-on-error --no-owner --no-acl`. It refuses existing targets and unknown tables, never drops a database/volume and compares every native table's row count and canonical SQL JSON-text hash. Native BIGINT values are hashed as SQL text, without JavaScript Number conversion. It checks restored source IDs/sequences, snapshot payload hashes and append-only triggers, then explicitly reconstructs a fixture SELECT-only role and proves INSERT is denied even in a READ WRITE transaction. This post-restore fixture grant is not a claim that original production roles/ACLs were recovered.

Reports retain actual PostgreSQL/Node/platform/CPU/memory details, native dump hashes/sizes and per-table counts/hashes. Native dumps stay in ignored `tmp/issue66-{run}/`; the CI artifact retains both dumps and successful/failed JSON reports. Stop preserves all source/restore data. The read workload is 20 serial SQL scans over three cold snapshots; nearest-rank p95 and Node memory are explicitly scoped to that tiny fixture, not full application HTTP latency, container capacity or production sizing. Actual runtime execution is pending CI.

The first native rehearsal at `27267b9` failed readiness before source seeding or backup. Both containers were healthy, but the CI-resolved source container exposed no host port while the target correctly published 15466. The failed `issue66-restore-rehearsal-20261015191356280.json` and actual BLOCKED acceptance snapshot are retained. The leaf Compose service now explicitly publishes loopback port 15457 and `verify-compose.cjs` checks the resolved source/target database identities and both port mappings before startup. No timeout, existing volume or production database was changed.

## Acceptance status and owner routing

| Scenario | Existing component evidence / remaining gate |
| --- | --- |
| AT-01 tenant/resource isolation | B #46/#63 native SQL/bytes/worker probes; production A #43 composition and C #44 browser isolation absent |
| AT-02 concurrent capacity | Existing PR3 #34 regression is separate; new A #53/#62 domain/concurrency acceptance remains |
| AT-03 counted 95, missing 5 | Proposed ReceiptQuantities examples are not actual A #53 inventory/receiving runtime |
| AT-04 post-handover incident | A #53 incident/compensation workflow absent; no GRN rewrite or fabricated incident |
| AT-05 +10% price vs 5% policy | Legacy deterministic matching remains; new A #48/#53 versioned policy/domain acceptance remains |
| AT-06 OCR correction/provenance/rematch | B #26/#46 backend candidates have actual source/history evidence; C #44 and owning rematch integration remain |
| AT-07 policy replay A/B | A #56 and C #58 are required; no fake replay from a schema fixture |
| AT-08 injection cannot approve/export | B #54/#63 actual source/tool checks and fixed synthetic Gemini runs; owning decision/export/right composition remains |
| AT-09 dependency outage/recovery | B #51/#60 bounded durable intent/reconciliation probes; full A #45/#62/#65 outage/operational recovery remains |
| AT-10 Onboarding reuse | Separate PR78 has 16 actual Flowable/SQL/private bytes/RS256 groups and zero subsequent 42-file core diff; #59/#43/#50/#61 integrated production bindings remain |
| AT-11 fresh release and upgrade | Clean CI checkout/builds are regression evidence; A/C #64 release artifact and coordinated production migrations/upgrade acceptance remain |
| AT-12 restore and trust | New component hot/cold rehearsal is pending; original object bytes, native Flowable/ImmuDB/trust/identity recovery require A #65 |

Mandatory external/IT/OT ingress currently proves independent HTTP simulators, immutable native receipts, cumulative reconciliation and PENDING case intents (#51); it does not prove the absent owning #53 case→decision→export chain. Hot/cold projection (#57) has separate native DB/role evidence with synthetic owning source/authority ports. There is no assembled mandatory headless H-P-D-I runtime claim from these separate fixtures. Fresh fixtures and forward schema initialization do not prove upgrades of historical PR3 data. Backend model reservations/HTTP attempts are retained, but actual invoice billing/cost and a representative end-to-end workload are unverified. Keep these release gates and failed evidence visible.

## Attribution

No npm dependency or vendor patch is added. New orchestration, reducer, reports and synthetic workload are team-authored MIT. The rehearsal uses existing PostgreSQL 16/native backup tools and existing #57 integration with versions/licenses/notices retained in `OPEN_SOURCE_COMPONENTS.md`; [PostgreSQL 16 pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html) and [pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html) document the native tools. Existing model, database, storage, scanner, workflow and ledger engines remain upstream contributions; #22 eligibility and independent review are separate gates.
