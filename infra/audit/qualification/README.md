# Apache ledger security, wire and historical qualification

Build from the repository root:

```sh
docker build -f infra/audit/qualification/Dockerfile -t opendx-ledger-qualification .
docker run --rm --network none opendx-ledger-qualification -test.run 'TestReceipt|TestLedgerQualificationNative'
docker run --rm --network none opendx-ledger-qualification -test.run TestLedgerQualificationProjectWireCompatibility
```

The build uses immutable Apache SDK/server source d5f425e with the adopted runtime module locks, Go 1.27.2 and Node 20 pinned by image digest. Source and binary govulncheck v1.9.0 are required gates. Images retain linked-module CycloneDX SBOMs, h1 sums, binary hashes and original dependency notices. Raw scans retain the module-only OpenPGP advisory; OpenPGP is absent from both binaries' imported packages. Findings/assertions are not suppressed.

Native tests create a real authenticated server, rows/proofs, persistent trust state, injected corruption, process outage/restart and privileged append. Wire tests use the compiled project Node pg adapter. Linux is the supported target; the earlier Windows native wire INSERT timeout remains documented and Windows deployment is not qualified by Linux CI.

The workflow also launches disposable PostgreSQL and runs TestLedgerHistoricalMigrationAcrossRealEpochs on a private network. It uses the exact test-only v1.11 BUSL binary and independent Apache data/state. It inventories/exports PostgreSQL data against native old-ledger proofs, interrupts/resumes exports, reruns idempotently, restores archives and actual original ledger/state into isolated directories, then verifies old receipts through the real application adapter after stopping the old server. Corrupt packages/proofs/archives, missing files, wrong anchors and unauthorized requests fail closed. The old binary/notice are confined to this test image and original backups.

Missing real binaries/database fail the corresponding test. Production images carry only Apache source and locked dependencies. See the [migration runbook](../history/README.md), [ADR](../../../docs/project4/adr/003-ledger-license-qualification.md) and acceptance evidence. Issue #22 remains open pending peer review, merge and scoped acceptance; CI is one gate.
