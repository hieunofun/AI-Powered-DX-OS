# SmartProcure-Pay Domain Business Rules (v1)

This document establishes the official business domain rules governing the Procure-to-Pay (P2P) lifecycle, 3-Way Reconciliation, Exception Approval, and Audit Persistence tracking for the **SmartProcure-Pay** platform.

---

## 1. Purchase Order (PO) Rules

1. **Entity Association**:
   - Every Purchase Order belongs to exactly one verified Supplier (`supplier_id`).
   - A Purchase Order contains one or more line items (`purchase_order_items`).
   - Every PO defines an ISO-4217 3-character transaction currency (`currency`, e.g., `VND`, `USD`).
2. **Delivery & Invoicing Lifecycle**:
   - A PO can be fulfilled through multiple deliveries (partial shipments) recorded via separate Goods Receipt Notes (GRNs).
   - A PO can be billed through multiple partial or milestone Invoices.
3. **Immutability & Deletion Policy**:
   - Hard deletion (`DELETE`) of a Purchase Order is strictly prohibited once linked to downstream business documents (GRNs, Invoices, Match Results).
   - Cancellation is managed via status transitions (`status = 'CANCELLED'`) and audit timestamps (`cancelled_at`, `cancelled_reason`).
4. **PO Status Lifecycle**:
   - `DRAFT`: Initial creation and item specification.
   - `ISSUED`: Approved and officially transmitted to the vendor.
   - `PARTIALLY_RECEIVED`: At least one GRN has recorded partial delivery.
   - `FULLY_RECEIVED`: Total accepted goods match ordered quantities.
   - `CLOSED`: All financial and physical obligations fulfilled.
   - `CANCELLED`: Order formally voided prior to completion.

---

## 2. Goods Receipt Note (GRN) Rules

1. **PO Reference & Line Association**:
   - Every GRN is linked to a single Purchase Order (`purchase_order_id`).
   - Each GRN line item (`goods_receipt_items`) MUST reference a specific PO line item (`purchase_order_item_id`) that belongs to the exact same Purchase Order as the parent GRN. Cross-PO item references are strictly rejected at the database level by validation triggers (`trg_check_grn_item_po_consistency` and `trg_check_grn_parent_po_consistency`).
2. **Quantity Integrity**:
   - `received_quantity` must be strictly positive (`> 0`). Negative or zero receipt entries are rejected.
   - `accepted_quantity` (`>= 0`) represents undamaged goods accepted into inventory.
   - `rejected_quantity` (`>= 0`) represents damaged or non-conforming goods rejected at inspection.
   - **Conservation Constraint**: `accepted_quantity + rejected_quantity <= received_quantity`.
3. **Partial Fulfillment**:
   - Partial deliveries are fully supported. Received quantity on a single GRN item may be less than the PO item's ordered quantity.
   - Only accepted quantities in `RECEIVED` GRNs contribute to the matching ceiling. `DRAFT`, `CANCELLED`, gross received and rejected quantities do not contribute.

---

## 3. Invoice Ingestion Rules

1. **PO Binding (MVP Scope)**:
   - For MVP v1, each Invoice is associated with exactly one Purchase Order (`purchase_order_id`) and one Supplier (`supplier_id`).
   - Multiple Invoices may reference the same PO (accommodating progressive billing and partial shipments).
2. **Line Item Association**:
   - At raw ingestion / OCR extraction, an invoice item may not yet be deterministically mapped to a PO line item.
   - Therefore, `po_item_id` in `invoice_items` is **nullable**. Issue #8 resolves exact existing references, normalized SKU or (only when SKU is absent) normalized description. Semantic/fuzzy matching and manual reconciliation remain future scope.
   - When `po_item_id` IS provided, database triggers (`trg_check_invoice_item_po_consistency` and `trg_check_invoice_parent_po_consistency`) guarantee that the referenced PO line item belongs to the exact same Purchase Order as the parent Invoice.
3. **Duplicate Prevention**:
   - Invoices are uniquely identified per supplier by exact database constraint:
     $$\text{UNIQUE}(\text{supplier\_id}, \text{invoice\_number})$$
   - **Current Issue #2 Guarantee**: The PostgreSQL `UNIQUE (supplier_id, invoice_number)` constraint enforces exact binary (case-sensitive and whitespace-sensitive) uniqueness at the database level. For example, submitting `INV-001` twice for the same supplier is blocked, while `inv-001` or `INV 001` would not be considered identical by PostgreSQL's standard binary equality.
   - **Ingestion Normalization (Issue #7)**: NFKC → trim → uppercase → remove whitespace, ASCII hyphens and underscores. `INV-001` / `inv-001` / `INV 001` / `INV_001` become `INV001`, while `/` remains meaningful. A partial unique index protects non-NULL `(supplier_id, invoice_number_normalized)` identities alongside exact uniqueness. Old rows remain unchanged and are compared canonically during ingestion; audited backfill must resolve legacy collisions.
4. **Invoice Status Lifecycle**:
   - `RECEIVED`: Document ingested (raw PDF, XML, or e-invoice payload).
   - `PARSED`: Line items extracted into structured relational entities.
   - `PENDING_MATCH`: Ready for 3-Way Matching engine evaluation.
   - `MATCHED`: Successfully reconciled within tolerance policies.
   - `EXCEPTION`: Discrepancy detected (price, quantity, tax, or supplier mismatch).
   - `APPROVED`: Exception resolved and authorized by a designated approver.
   - `READY_FOR_PAYMENT`: Cleared for disbursement.
   - `REJECTED`: Permanently declined due to unresolvable discrepancy or fraud indicators.
   - `CANCELLED`: Voided by buyer or issuer.

---

## 4. Quantity Math & Available-to-Invoice Rule

The platform enforces deterministic quantity ceilings to eliminate over-billing risks:

$$\text{Available to Invoice} = \sum (\text{Valid Accepted Received Quantity}) - \sum (\text{Previous Valid Invoiced Quantity})$$

### Concrete Reference Scenario

| Stage | Document | Item | Quantity | Cumulative Received | Invoiced to Date | Available to Invoice | Outcome |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **Order** | `PO-2026-001` | Mực in HP 85A | 100 | 0 | 0 | 0 | Baseline |
| **Receipt 1** | `GRN-001` | Mực in HP 85A | 60 | 60 | 0 | 60 | Received |
| **Receipt 2** | `GRN-002` | Mực in HP 85A | 38 | 98 | 0 | 98 | Partial shipment total = 98 |
| **Invoice 1** | `INV-2026-001` | Mực in HP 85A | 60 | 98 | 60 | 38 | Matched & cleared |
| **Invoice 2A** | `INV-2026-002` (Candidate) | Mực in HP 85A | 38 | 98 | 60 | 38 | **VALID (Match PASS)** |
| **Invoice 2B** | `INV-2026-002` (Over-billed) | Mực in HP 85A | 40 | 98 | 60 | 38 | **BLOCKED (Variance +2)** |

Issue #8 (`3WM-1.0`) makes the base rule concrete: previous consumption counts only other invoices with `PASSED` match results in `MATCHED`, `APPROVED` or `READY_FOR_PAYMENT`. The current invoice and all invalid/unmatched states are excluded. Legacy `MATCHED` rows without a PASSED result do not qualify automatically.

The effective ceiling is `max(0, min(acceptedReceived - previousValidInvoiced, orderedQuantity * (1 + quantityTolerancePercent / 100) - previousValidInvoiced))`. Tolerance never creates received stock. Split invoice lines aggregate per PO item, then allocate in ascending line order. Valid partial invoices need not equal the full PO quantity. See [the matching module](THREE_WAY_MATCHING_MODULE.md) for exact evidence fields and concurrency guarantees.

---

## 5. Financial & Numerical Precision Standards

To eliminate floating-point rounding errors and ensure compliance with accounting standards (VAS / IFRS):

| Measure | Data Type | Check Constraints | Rationale |
| :--- | :--- | :--- | :--- |
| **Quantities** | `NUMERIC(18, 4)` | `> 0` (orders, receipts, invoices) | Supports fractional units (meters, kilograms, liters). |
| **Unit Prices** | `NUMERIC(18, 4)` | `>= 0` | Micro-currency precision for high-volume commodities. |
| **Amounts / Totals** | `NUMERIC(18, 2)` | `>= 0` | Standard two-decimal currency precision (VND, USD, EUR). |
| **Tax Rates** | `NUMERIC(7, 4)` | `>= 0` | Exact fractional percentages (e.g. `0.0800` for 8%, `0.1000` for 10%). |
| **Currency Code** | `CHAR(3)` | ISO-4217 uppercase standard | Currency identifier consistency. |

---

## 6. Matching Policy & Tolerance Configuration

Matching rules operate on configurable tolerance thresholds stored in `matching_policies`:

1. **Quantity Tolerance (`quantity_tolerance_percent`)**:
   - Default: `0.00%` (No over-PO quantity allowance; partial invoices remain valid within physically accepted availability).
2. **Price Tolerance (`price_tolerance_percent`)**:
   - Default: `1.00%` (Permits minor price rounding variances up to 1%).
3. **Tax Tolerance (`tax_tolerance_percent`)**:
   - Default: `0.00` percentage points. Compare `abs(invoiceTaxRate - poTaxRate) * 100`; 10% versus 8% differs by 2 points.
4. **Total Tolerance (`total_tolerance_percent`, migration 012)**:
   - Default: `0.00%`. Compare invoice header amounts with its own structured line sums and conservation, never with the full PO total for partial invoices.

There is at most one active policy. Every result snapshots all four tolerances, policy code and `3WM-1.0` so later admin edits do not alter historical evidence.

---

## 7. Hard-Rule Discrepancy Categories

The relational schema stores structured discrepancy vectors evaluated during 3-Way Matching:

1. **Supplier Mismatch**: `invoice.supplier_id != po.supplier_id`, plus shared Issue #7 seller tax-code normalization. Missing/mismatched seller tax codes have separate codes; structured seller legal-name comparison is unavailable.
2. **Currency Mismatch**: `invoice.currency != po.currency`.
3. **Unit Price Variance**: `abs(invoice_item.unit_price - po_item.unit_price) * 100 > po_item.unit_price * price_tolerance`. Zero PO price permits zero invoice price only.
4. **Quantity Mismatch**: `invoice_item.quantity > available_to_invoice`.
5. **Tax Mismatch**: Absolute tax-rate difference in percentage points exceeds policy tolerance.
6. **Total Mismatch**: Declared invoice subtotal/tax/total diverges from its own structured line sums or header/line conservation beyond total tolerance.
7. **Duplicate Invoice**: Resubmission of existing `(supplier_id, invoice_number)`.

Issue #8 completes `PARSED → PENDING_MATCH → MATCHED/PASSED` or `EXCEPTION/REVIEW_REQUIRED` atomically, with one result per invoice and one result line per invoice item. Missing GRN, unrecognized/ambiguous items and description discrepancies join the document/financial codes in a unique stable priority list. Business mismatches return HTTP 200. Invoice then PO row locks prevent repeat results and double consumption; technical errors roll back results, mappings, statuses and audits. No approval case or `APPROVED`/`READY_FOR_PAYMENT` transition is implemented here.

---

## 8. Invoice workflow (Issue #9, WF-1.0)

Clean `MATCHED/PASSED` invoices use STP to `READY_FOR_PAYMENT` without an approval case by default. Workflow policy cap NULL means all clean invoices; a non-null cap admits totals <= cap and routes higher totals to finance approval. `READY_FOR_PAYMENT` is clearance only, with no payment execution.

`EXCEPTION/REVIEW_REQUIRED` invoices retain `EXCEPTION` throughout review. `DISCREPANCY_REVIEW` is workflow/task state, not an invoice status. Every required role is reviewed in deterministic `warehouse → buyer → accountant` order; a snapshotted total >= finance threshold (`100000000.00` by default) adds `finance_manager`. All comparisons use decimal strings. Flowable orchestrates tasks; PostgreSQL records immutable matching/policy snapshots, decisions, invoice states and audits. Matching is not rerun.

Final approval audits `EXCEPTION → APPROVED → READY_FOR_PAYMENT`. Rejection ends case/invoice at `REJECTED`. A credit-note request ends the case at `CREDIT_NOTE_REQUESTED` and keeps the invoice `EXCEPTION`, without fabricating a credit note. Approve with adjustment records a mandatory rationale without rewriting financial fields. Durable operation intents and explicit reconciliation cover the separate PostgreSQL/Flowable transactions. See [Invoice Workflow Module](INVOICE_WORKFLOW_MODULE.md) for roles, recovery and limitations. Issue #10 adds sealing of these terminal outcomes without changing workflow routing or financial values.

## 10. Finalized audit evidence (Issue #10)

Seal eligibility begins only at `READY_FOR_PAYMENT` (clean STP or approved exception), `REJECTED` (workflow rejection), or invoice `EXCEPTION` with terminal case `CREDIT_NOTE_REQUESTED`. The latter package's final business state is `CREDIT_NOTE_REQUESTED`. A completed persisted Issue #8 match result is required. `MATCHED`, ordinary active `EXCEPTION`, and STARTING/PENDING cases are not finalized.

Each supported terminal transaction captures an ordered business snapshot and durable sealing marker in the same PostgreSQL transaction. After commit, automatic package construction and ImmuDB sealing are attempted. No remote ledger call occurs inside the business transaction. An outage leaves the marker/package/operation discoverable for explicit reconciliation; it does not fabricate a transaction receipt or undo the business outcome. Historical backfill is explicit and labeled `BACKFILL` because it cannot prove uncaptured earlier values.

The package seals the actual persisted match, workflow decisions, task history, policy snapshots and raw-file SHA-256 references. It never reruns matching, fabricates a decision or embeds raw invoice bytes. Canonical financial values remain exact strings; the business Merkle root and full-package SHA-256 are separate hashes.

PostgreSQL remains mutable. Package triggers guard historical evidence, while ImmuDB is the independent tamper-evident ledger. Verification independently checks persisted package hashes, current relational evidence, ledger identity and actual client-side cryptographic proofs. Changed business evidence yields `TAMPERED`; inconsistent ledger evidence or failed proof yields `LEDGER_MISMATCH`. Neither result silently reseals history. "Cryptographically sealed/verifiable" does not mean a legal/PKI digital signature. Verification and JSON/PDF exports require admin, accountant or finance_manager; manual recovery requires admin. See [Immutable Audit Module](IMMUTABLE_AUDIT_MODULE.md).

## 9. Data Retention & Integrity (Non-Destructive Governance)

1. **No Cascading Deletions on Business Records**:
   - `ON DELETE RESTRICT` is enforced across 100% of foreign keys linking `suppliers`, `purchase_orders`, `purchase_order_items`, `goods_receipts`, `goods_receipt_items`, `invoices`, `invoice_items`, `match_results`, `match_result_items`, `approval_cases`, and `audit_records`.
   - Deleting a supplier with linked purchase orders is rejected by the database engine.
   - Deleting a `purchase_order_item` referenced by an `invoice_item` (via `po_item_id`) or `match_result_items` is strictly rejected by `ON DELETE RESTRICT`.
2. **Soft Deletion & Cancellation Metadata Integrity**:
   - Business cancellations preserve document records for regulatory auditability.
   - Mandatory cancellation metadata enforced by database CHECK constraints (`chk_po_cancellation`, `chk_grn_cancellation`, `chk_invoice_cancellation`):
     - When `status = 'CANCELLED'`: `cancelled_at TIMESTAMPTZ` MUST NOT be NULL, and `cancelled_reason TEXT` MUST NOT be NULL or blank (`trim(cancelled_reason) != ''`).
     - When `status != 'CANCELLED'`: `cancelled_at` and `cancelled_reason` MUST be NULL.
3. **Audit Trail Persistence Foundation**:
   - All state transitions and reconciliation decisions generate persistent audit entries in `audit_records`.
   - *Note on Immutability*: Issue #2 provides the relational database persistence foundation (`payload_hash`, `actor_subject`, `entity_type`, `metadata`). Cryptographic sealing and tamper-evident append-only guarantees will be integrated in Issue #10 using ImmuDB.
