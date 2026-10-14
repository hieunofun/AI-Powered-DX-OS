# ADR-003 — Qualify an Apache ledger before changing historical proof storage

Date: 2026-10-14 (Asia/Saigon). Status: proposed for peer review in #22.
Owner: A, hieunofun. Reviewers: huybitvvt and lehoangnam206.

## Context and exact provenance

PR #67 is merged at `02b67484e2c177d215b38779988e206a008f402b`, verified in fetched `origin/develop`. Its actual HEAD `55dec1672d51153c37d56818480751cce898d505` has a successful [CI run](https://github.com/hieunofun/AI-Powered-DX-OS/actions/runs/38540784186) and approval from huybitvvt. This accepts the contract foundation, not PR4 runtime APIs.

The existing server image and verifier SDK use ImmuDB **v1.11.0**. The [exact tagged LICENSE](https://github.com/codenotary/immudb/blob/v1.11.0/LICENSE) is **BUSL-1.1**, with a limited production grant and a per-version future Apache change license. BUSL is source-available; a future change license does not establish present OSI eligibility. The internal #10 exception is not organizer acceptance.

The official **v1.9DOM.1** tag resolves to immutable commit `d5f425e46b4bfd0771274cb4c2ea77634421600c`, released on 2023-11-16. Its [source LICENSE](https://github.com/codenotary/immudb/blob/d5f425e46b4bfd0771274cb4c2ea77634421600c/LICENSE) is Apache-2.0, including the server and client source at that revision. Apache-2.0 is [OSI approved](https://opensource.org/license/apache-2.0). The exact Go module is `v1.9.0-RC2.0.20231116103301-d5f425e46b4b`; the pseudo-version identifies the commit and must not be confused with a different v1.9.x tag. Dependencies retain separate licenses. Preserve the license, copyright and any applicable upstream notices when distributing binaries; do not label upstream work as project MIT code.

## Options

| Option | License/proof situation | Migration and operating cost | Decision |
| --- | --- | --- | --- |
| Keep v1.11.0 | BUSL-1.1 server and SDK; working native proofs | Lowest compatibility cost; unresolved eligibility | Preserve existing runtime pending a reviewed replacement |
| v1.9DOM.1 exact Apache source | Same native SQL row/transaction proof family, older server | Lowest candidate adapter cost; source build, security and historical continuity need proof | Qualify in isolation first |
| v1.9.7 or an unspecified v1.9.x | v1.9.7 tagged LICENSE is also BUSL; version family is insufficient evidence | Downgrade adds risk without resolving the known license gate | Reject as a license-only solution |
| Older Apache v1.5.0 | Exact tagged Apache license; still older implementation | More missing functionality and security maintenance | Do not prioritize over v1.9DOM.1 |
| Trillian transparency log | [Apache-2.0 upstream](https://github.com/google/trillian/blob/master/LICENSE); not a selected exact dependency | New leaf encoding, log signer/client, receipt format, database operations and historical bridge | Defer; requires a separately pinned design and qualification |
| PostgreSQL hash chain alone | Existing OSI database, but shares mutable application trust | Cheap, loses independent ledger/native proof guarantees | Reject as a substitute for current acceptance |

## Decision and delivery boundary

Split #22 into qualification and adoption. First deliver an executable, reproducible candidate server/SDK source build and real native proof, tamper, trust-state and outage tests. Keep the production Compose image, verifier module, ledger volume and receipts unchanged in this first PR. A 2023 Apache header and a compile test alone cannot justify replacing a ledger.

The candidate does **not** implement v1.11.0's `immudb_state`, `immudb_verify_row` or `immudb_verify_tx` SQL wrappers. Tests must exercise the actual official SDK `VerifyRow` and `VerifiedTxByID`; replacing missing wrappers with local `true` results is prohibited. The candidate harness uses the project's verifier orchestration compiled with a separate exact candidate module file. Production proof code and dependency pins remain independently exercised by existing CI.

Actual wire qualification exposed a second difference: v1.9DOM.1 reports `(smartprocure_audit_seals.column)` labels, whereas v1.11.0 reports bare column names. Add explicit normalization for those two exact forms in the existing adapter, rejecting foreign/unknown/duplicate/missing column identities. This retains original values and receipt/entry checks. The harness calls the compiled project Node `pg` adapter. An exploratory Go lib/pq prepared INSERT hung against the old server; that driver is not used or adopted by the application, and its timeout remains a documented compatibility limitation.

After fixing column-name normalization, the actual project's Node `pg` parameterized INSERT also returned **Query read timeout** against v1.9DOM.1. The separate wire compatibility test remains an unsatisfied acceptance gate and runs in CI without `continue-on-error`. Native proof tests use actual native SQL to gather independent crypto/recovery evidence; their success cannot substitute for this failed adapter gate. The qualification PR is a draft and does not claim a migration-ready candidate. Adoption needs either a reviewed compatible adapter or a different ledger, in addition to security remediation and historical migration.

Use separate temporary storage, authenticated native TCP sessions, no public ports in the candidate container, and no existing volume mounts. Include source/toolchain/module provenance and license artifacts in the candidate image. Record dependency/security findings rather than presenting an old release as supported or secure by default. The existing BUSL runtime remains a release gate while adoption is pending.

The native source-built candidate was scanned with official `govulncheck v1.9.0` binary mode on 2026-10-14 using Go 1.27.2. The scan **failed (exit 3)** with 13 symbol-level findings: old gRPC/HTTP2/protobuf dependencies and two ImmuDB proof/UUID version findings. Binary mode cannot establish request-path reachability; the local source build reports the root module as a `v0.0.0` pseudo-version, so the latter two findings need exact-commit review against the upstream v1.4.1 fixes. They are not silently suppressed. The other old dependency findings include gRPC authorization bypass ([GO-2026-4762](https://pkg.go.dev/vuln/GO-2026-4762)) and HTTP/2 transport DoS. **Do not adopt the unmodified candidate as a production replacement.** Security remediation with an explicit dependency patch/inventory and rerun of proof/regression qualification is an adoption prerequisite. See the linked issue/PR evidence for the exact scanner output and limitations.

## Required follow-up before adoption

1. Peer review this ADR and all real qualification results, including security findings and transitive license inventory.
2. Define the cutover epoch and historical ledger identity/receipt routing. Preserve original package bytes, transaction IDs/hashes, receipt proofs and verifier trusted state. Do not attach v1.9DOM.1 to a v1.11.0 volume or assume its storage format is backward compatible.
3. Implement an explicit, report-only migration inventory, authenticated historical verification/exports, isolated restore and rollback/forward recovery. Verify counts and hashes, and retain original ledger/state archives. Copying rows into a new ledger is a new attestation and cannot inherit old transaction proofs or timestamps.
4. Update the production adapter/bootstrap, deployment, full regression tests, distribution SBOM/notices and runbooks together. Run actual PostgreSQL-wire compatibility and complete business-stack acceptance on the changed HEAD.
5. Obtain review/merge and complete #22 acceptance before closing it. This qualification PR uses `Refs #22`, not `Closes #22`. No organizer acceptance is asserted.

## Threat model and limits

Native inclusion proofs bind the returned row to a ledger transaction. Consistency proofs bind new verified states to retained trusted states. Tests deliberately corrupt actual returned proof bytes or row values to establish rejection; these are fault injections into real responses, not fabricated successful proofs.

First contact is trust on first use. Losing verifier state must be reported; automatically accepting a fresh state cannot establish continuity with a lost anchor. Retained receipt anchors are independently checked even with a fresh client cache. If both ledger and all independent anchors are replaced, continuity is unproven. Preserve ledger identity as well as hashes.

The ledger does not prove that original business input was true, legally signed or externally timestamped. Privileged writers may append new revisions; package identity and the original transaction receipt must still match. Network isolation and authentication do not eliminate application vulnerabilities. An unavailable ledger or invalid proof cannot produce VERIFIED. Only disposable synthetic records are modified by qualification tests; historical project evidence remains untouched.
