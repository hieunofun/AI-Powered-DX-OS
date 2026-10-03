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
    CONSTRAINT chk_qty_tolerance CHECK (quantity_tolerance_percent >= 0),
    CONSTRAINT chk_price_tolerance CHECK (price_tolerance_percent >= 0),
    CONSTRAINT chk_tax_tolerance CHECK (tax_tolerance_percent >= 0)
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

CREATE TABLE IF NOT EXISTS match_result_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    match_result_id UUID NOT NULL REFERENCES match_results(id) ON DELETE RESTRICT,
    invoice_item_id UUID NOT NULL REFERENCES invoice_items(id) ON DELETE RESTRICT,
    purchase_order_item_id UUID REFERENCES purchase_order_items(id) ON DELETE SET NULL,
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
