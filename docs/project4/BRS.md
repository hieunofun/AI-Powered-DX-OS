# First-wave BRS and acceptance traceability

Status: proposed baseline for review; derived from blueprint sections 5/15 and supplied plan. Product behavior below is a target, not PR3 functionality already achieved. Owner A, reviewer B/C, P4-02 #37.

## Business accounting

OpenResolve owns quantity accounting. Package count is an integer separate from item quantities. Track expected, shipped, physically_counted, inspected, accepted, rejected, held, pending_inspection and missing as exact decimal strings. Missing=max(shipped−physically_counted,0); overdelivery is separately guarded against order/policy. Accepted+rejected+held=inspected; inspected+pending_inspection=physically_counted. For 10 packages expected/shipped 100 and counted 95, record counted=95 and missing=5; never received=100 and rejected=5. Legacy GRN received=accepted+rejected is migrated to counted/inspected with held=pending=0 while marking QC granularity as legacy, without inventing inspections.

Billable is computed by a versioned contract/acceptance policy, not assumed equal to accepted. A configurable baseline policy bills accepted quantity only and deducts effective active invoice claims/reservations under the existing PO lock. Alternate policies need explicit fixtures/review before activation. Hold/quarantine and unconfirmed OCR cannot authorize financial clearance. No over-allocation across concurrent pending or approved invoices.

Finalized receipt history remains immutable under the existing business meaning. Four failures after 100 units were accepted/assigned create a post-handover incident with original receipt/serial/assignment references and new evidence. Returns/credit/adjustment are append-only compensating records; source/rules authorize reversal, never edit GRN history. Minimal compensation is #53; full warranty/RMA/settlement extension remains P4-39. Serial granularity and remedy rules need #53 specification.

The deterministic matcher flags a unit price increase from 10,000,000 to 11,000,000 as +10%; a 5% reviewed policy routes a case. Invoice-before-receipt remains pending/exception under explicit policy; AI extraction cannot make it matched. Approved/READY_FOR_PAYMENT is separate from PAID; only a permitted external source can record settlement. Monetary arithmetic preserves PR3 scale/rounding and is not performed by the LLM.

Exception cases may open at receiving, source conflict, matching or post-handover incident. The draft domain states OPEN→TRIAGED→INVESTIGATING→PENDING_APPROVAL→RESOLVING→CLOSED preserve evidence and decision revisions. Reopen/owner/delegation/SLA/action guards are #53 specification; frontend cannot infer permission from the state alone.

## Acceptance traceability

| Blueprint | Scenario and expected result | Main backlog evidence |
| --- | --- | --- |
| AT-01 | A cannot read/update B's resource/file/search/worker data | #43, #46, #63 |
| AT-02 | Concurrent invoice capacity only commits permitted claims | #53, #62, PR3 #34 regression |
| AT-03 | Counted 95/missing 5 from 100 items and 10 packages | #53; ReceiptQuantities fixture |
| AT-04 | Four post-handover failures create incident, no GRN rewrite | #53 |
| AT-05 | +10% price versus 5% tolerance becomes exception | #48, #53 |
| AT-06 | OCR total correction retains raw/extraction/actor and rematches | #26, #44, #46 |
| AT-07 | Policy replay shows A/B with no business/tool side effects | #56, #58 |
| AT-08 | Injection cannot approve/export outside rights | #54, #63 |
| AT-09 | Dependency outage gives pending/reconcile, no false completion | #45, #62, #65 |
| AT-10 | Onboarding reuses identity/workflow/evidence, zero domain core diff | #59, #60, #61 |
| AT-11 | Fresh release clone builds/migrates/seeds/runs | #64, #66, #30 |
| AT-12 | Isolated restore preserves data and verifiable trust state | #65, #66 |

Mandatory headless identity/gateway/structured+unstructured data/workflow and H-P-D-I are assessed in #66. External-source conflict→case→decision and IT/OT ingress: #51/#53; hot/cold projection: #57. At this foundation stage, fixtures verify shapes and examples only; no AT runtime acceptance is claimed.
