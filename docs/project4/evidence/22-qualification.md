# Issue #22 qualification evidence — 2026-10-14 (Asia/Saigon)

Base: freshly fetched develop `02b67484e2c177d215b38779988e206a008f402b` (merged PR #67). Branch: `feat/22-ledger-license`. This is a partial qualification delivery; #22 acceptance is **not achieved**.

## Exact source and environment

- Official Apache tag `v1.9DOM.1`, commit `d5f425e46b4bfd0771274cb4c2ea77634421600c`.
- SDK module `v1.9.0-RC2.0.20231116103301-d5f425e46b4b`, checksum `h1:4utBi+dQruaWAsAPqLR8OhAFFX69EvN7VYOfKwT9FA0=`; separate candidate module files.
- Windows native source build: official checksum-verified Go 1.27.2, Node 24.16.0 / npm 11.13.0. Docker qualification uses pinned Go 1.27.2 and Node 20 images; full build metadata/module inventories/notices are emitted in `/provenance/`.
- Source was cloned at the exact commit and built with `go build -mod=readonly -trimpath ./cmd/immudb`. No upstream source modification, existing volume mount or historical receipt edit.

## Actual verification

| Check | Result and limits |
| --- | --- |
| `npm ci`, `npm run build`, subsequent `npm run build:api` | Passed; latest adapter compiled |
| `npm run lint`, subsequent `npm run lint:api` | Passed |
| `npm run test:contracts` | Passed: 23 operations, 43 definitions, 32 positive / 13 negative fixtures and 32 embedded examples; no runtime API claim |
| Existing audit unit suites | Passed: 59 tests; repository/ledger boundaries include doubles |
| New column identity unit tests | Passed: 2 tests; bare/qualified labels retain exact values and foreign/duplicate/missing/unknown identities fail |
| Production Go module `go test -mod=readonly ./...` | Passed against the retained BUSL v1.11.0 SDK |
| Candidate native proof/trust/tamper/recovery tests | Passed on real source-built Windows server; SDK file-cache test also passed |
| Actual project Node `pg` candidate gate | **Failed**: qualified column labels required explicit normalization; after that fix, parameterized INSERT returned `Query read timeout`. Gate retained with no disabled assertion or `continue-on-error` |
| Go lib/pq exploratory wire attempt | Failed: prepared INSERT waited for ReadyForQuery and hit overall test timeout. Not adopted; the supported application driver remains Node `pg` |
| govulncheck v1.9.0, server binary mode | **Failed, exit 3**: 13 symbol findings in 4 modules, plus lower-level module/package findings; [raw report](22-server-govulncheck.txt) |
| govulncheck v1.9.0, candidate verifier binary mode | **Failed, exit 3**: 8 symbol findings in 2 modules; these gRPC/x/net versions are inherited from the production verifier graph; [raw report](22-client-govulncheck.txt) |

Native tests run the project's actual Go verification handler and official SDK over real authenticated TCP. They prove actual native SQL insertion/read; inclusion/dual/transaction proof verification; forged returned values and corrupt actual inclusion-root/path rejection; reopened persistent state; invalid original-anchor rejection with retained and fresh caches; genuine independent receipt-anchor verification after cache loss; stopped-server 503; process crash/restart with unchanged transaction IDs/hashes and two exact row identities; a privileged appended revision having a different genuine transaction.

Fault injection never fabricates a valid proof. A one-entry transaction has no sibling path; the test then corrupts its actual authenticated inclusion-root bytes and requires the SDK's cryptographic corruption error. The application service still has to reject a valid later revision as the original receipt; existing audit orchestration tests cover that identity rule.

Binary scans identify linked vulnerable symbols, not proven network-path reachability. The server build's root module is reported as a `v0.0.0` pseudo-version, producing two old ImmuDB version-range findings. Official GitHub comparison verifies candidate commit is 900 commits ahead of v1.4.1, where the two upstream advisories say the fixes were introduced. This metadata qualification does not waive the distinct old gRPC/HTTP2/protobuf findings, and findings are not suppressed. Source reachability review and remediation are still required.

## Unsatisfied gates and next delivery

Keep the existing production server/client pins and all ledger/trust-state volumes. Do not adopt this unmodified 2023 candidate. Choose and review either a compatible native adapter plus explicitly patched dependency build, or a different exact OSI ledger. Then prove historical epoch/receipt routing, migration/isolated restore and rollback/forward recovery without changing original attestations. Full PR3 business-stack acceptance must run on the eventual adoption HEAD. No production deployment, organizer acceptance or competition-qualified release is claimed.

The PR's current SHA, original CI and additional candidate gate URLs are recorded on GitHub. The additional candidate wire gate is intentionally still unsatisfied; green baseline CI or native proof tests cannot replace it. See [ADR-003](../adr/003-ledger-license-qualification.md).
