-- ==============================================================================
-- Migration: 006_create_matching.sql
-- Description: Create matching_policies, match_results, and match_result_items tables
-- ==============================================================================

CREATE TABLE IF NOT EXISTS matching_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_code VARCHAR(50) NOT NULL,
    description TEXT,
    quantity_tolerance_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    price_tolerance_percent NUMERIC(5,2) NOT NULL DEFAULT 1.00,
    tax_tolerance_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_matching_policies_code UNIQUE (policy_code),
    CONSTRAINT chk_qty_tolerance CHECK (quantity_tolerance_percent >= 0 AND quantity_tolerance_percent <= 100),
    CONSTRAINT chk_price_tolerance CHECK (price_tolerance_percent >= 0 AND price_tolerance_percent <= 100),
    CONSTRAINT chk_tax_tolerance CHECK (tax_tolerance_percent >= 0 AND tax_tolerance_percent <= 100)
);

CREATE TRIGGER trg_matching_policies_updated_at
BEFORE UPDATE ON matching_policies
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS match_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
    matching_policy_id UUID REFERENCES matching_policies(id) ON DELETE RESTRICT,
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    overall_confidence NUMERIC(5,2),
    supplier_match BOOLEAN NOT NULL DEFAULT false,
    currency_match BOOLEAN NOT NULL DEFAULT false,
    quantity_variance NUMERIC(18,4) NOT NULL DEFAULT 0.0000,
    price_variance NUMERIC(18,4) NOT NULL DEFAULT 0.0000,
    tax_variance NUMERIC(18,2) NOT NULL DEFAULT 0.00,
    total_variance NUMERIC(18,2) NOT NULL DEFAULT 0.00,
    rule_version VARCHAR(20) NOT NULL DEFAULT '1.0',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_match_result_status CHECK (status IN ('PENDING', 'PASSED', 'FAILED', 'REVIEW_REQUIRED')),
    CONSTRAINT chk_match_result_confidence CHECK (overall_confidence IS NULL OR (overall_confidence >= 0 AND overall_confidence <= 100))
);

-- -----------------------------------------------------------------------------
-- Consistency Check: match_results must reference the same PO as its invoice
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_match_result_document_consistency()
RETURNS TRIGGER AS $$
DECLARE
    v_inv_po_id UUID;
BEGIN
    SELECT purchase_order_id INTO v_inv_po_id
    FROM invoices
    WHERE id = NEW.invoice_id;

    IF v_inv_po_id IS DISTINCT FROM NEW.purchase_order_id THEN
        RAISE EXCEPTION 'Cross-document integrity violation: match_results purchase_order_id (%) does not match invoice parent purchase_order_id (%)',
            NEW.purchase_order_id, v_inv_po_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_match_result_document_consistency
BEFORE INSERT OR UPDATE OF invoice_id, purchase_order_id
ON match_results
FOR EACH ROW
EXECUTE FUNCTION check_match_result_document_consistency();

CREATE TABLE IF NOT EXISTS match_result_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    match_result_id UUID NOT NULL REFERENCES match_results(id) ON DELETE RESTRICT,
    invoice_item_id UUID NOT NULL REFERENCES invoice_items(id) ON DELETE RESTRICT,
    purchase_order_item_id UUID REFERENCES purchase_order_items(id) ON DELETE RESTRICT,
    matched_received_quantity NUMERIC(18,4) NOT NULL DEFAULT 0.0000,
    quantity_variance NUMERIC(18,4) NOT NULL DEFAULT 0.0000,
    unit_price_variance NUMERIC(18,4) NOT NULL DEFAULT 0.0000,
    semantic_confidence NUMERIC(5,2),
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    reason_code VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_match_result_item_status CHECK (status IN ('PENDING', 'MATCHED', 'MISMATCHED', 'EXCEPTION')),
    CONSTRAINT chk_match_item_matched_qty CHECK (matched_received_quantity >= 0),
    CONSTRAINT chk_match_item_confidence CHECK (semantic_confidence IS NULL OR (semantic_confidence >= 0 AND semantic_confidence <= 100))
);

-- -----------------------------------------------------------------------------
-- Consistency Check: match_result_items must reference items of the match_result docs
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_match_result_item_consistency()
RETURNS TRIGGER AS $$
DECLARE
    v_match_inv_id UUID;
    v_match_po_id UUID;
    v_item_inv_id UUID;
    v_item_po_id UUID;
BEGIN
    SELECT invoice_id, purchase_order_id INTO v_match_inv_id, v_match_po_id
    FROM match_results
    WHERE id = NEW.match_result_id;

    SELECT invoice_id INTO v_item_inv_id
    FROM invoice_items
    WHERE id = NEW.invoice_item_id;

    IF v_match_inv_id IS DISTINCT FROM v_item_inv_id THEN
        RAISE EXCEPTION 'Cross-document integrity violation: match_result_item invoice_item (%) belongs to invoice %, expected %',
            NEW.invoice_item_id, v_item_inv_id, v_match_inv_id
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.purchase_order_item_id IS NOT NULL THEN
        SELECT purchase_order_id INTO v_item_po_id
        FROM purchase_order_items
        WHERE id = NEW.purchase_order_item_id;

        IF v_match_po_id IS DISTINCT FROM v_item_po_id THEN
            RAISE EXCEPTION 'Cross-document integrity violation: match_result_item purchase_order_item (%) belongs to PO %, expected %',
                NEW.purchase_order_item_id, v_item_po_id, v_match_po_id
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_match_result_item_consistency
BEFORE INSERT OR UPDATE OF match_result_id, invoice_item_id, purchase_order_item_id
ON match_result_items
FOR EACH ROW
EXECUTE FUNCTION check_match_result_item_consistency();
