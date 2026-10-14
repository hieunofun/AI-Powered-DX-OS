# Issue #41 runtime acceptance matrix

Status: implementation draft with partial runtime acceptance. See [design](SECURE_EVIDENCE_INTAKE_SPEC.md), [run instructions](../../infra/evidence/README.md) and [isolated raw report](evidence/issue41-runtime.json). The table below defines release requirements, not a claim that all 30 cases passed. The report records real PostgreSQL/MinIO/clamd checks and exact source hashes. Static server identities and injected faults are explicitly labelled; they do not establish production JWT/membership or real crash/snapshot behavior. Local execution has no CI URL.

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

Implementation is based on merged #37; #38 PR #68 awaits peer review. Keep the #41 PR draft until verified tenancy/shared composition, migration ownership, daemon hang recovery, real revocation, restore and legacy real-stack checks are complete. Only peer acceptance and latest-SHA CI can establish merge readiness; #41 remains open.

## Observed coverage and pending portions

- EI-01/02: actual HTTP registration plus strict schema/server metadata and retention-grant checks in doubles.
- EI-03/04/19/26: real HTTP/tenant-predicated PostgreSQL/private MinIO with static server identities; invalid/absent token behavior and mid-read/mid-scan ACL revocation use doubles. Production JWT and active membership remain #43 gates.
- EI-05/06/17: exact 5/20 MiB and overflow, magic/UTF-8, XML depth/elements/entity/encoding guards in unit tests; DTD/malformed/depth rejection also ran through real HTTP/storage fixture. Domain profile and PDF/image decoder budgets remain #26.
- EI-07/08/09/10/11/12/18/20/27: actual readback/hash, database idempotency, clean PDF/attachment/private storage, embedded PDF EICAR, blocked states and object corruption. Concurrency/lease/stream guards also use doubles. Scanner verdicts do not establish safety for every possible embedded representation.
- EI-13/14/15: absent real scanner and fresh exact-version real scanner; encrypted PDF and gzip size-limit alerts verified. Stale/version/reply fragmentation/malformed/EOF/deadline handling uses actual TCP with a scripted daemon.
- EI-21/22/23/24/25: failed finalization and real retained object/intent/retry were exercised with an injected commit fault. Service recreation, persisted backoff/three attempts and unavailable TCP scanner ran against real PostgreSQL. Mid-write failures and stale/crashed lease owners use doubles. Actual process termination, uncertain commit restore, authorized manual rescan and daemon hang supervision remain pending.
- EI-16/28/29/30: no automatic object deletion exists; history and attempted object references are retained. Daemon hang recovery, retention administration, coordinated restore and full PR3 real-stack regression remain release gates. Full unit/Nest E2E/build/lint/contract regression results are recorded in the runtime README.
