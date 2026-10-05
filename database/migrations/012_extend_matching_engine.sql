-- Issue #8: preserve migration 006 and historical records; fail on conflicting data.
BEGIN;
DO $$ BEGIN
    IF (SELECT count(*) FROM matching_policies WHERE is_active) > 1 THEN
        RAISE EXCEPTION 'Migration 012 requires at most one active matching policy; review historical policies first';
    END IF;
    IF EXISTS (SELECT invoice_id FROM match_results GROUP BY invoice_id HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'Migration 012 requires one match result per invoice; review historical results first';
    END IF;
END $$;

ALTER TABLE matching_policies ADD COLUMN total_tolerance_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00;
ALTER TABLE matching_policies ADD CONSTRAINT chk_total_tolerance CHECK (total_tolerance_percent BETWEEN 0 AND 100);
CREATE UNIQUE INDEX uq_matching_policies_active ON matching_policies(is_active) WHERE is_active = true;
INSERT INTO matching_policies(policy_code,description,quantity_tolerance_percent,
    price_tolerance_percent,tax_tolerance_percent,total_tolerance_percent,is_active)
SELECT 'MATCH_DEFAULT','Default deterministic 3-way matching policy',0.00,1.00,0.00,0.00,true
WHERE NOT EXISTS (SELECT 1 FROM matching_policies WHERE is_active);

ALTER TABLE match_results
    ADD COLUMN discrepancy_codes TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN policy_snapshot JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN evaluation_duration_ms NUMERIC(12,3),
    ADD COLUMN completed_at TIMESTAMPTZ,
    ADD CONSTRAINT chk_match_evaluation_duration CHECK (evaluation_duration_ms >= 0),
    ADD CONSTRAINT uq_match_result_invoice UNIQUE(invoice_id);
ALTER TABLE match_result_items
    ADD COLUMN tax_rate_variance NUMERIC(7,4) NOT NULL DEFAULT 0,
    ADD COLUMN line_total_variance NUMERIC(18,2) NOT NULL DEFAULT 0,
    ADD COLUMN discrepancy_codes TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN details JSONB NOT NULL DEFAULT '{}',
    ADD CONSTRAINT uq_match_result_invoice_item UNIQUE(match_result_id,invoice_item_id);

-- Migration 008 already covers invoice_items(invoice_id) and individual FKs.
CREATE INDEX IF NOT EXISTS idx_goods_receipts_po_status ON goods_receipts(purchase_order_id,status);
CREATE INDEX IF NOT EXISTS idx_grn_items_po_receipt ON goods_receipt_items(purchase_order_item_id,goods_receipt_id);
CREATE INDEX IF NOT EXISTS idx_match_results_po_status ON match_results(purchase_order_id,status);
CREATE INDEX IF NOT EXISTS idx_match_items_po_result ON match_result_items(purchase_order_item_id,match_result_id);
COMMIT;
