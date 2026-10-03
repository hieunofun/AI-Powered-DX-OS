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
   - The cumulative accepted quantity across all GRNs for a given PO item forms the upper threshold for payment clearance.

---

## 3. Invoice Ingestion Rules

1. **PO Binding (MVP Scope)**:
   - For MVP v1, each Invoice is associated with exactly one Purchase Order (`purchase_order_id`) and one Supplier (`supplier_id`).
   - Multiple Invoices may reference the same PO (accommodating progressive billing and partial shipments).
2. **Line Item Association**:
   - At raw ingestion / OCR extraction, an invoice item may not yet be deterministically mapped to a PO line item.
   - Therefore, `po_item_id` in `invoice_items` is **nullable**, allowing progressive resolution via automatic exact matching, semantic embedding matching, or manual accountant reconciliation.
   - When `po_item_id` IS provided, database triggers (`trg_check_invoice_item_po_consistency` and `trg_check_invoice_parent_po_consistency`) guarantee that the referenced PO line item belongs to the exact same Purchase Order as the parent Invoice.
3. **Duplicate Prevention**:
   - Invoices are uniquely identified per supplier by exact database constraint:
     $$\text{UNIQUE}(\text{supplier\_id}, \text{invoice\_number})$$
   - **Current Issue #2 Guarantee**: The PostgreSQL `UNIQUE (supplier_id, invoice_number)` constraint enforces exact binary (case-sensitive and whitespace-sensitive) uniqueness at the database level. For example, submitting `INV-001` twice for the same supplier is blocked, while `inv-001` or `INV 001` would not be considered identical by PostgreSQL's standard binary equality.
   - **Planned Ingestion Normalization (Issue #7)**: Comprehensive string canonicalization (such as collapsing whitespace or normalizing `INV-001` / `inv-001` / `INV 001`) will be implemented during the ingestion pipeline phase in Issue #7 once the canonicalization policy is finalized.
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

*Note: The calculation logic will be executed by the Matching Engine (Issue #8); the schema must persist all quantities with full decimal fidelity.*

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
   - Default: `0.00%` (Zero tolerance for quantity discrepancies; exact match required).
2. **Price Tolerance (`price_tolerance_percent`)**:
   - Default: `1.00%` (Permits minor price rounding variances up to 1%).
3. **Tax Tolerance (`tax_tolerance_percent`)**:
   - Default: `0.00%` (Zero tolerance for statutory tax calculation divergence).

---

## 7. Hard-Rule Discrepancy Categories

The relational schema stores structured discrepancy vectors evaluated during 3-Way Matching:

1. **Supplier Mismatch**: `invoice.supplier_id != po.supplier_id`.
2. **Currency Mismatch**: `invoice.currency != po.currency`.
3. **Unit Price Variance**: `(invoice_item.unit_price - po_item.unit_price) / po_item.unit_price * 100 > price_tolerance`.
4. **Quantity Mismatch**: `invoice_item.quantity > available_to_invoice`.
5. **Tax Mismatch**: Calculated tax diverges beyond tax tolerance.
6. **Total Mismatch**: Invoice total diverges from `subtotal + tax_amount`.
7. **Duplicate Invoice**: Resubmission of existing `(supplier_id, invoice_number)`.

---

## 8. Data Retention & Integrity (Non-Destructive Governance)

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
