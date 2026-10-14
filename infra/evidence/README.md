# Secure evidence intake — issue #41 implementation draft

Branch `feat/41-secure-evidence-intake`, based on merged platform contracts at develop@02b6748. [#38 PR #68](https://github.com/hieunofun/AI-Powered-DX-OS/pull/68) awaits peer acceptance. This draft does not enable target routes in the main AppModule or close #41.

## Implemented boundary

- `EvidenceModule.register(service, resolver)` requires explicit service and verified server context ports. There is no tenant-header/body/default identity fallback. The resolver must authenticate JWT and revalidate active membership; `EvidenceAccess.check` enforces action/resource/retention grants at request, dispatch and delivery boundaries. Existing JWT normalization has no tenant; A's #43 bridge is required for production composition.
- POST registration, GET list/detail/operation, protected PUT content and GET clean attachment follow the merged `/platform/v1` schemas. Errors use correlation IDs and safe shared codes; 429 includes Retry-After. Client identity/state/object properties and unsupported query shapes are rejected.
- XML max 5 MiB; PDF/PNG/JPEG max 20 MiB. Exact bytes/hash/MIME/magic are checked before acceptance and after private storage write. XML uses strict UTF-8, no DTD/custom entities, well-formedness, 64 nesting/10,000 elements, a 2-second isolated validator with 64/16 MiB heap and 2 MiB stack. This is generic file validation; domain XML profiles and decoder budgets belong to #26.
- PostgreSQL records atomically contain evidence, accepted scan intent, operation, attempt counters, due times and private append-only histories. Scope hashes bind idempotency to tenant, principal, method, route and key. Resource and command advisory locks serialize races. Every query predicates tenant; there is no process-memory job queue or automatic schema creation.
- Upload intent precedes storage; 202 requires full readback/hash plus durable accepted state. Each bounded retry writes a fresh private attempt key; previous attempted keys remain in upload history. Ambiguous writes/finalization stay RECONCILIATION_REQUIRED with stable operation ID. Old writers cannot overwrite the currently referenced object or finalize an expired lease. New registrations expire exactly 15 minutes after their server timestamp; acknowledged replay does not rewrite bytes.
- `processNextScan(verifiedWorkerContext)` polls persisted candidates. It authorizes before/after scanner I/O, claims a 60-second lease, persists the attempt before dispatch and applies a revision/token/deadline guard. Retryable failures use persisted exponential backoff with jitter, maximum three attempts; permanent/infected outcomes stop. The caller must provide scheduling and currently authorized tenant worker contexts during integration.
- `withCleanBytes` guards download/extraction consumers, fully hashes actual bytes and rechecks state/revision/ACL before dispatch. Corruption revokes CLEAN and records reconciliation; no consumer receives bytes. HTTP uses attachment/octet-stream, nosniff and no-store, rechecks before each 64 KiB chunk, and aborts on revocation/disconnect/30-second delivery deadline. Previously delivered bytes cannot be recalled.
- Two service-instance slots bound upload/read/scan work; each read is capped by media size and a 15-second total deadline. Payload buffering is in memory, with additional readback/concatenation/XML-worker overhead. This is not a distributed quota. No automatic physical deletion, public storage URL, inline preview, AI confirmation or extraction persistence is introduced.

## Isolated runtime fixture

Prerequisites: Node >=20, installed dependencies, Docker with roughly 3 GiB free RAM for the scanner. The fixture has its own `opendx-issue41` project/volumes and loopback-only ports 15441/19441/33141. Credentials in this Compose file are public local test credentials. The runner never loads `.env` and makes zero Gemini calls.

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd run build:api
docker compose -f infra/evidence/compose.yaml up -d
# Wait for startup/signature download. Docker PING health alone is insufficient.
node infra/evidence/validate-runtime.cjs
```

The runner's first gate requires exact engine, loaded signature age <=24 hours and complete clean INSTREAM. It refuses stale signatures; it never weakens freshness or inserts CLEAN. The container first runs freshclam in the foreground and only then starts clamd, so startup cannot load bundled stale definitions before the initial update finishes. An update failure blocks startup. First startup can download/load signatures for several minutes. Subsequent freshclam updates notify clamd and SelfCheck runs every 60 seconds; readiness still checks the actual loaded version.

```powershell
docker compose -f infra/evidence/compose.yaml logs scanner --tail 30
docker compose -f infra/evidence/compose.yaml stop
```

Stop retains all fixture volumes/source/history. There is no purge command. Scanner TCP is unauthenticated; production must use a private socket/internal network without published host ports.

Policy `evidence-intake-v1`: ClamAV 1.4.6 image pinned by digest in Compose; 20 MiB stream/file, 100 MiB scan, recursion 10, files 1,000, scan-time setting 25,000 ms, two threads/four queue slots, encrypted/limit/broken alerts, 2 CPU/4 GiB container cap. The independent 30-second client deadline covers VERSION, INSTREAM writes and complete reply/EOF. MaxScanTime does not prove every decoder stops; a hung-daemon supervisor is a production release gate. Exact loaded version/definition time/policy and private object/hash/lease/revision/attempt are retained in history.

## Validation and practical limits

[Raw runtime report](../../docs/ai/evidence/issue41-runtime.json) records command, Node/platform, source hashes, fixture IDs/hashes, exact scanner image, loaded definitions and 13 passing groups on real PostgreSQL/MinIO/clamd. Identity is a static server test resolver, and finalization failures are deliberately injected; this is not production JWT or a real process-kill recovery claim. Resources remain in the isolated stack for inspection. Reports record a dirty tree when run before the final documentation commit; source hashes identify tested implementation bytes.

Verified runtime cases include concurrent registration idempotency, upload replay/readback, clean PDF attachment/private bucket, controlled EICAR as a PDF attachment under a misleading filename, encrypted PDF and decompression-limit alerts, XML safety, actual MinIO corruption, retained uncertain upload/retry, recreated worker instances with persisted three-attempt exhaustion and unavailable scanner, tenant-bound cursors/storage. CLEAN is a complete configured scan verdict, not authenticity or proof of all malware detection. In exploratory testing an EICAR string wrapped in an XML comment was not detected; the embedded positive fixture is specifically a PDF attachment. Untrusted XML still never resolves entities or runs domain logic in generic intake.

Unit tests additionally exercise exact size/overflow, unsafe entities/encoding, stale leases, worker/read revocation, response framing/trailing packets/EOF/timeouts, retention grants and two-slot capacity. Nest HTTP tests validate responses against merged schemas with explicitly labelled DB/storage/scanner/identity doubles.

Local regression passed on 2026-10-14: 520 API unit tests/30 suites (including 66 evidence tests), 226 Nest E2E/9 suites (including 19 evidence HTTP tests), 4 web decimal tests; full API/web build and lint; contract validator 43 definitions, 23 operations, 32 positive/13 negative fixtures and 32 embedded examples. After the final evidence-only idempotency guard, the 66 evidence tests, 19 evidence HTTP tests, API build/lint and real runtime groups were rerun. These are local results; PR CI is reported separately.

```powershell
npm.cmd run test:api
npm.cmd run test:e2e --workspace=apps/api -- --runInBand
npm.cmd run test:contracts
npm.cmd run build
npm.cmd run lint
```

The [30-case release matrix](../../docs/ai/SECURE_EVIDENCE_INTAKE_ACCEPTANCE.md) remains partially satisfied. Before integration: peer acceptance of #38/#41, #43 JWT/tenant/current ACL bridge, A-assigned numbered migration and shared composition, real revocation/process-crash/coordinated snapshot restore, daemon hang recovery, distributed quotas/retention administration and legacy real-stack regression. SQL under `database/proposed/` is applied only to the isolated database; it reserves no shared migration number. No main/develop push, merge or self-approval is part of this draft.
