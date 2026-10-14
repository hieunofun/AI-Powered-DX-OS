# Issue #22 adoption acceptance — 2026-10-15

Continuation on PR #69; issue remains OPEN. This matrix supersedes the implementation status in [initial qualification evidence](22-qualification.md), while retaining those real failed scans and Windows wire limitation. Base develop is `02b67484e2c177d215b38779988e206a008f402b`. No real project volumes have been migrated, no peer approval/merge has been performed by the agent, and no organizer acceptance is asserted.

## Observable acceptance and review gates

| Issue #22 acceptance | Implementation/evidence | Current gate |
| --- | --- | --- |
| Exact license/revisions and reasoned selection | ADR-003; Apache commit d5f425e, Go pseudo-version with sums; comparison with BUSL v1.11/other tags, Trillian and PostgreSQL-only option; inventory/notices | Implementation documented; independent peer decision pending |
| Actual server/client replacement with supported source builds | Source-built Apache upstream imported by OpenDX launcher; locked transport overrides; pinned Go 1.27.2; Linux Node 20 real wire test; new Compose volume epoch | Local build/tests and exact-HEAD CI must pass; Windows deployment excluded |
| Vulnerability remediation | gRPC v1.84.0, x/net v0.60.0, x/crypto v0.58.0, protobuf v1.36.11 and resolved pinned graph; required source/binary govulncheck v1.9.0 gates; actual imported-package guard excludes OpenPGP | Local source/binary scans pass with 0 affected calls/symbols; fresh Linux artifact scans required |
| Inclusion/consistency, tampering, retained/lost trust state and outage | Real native SDK tests, original receipt anchor checks, forged rows/proofs, UUID replacement, process failure/restart, privileged append with different transaction identity | Real local Apache-native tests pass; Linux exact-HEAD gates required |
| Preserve historical proofs/exports/receipts | Read-only PostgreSQL inventory/export; original frozen package/receipt values; offline native inclusion/consistency and SQL decoding against original anchors; live original ledger agreement; independently pinned manifest; original epoch routing | Real v1.11 server **and original v1.11 SDK verifier** qualification, actual PostgreSQL and project adapter tests required |
| Migration, isolated restore, rollback/forward recovery | Export interruption/idempotence/conflict rejection; archive restore; original data/trust directories restored to a separate old server; read-only volume backup/hash/new-volume restore helper; cutover runbook refuses rollback after new writes | Disposable drills required; operator's actual PostgreSQL/MinIO/Flowable/ledger/state restore record pending before real cutover |
| Auth, exact decimal, retry/replay and PR3 regression | Internal bearer auth/strict bounded input; no arbitrary SQL/path/pin; epoch/UUID checks; historical decimal strings remain exact; durable intents/stable-key insertion preserved; existing full stack/browser checks run against Apache | Local unit/Nest E2E/lint pass; full new-HEAD CI required |
| SBOM/licenses/documentation | Linked-module CycloneDX 1.5, module h1 checksums, binary SHA-256/build metadata/import inventory and original transitive notices in runtime images; inventory/policy/contribution/changelog/runbook updated | License review pending; Go SBOM scope does not claim a complete OS/Node SBOM |
| Peer review, merge and actual-SHA acceptance | PR #69 retains `Refs #22`; requested reviewers B/C; no self-review/merge | **Pending; CI green alone does not satisfy acceptance or close the issue** |

## Security interpretation

Official advisories explain the transport changes: [gRPC authority/Host panic](https://pkg.go.dev/vuln/GO-2026-6443), [gRPC fragmented DATA OOM](https://pkg.go.dev/vuln/GO-2026-6348), and [HTTP/2 HPACK race](https://pkg.go.dev/vuln/GO-2026-6617). gRPC v1.83.1 was still affected by the authority panic; the final graph uses the [official v1.84.0 release](https://github.com/grpc/grpc-go/releases/tag/v1.84.0). Exact locks and raw scanner output establish the tested graph, not a version-family assumption.

Local source scans of both modules and binary scans of both linked binaries returned exit 0 and zero affected symbols/calls. They still report module-only [GO-2026-5932](https://pkg.go.dev/vuln/GO-2026-5932) because x/crypto contains unmaintained OpenPGP. Neither binary imports that package; the provenance builder explicitly fails if it enters the imported package set. Nothing is suppressed. Scan output/date/toolchain/module inventories ship as CI provenance. Scans are point-in-time evidence, not a claim of perpetual security or upstream maintenance of the 2023 source.

The original source-root v0.0.0 binary scan incorrectly put ImmuDB below the v1.4.1 proof/UUID fixes. The adopted launcher imports the exact pinned d5f425e module, so build metadata identifies the real revision; it does not change/suppress scanner data. Its source contains the upstream fixes and native tamper/state tests must still pass. Earlier failed raw reports remain preserved.

## Historical trust and limits

An archive is not trusted because it carries its own hash: an independently retained manifest pin and PostgreSQL's original transaction/state anchors are required. Native proof primitives bind raw SQL values to the original transaction hash; fixed table column/PK identities prevent untrusted mappings from reassigning values. Native consistency binds the original receipt's state hash. Archived successful booleans are not the authority. The authenticated endpoint rechecks archive hashes/proofs and cannot use a newly copied active row after a history error.

Offline history proves the retained original receipt, not a later live state of the retired ledger. The original ledger/state backups remain available for recovery. Original receipts without server UUID cannot acquire a historical identity field retroactively; export records capture the observed live UUID separately. New receipts retain UUID and epoch. Loss of both original data and independent anchors is unrecoverable continuity, not a resealing opportunity. Native proofs do not establish legal signatures or external timestamps.

## Local checks before final CI

API build, lint and 456 original-plus-normalization unit tests passed; five new archive-routing cases passed in a targeted run. Existing 207 Nest E2E cases passed sequentially using existing doubles. Go unit/security/tagged compile checks and real native Apache proof/archived-receipt fault tests passed locally. The earlier Docker build encountered local host disk exhaustion; local evidence does not substitute for fresh complete Linux CI on the pushed SHA. Final run URLs/results are recorded in the PR and handoff report after completion.
