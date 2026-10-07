# Invoice quantity reservations (Issue #34)

An invoice approved after a price discrepancy must consume received quantity even though its original matching result remains REVIEW_REQUIRED. New matching evaluations use 3WM-1.1. Historical match results, policies, ledger seals and audit packages are never rewritten by this fix.

## Effective claims

All quantities remain decimal strings and are calculated with the domain's 60-digit Decimal clone.

| Invoice/case state | Effective claim per mapped line |
| --- | --- |
| MATCHED, APPROVED, READY_FOR_PAYMENT | Full invoice quantity, independently of original matching status |
| EXCEPTION awaiting review, without an approving command | Persisted matched_received_quantity, capped at invoice quantity; unresolved lines reserve zero |
| EXCEPTION with a durable COMPLETE APPROVE/APPROVE_WITH_ADJUSTMENT command in an active case | Full invoice quantity, including PENDING, FAILED and APPLIED intermediate commands |
| Rejected/cancelled invoice or REJECTED/CREDIT_NOTE_REQUESTED case | No active claim |

The retained API field `previousValidInvoicedQuantity` now means the sum of these effective claims for 3WM-1.1 snapshots. The UI labels it as previously allocated/reserved quantity. Case-level EXISTS prevents multiple role approvals from counting a line repeatedly. A positive claim without a PO mapping fails closed with UNRESOLVED_QUANTITY_CLAIM rather than inventing an allocation for legacy/inconsistent data.

## Locks and remote effects

Supported matching and approving transactions lock the current invoice, then the parent PO, under explicit READ COMMITTED. Capacity inputs are queried after the PO lock. Approval requires every invoice line to have a matching-owned PO mapping, a stored quantity tolerance, enough current accepted RECEIVED stock and enough ordered quantity including the original PO tolerance. Groups of split lines share capacity. Quantity mismatch cannot be waived into stock that was never received.

The approving intent is committed in the same short transaction as the capacity check, before calling Flowable. That durable command holds the stronger claim while remote completion and local synchronization run. No lock is held during a network call. Intermediate approvals keep the claim through their APPLIED intent until the case reaches a release/clearance outcome.

Execution/recovery rechecks quantity before any remote approval action or adoption of observed engine completion. Existing historic-task/operation markers prevent blindly repeating ambiguous commands. Failed or uncertain approving commands retain claims until explicit reconciliation; retry-safe remote failure does not automatically release quantity. Workflow finish uses the same PO lock when changing claim ownership/state.

RECEIVED GRN cancellation checks accepted capacity after removing that receipt. It returns GRN_QUANTITY_RESERVED (409) if active claims would lose their backing stock. A receipt with no relevant active claims is still cancellable. DRAFT cancellation keeps its prior behavior. This is not a returns/credit inventory adjustment module.

## Errors and limitations

- INSUFFICIENT_RECEIVED_QUANTITY (409): another claim, absent receipt or PO quantity prevents approval. No approving intent or remote task completion is dispatched by that request.
- UNRESOLVED_INVOICE_QUANTITY / INVALID_QUANTITY_POLICY (409): correct mapping/evidence through a reviewed process before approval. The current release still has no general correction/rematch API; reject/request corrected vendor documents where appropriate.
- GRN_QUANTITY_RESERVED (409): resolve pending allocations instead of deleting their stock evidence.
- Existing approved over-allocation is not automatically repaired or relabelled. An operator must review historical inconsistencies; this change preserves their audit evidence.
- Matching allocates physical stock on first evaluation, so a later invoice may need to wait while an earlier exception is resolved. A release does not rewrite the waiting invoice's saved result; a reviewed rematch feature remains separate work.
- Direct SQL writers must honor the PO lock and the claim rules. Administrative corruption is outside supported business writes and remains subject to native audit verification.

## Validation

Unit regressions cover approved REVIEW_REQUIRED results, pending effective claims and recovery refusing remote actions when capacity is invalid. HTTP contracts expose quantity conflicts as 409. Existing workflow routing fixtures now include real accepted stock and an explicit quantity tolerance; their synthetic discrepancy snapshots still test routing, not parser/matching correctness.

`node infra/workflow/validate-quantity-reservations.cjs` runs seven scenarios through actual Keycloak, APISIX, PostgreSQL, Flowable and native audit verification:

1. Approve a price exception; later invoice cannot reuse stock; original matching snapshot and native proof remain intact.
2. Two zero-allocation exceptions, later actual receipt, simultaneous approvals with a database PO-lock barrier: one claim succeeds; intermediate approval holds stock and prevents GRN cancellation.
3. Rejection releases pending physical allocation and retains sealed history.
4. Credit-note request releases allocation without pretending a vendor message/payment was executed.
5. Real Flowable completion followed by a fixture-scoped PostgreSQL sync failure holds quantity; explicit historic-marker recovery preserves the operation and audit proof.
6. Unresolved item mapping cannot create an approving intent or dispatch a completion.
7. An unallocated received GRN remains cancellable.

Document setup is synthetic SQL via the existing matching fixture helper; actual matching and workflow APIs are never mocked. The temporary failure trigger targets only the test's own task and is removed in finally. No database reset or deletion of native ledger/audit history is performed. The script keeps identifiable synthetic records and uses the documented default finance threshold. It retries only 429 gateway quota rejection, never an ambiguous financial operation. Run fault injection only on an isolated development/CI environment.

CI executes this script after immutable-audit acceptance. Normally the operator CLI runs inside the API container. Local host-API validation can set QUANTITY_OPERATOR_ON_HOST=true with the same private service environment; that is an operator test configuration, not a production bypass.
