# Issue #41 runtime acceptance matrix

Status: proposed tests, none executed by this docs-only branch. See [design](SECURE_EVIDENCE_INTAKE_SPEC.md). All integration tests use an isolated stack/tenant and retain command, environment, exact SHA, raw result and CI URL. Unit doubles demonstrate contract handling only; they do not establish real clamd/MinIO/tenant behavior.

| ID | Trigger | Observable result / required evidence |
| --- | --- | --- |
| EI-01 | Register permitted XML/PDF/PNG/JPEG with valid context | 201; server UUID/tenant/actor/revision; private protected upload path; expiry exactly 15 minutes; PENDING_UPLOAD/NOT_STARTED. |
| EI-02 | Client supplies tenant/actor/time/object key/unknown properties | Reject 400; no accepted registration or client-controlled identity/storage path. |
| EI-03 | Missing/expired JWT, missing tenant, unavailable membership | 401 / 400 TENANT_CONTEXT_REQUIRED / 503; no data or identity fallback. |
| EI-04 | Foreign-tenant ID, same UUID absent, wrong in-tenant permission | Identical foreign/absent 404; scoped action denial 403; record authorization call and zero unauthorized storage/scanner/AI calls. |
| EI-05 | XML at 5 MiB and over; other media at 20 MiB and over | Exactly-at-limit valid file allowed; excess registration/upload rejected; stream terminated even with missing/false Content-Length. |
| EI-06 | MIME/magic mismatch, empty/binary XML, UTF-8 errors | 415/400 per reviewed mapping; no scan dispatch or accepted success; filename extension cannot select parser. |
| EI-07 | Wrong registered SHA, modified stored bytes but unchanged metadata | 422 CHECKSUM_MISMATCH or failed/reconciliation operation; never CLEAN; actual streamed bytes checked. |
| EI-08 | Concurrent same-key same-payload registration/upload | One evidence/operation/scan intent; replay returns original result; no duplicate source revision or replacement writer. |
| EI-09 | Reuse key with changed metadata/bytes; expiry during replay | 409 for changed payload; new expired upload denied; already accepted work finishes; replay reauthorizes result. |
| EI-10 | Clean synthetic PDF/XML/image with real clamd | Complete exact-hash scan yields CLEAN with engine/signature/policy/attempt provenance; no claim of authenticity. |
| EI-11 | Controlled EICAR test submitted directly to real isolated scanner | INFECTED, durable bounded signature history; download and OCR denied; no approval override. Use a harmless test pattern in memory, not genuine malware. |
| EI-12 | EICAR renamed as another extension; embedded scan test | Signature/magic gate cannot be bypassed by a name; embedded fixture scanned or permanently blocked by scan policy. |
| EI-13 | Scanner absent, stale definitions, PING succeeds but not ready | PENDING_SCAN/SCAN_FAILED plus durable error; no CLEAN, no OCR/download; freshness/capacity readiness verified. |
| EI-14 | Scanner timeout, EOF, bad/fragmented/oversized reply | Valid fragmented reply supported; incomplete/malformed reply fails closed; worker deadline covers all I/O phases. |
| EI-15 | Encrypted PDF or decompression/recursion/file-count ceiling | No partial-scan OK accepted; policy alert becomes SCAN_FAILED; actual configured limit behavior verified. |
| EI-16 | Daemon keeps processing after client deadline | Bounded supervisor recovery/capacity; no unbounded new scans; source/operation remains blocked. |
| EI-17 | XML DTD/entity/XXE, excessive depth/elements, malformed/unsupported profile | Safety/parser rejection without external resolution; worker resource/deadline bounds; raw history retained; no domain ingest. |
| EI-18 | Same evidence in each non-CLEAN state | Authorized metadata readable; download/OCR denied; spy on reader/provider call counts and test real HTTP responses. |
| EI-19 | Tenant/ACL revoked after enqueue or during read | Worker reauthorizes and stops; future chunks/dispatch blocked; already delivered bytes are explicitly outside recall. |
| EI-20 | CLEAN object modified, scanner verdict revoked, stale worker completes | Version/hash/lease compare-and-set rejects old result; no stale CLEAN publication or AI dispatch. |
| EI-21 | DB unavailable before durable intent | 503; zero accepted 201/202; no silent successful upload. |
| EI-22 | Object write completes, DB finalize fails | Recorded uncertain operation; recovery checks actual stream/hash and references; same-key retry cannot duplicate accepted work. |
| EI-23 | Object upload fails midway or scanner result commit fails | Recoverable durable operation/history/source reference; partial bytes never CLEAN; no loss of an acknowledged accepted source. |
| EI-24 | Worker crashes; duplicate outbox delivery; lease expires | Bounded restart recovery; one current owner per revision; old lease cannot finalize; durable attempt counts survive restart. |
| EI-25 | Repeated safe dependency errors and permanent errors | At most three persisted attempts; jittered backoff; permanent errors stop; authorized manual retry records new history. |
| EI-26 | Simultaneous tenants and concurrent limits | No storage/job/result leakage; per-resource predicates; aggregate worker/storage capacity enforced before accepted overload. |
| EI-27 | Attachment with dangerous filename/header characters | Safe attachment Content-Disposition and nosniff; no header injection/path traversal/presigned URL/inline rendering. |
| EI-28 | Expired registrations, abandoned staging, legal hold, uncertain jobs | Metadata/history retained; no automatic accepted-object deletion; report candidates only; zero bucket/volume purge. |
| EI-29 | Restore DB/object snapshots with old leases/results | Hash/reference consistency checked; stale leases invalidated; incomplete classifications blocked until valid rescan. |
| EI-30 | Existing PR3 invoice/quantity/workflow/audit scenarios | Relevant unit/E2E and real-stack regression passes on implementation SHA; no legacy route bypass after tenant cutover. |

## Execution and release record

Run protocol/size/reply tests with a socket double, then confirm positive and controlled infected/limited/error outcomes against the actual pinned daemon and its fresh definition database. Use real PostgreSQL/MinIO for persistence/concurrency/crash cases. Verify unauthorized tests by proving downstream work did not occur, not only by checking HTTP status. Never insert a client-supplied CLEAN flag or bypass context/scanning in integration tests.

For each case capture test ID, fixture provenance/hash, backend/scanner source or image digest, definition version/timestamp, policy version, tenant-safe resource/operation/revision/attempt IDs, command/result and CI URL/SHA. Record test doubles and unfinished acceptance separately. Scanner image pinning, resources and versioned migration ownership require A's integration review.

After #37/#38 merge: fetch develop, create feat/41-secure-evidence-intake, implement accepted ports/limits/lifecycle, run the matrix and PR3 regressions, open an English PR with Refs #41, obtain peer review and latest-SHA CI, merge, then assess issue closure. Docs/review requests do not complete EI-01..30.
