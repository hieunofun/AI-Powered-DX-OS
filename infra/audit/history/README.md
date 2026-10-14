# Historical ledger cutover and recovery

PR #69 selects Apache source d5f425e with pinned security dependencies. This is a **new epoch**, not an in-place downgrade. Compose now uses `smartprocure_immudb_apache_d5f425e_data` and `smartprocure_immudb_apache_d5f425e_verifier_state`. Old `smartprocure_immudb_data` and `smartprocure_immudb_verifier_state` remain available. No tool here removes volumes, updates PostgreSQL receipts, or reseals historical entries.

## Before cutover

1. Obtain peer review/merge and pin the deployment commit. Stop API, workflow and all other writers; reconcile pending finalizations/seals against the old ledger. Record the maintenance boundary. `REPEATABLE READ READ ONLY` export cannot itself stop external writers.
2. Retain independent, restore-tested PostgreSQL (`pg_dump`), matching MinIO object bytes, Flowable history, old ledger data, verifier state, UUID and controlled configuration/secrets. Keep gRPC/verifier networking private and use managed backend credentials. Secrets must not enter exports.
3. Build the Apache verifier from `infra/audit/verifier` with Go 1.27.2 and `-mod=readonly`. Temporarily point it at the old v1.11 ledger with the retained original trust cache, on a private network. The old server retains BUSL terms during this maintenance window. Configure host PostgreSQL/old-ledger environment, verifier URL/token and `IMMUDB_HISTORY_VERIFIER_BINARY` to that binary.
4. Run `node infra/audit/history/migrate.cjs inventory` (report-only default). Require zero pending/unsealed records and matching row counts. Run `export /absolute/new/export-directory`. Every frozen package/original receipt is inspected offline against original transaction/state anchors and compared with the live old ledger. The manifest is published only after every record passes. Retain its printed SHA-256 independently, not solely beside the archive.
5. Run `verify /absolute/export <independent-manifest-sha256>` and `restore /absolute/export <sha256> /absolute/isolated-restore` using the same script. Verify counts/hashes and exact original receipts. Interrupted export leaves files without an accepted manifest; same-data reruns are idempotent, conflicting files fail. Never accept a pin from a failed run.

The Linux/WSL host volume helper also supports:

```sh
node infra/audit/history/volumes.cjs backup /absolute/new/backup \
  smartprocure_immudb_data,smartprocure_immudb_verifier_state --writers-stopped
node infra/audit/history/volumes.cjs verify /absolute/backup <independent-backup-manifest-sha256>
node infra/audit/history/volumes.cjs restore /absolute/backup <sha256> isolated_drill
```

It inspects named volumes before mounting sources read-only, rejects existing backup directories, checks tar hashes, and restores into new volumes only. Existing restore targets are refused. Original volumes remain available on failure; partial restoration is not accepted. Restore old data only with its original v1.11 server, never with v1.9 storage code. Recheck native original anchors after restore. Hash manifests require independently trusted retention. Keep a matching PostgreSQL/object-store/workflow backup; this helper does not replace those systems' backups.

## Cutover

Set `IMMUDB_HISTORY_ARCHIVE_PATH` to the verified absolute archive and `IMMUDB_HISTORY_MANIFEST_SHA256` to its independent pin. Compose mounts it read-only and sets the fixed new epoch on API/verifier. Start Apache on its new empty volume and bootstrap the fixed table. Check existing authenticated report/verification APIs before reopening writers. Old SEALED records without the new epoch route to the archive with PostgreSQL's original transaction/state anchors. Missing archive/pin produces unavailable/mismatch, never VERIFIED; no fallback to a copied active-ledger row is permitted.

Original package/receipt JSON, decimals, transaction IDs/hashes and timestamps remain unchanged. New receipts record genuine native proof, UUID and epoch; identity drift fails closed even with a fresh client cache. Retain old ledger/state archives and the independently pinned historical export throughout retention. Financial exports require controlled access. The internal historical endpoint requires a bearer token, bounded bodies/files and no caller-supplied paths/pins. Backend secrets never enter frontend flows.

## Rollback and forward recovery

Before any new-epoch write: stop writers, restore the pre-cutover application/configuration, original v1.11 data/state and matching business/storage snapshot, then reverify original anchors. Retain Apache volumes/exports for inspection and record counts/hashes.

After any new-epoch write: do not switch the active ledger back or restore an older PostgreSQL snapshot, which would lose newer receipts/business history. Stop writers, repair or restore Apache data/state into isolated new volumes, retain the original archive, verify both epochs, and reconcile pending durable intents by stable key. Resume only after counts/hashes agree. Loss of both ledger data and independent anchors cannot establish continuity; never mint replacement historical proofs.

## Acceptance limits

CI uses disposable PostgreSQL and real old/new native proofs, the actual application adapter, immutable receipt/decimal checks, corruption/outage/interruption/idempotence, archive restore and isolated original ledger/state restore. Main CI exercises the changed Apache runtime with the full business stack/browser. The generic volume helper is separately checked on disposable volumes. Deployment-specific restore drills, MinIO bytes and retention still require an operator record before actual cutover. This PR migrates no real project volumes, claims no organizer approval, and closes no issue before peer review/merge and full acceptance.
