# Apache ledger qualification (#22, first PR)

Build the exact official Apache `v1.9DOM.1` server commit and the project's actual verifier orchestration with its separately pinned Apache SDK. Tests start/kill/restart a real authenticated server over native TCP and PostgreSQL wire, using only temporary synthetic storage. No Docker socket, host ports or existing volumes are mounted into the runner.

```sh
docker build -f infra/audit/qualification/Dockerfile -t opendx-ledger-qualification .
docker run --rm --network none opendx-ledger-qualification
```

Loopback networking remains available with `--network none`; no external ledger can be reached. All proof responses are real. Tamper tests alter actual returned row/proof bytes before SDK verification or append a new row revision inside the disposable ledger. Native inclusion/consistency proofs, persisted SDK state, wrong retained anchors, fresh-cache recovery with a retained anchor, actual process outage and transaction-preserving restart are exercised. A valid proof for a later row revision does not authenticate it as the original seal; the existing audit service separately checks receipt identity.

Native proof and project-wire tests are separate gates. The current candidate fails the actual Node `pg` parameterized INSERT with `Query read timeout`; default execution and CI keep that failure visible. To inspect each gate independently:

```sh
docker run --rm --network none opendx-ledger-qualification -test.run 'TestReceipt|TestLedgerQualificationNative'
docker run --rm --network none opendx-ledger-qualification -test.run TestLedgerQualificationProjectWireCompatibility
```

The second command is currently expected to fail. Its assertions are retained. Passing native tests does not establish adapter compatibility or #22 acceptance. Security scans also fail for old server/dependency symbols; review the exact evidence before any adoption.

The image contains `/provenance/`: immutable source revision, original server and candidate-verifier module/checksum files, Go toolchain/build metadata, full module inventories and packaged dependency licenses/notices. A module inventory is not a claim that all listed modules are linked; the binary build metadata identifies linked dependencies.

For native development, run `npm ci` and `npm run build:api` at the project root, build `./cmd/immudb` from the exact upstream commit, and run from `infra/audit/verifier`. Node must be in PATH; the wire probe imports the actual compiled project adapter and existing `pg` package:

```sh
IMMUDB_QUALIFICATION_BINARY=/absolute/path/to/source-built-immudb \
  go test -modfile=candidate.mod -mod=readonly -tags ledgerqualification -v -timeout 180s ./...
```

No test skips on a missing server binary. Default `go test ./...` still tests the production BUSL module; tagged qualification uses `candidate.mod/candidate.sum` and does not edit production dependency pins.

See [ADR-003](../../../docs/project4/adr/003-ledger-license-qualification.md) for options, license distinctions, threat model and required historical migration/security/adoption follow-up. The production ledger remains v1.11.0, and #22 remains open. This is qualification evidence, not completed competition eligibility or full business-stack acceptance with a replacement.
