-- ==============================================================================
-- Migration: 010_extend_goods_receipts.sql
-- Description: Add lot tracking, GRN numbering sequence, and warehouse over-delivery policy
-- ==============================================================================

-- 1. Lot / Batch Tracking: Add nullable lot_number to goods_receipt_items
ALTER TABLE goods_receipt_items
ADD COLUMN IF NOT EXISTS lot_number VARCHAR(100);

-- 2. Concurrency-Safe GRN Number Generation Sequence
CREATE SEQUENCE IF NOT EXISTS goods_receipt_number_seq
START WITH 1
INCREMENT BY 1;

-- 3. Configurable Warehouse Over-Delivery Policy Table
CREATE TABLE IF NOT EXISTS goods_receipt_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_code VARCHAR(50) NOT NULL UNIQUE,
    over_delivery_tolerance_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_grn_policy_tolerance CHECK (
        over_delivery_tolerance_percent >= 0.00 AND over_delivery_tolerance_percent <= 100.00
    )
);

-- Trigger for auto-updating updated_at timestamp on policy modification
CREATE TRIGGER trg_goods_receipt_policies_updated_at
BEFORE UPDATE ON goods_receipt_policies
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- Partial unique index ensuring exactly one active warehouse receipt policy exists
CREATE UNIQUE INDEX IF NOT EXISTS uq_goods_receipt_policies_active
ON goods_receipt_policies (is_active)
WHERE is_active = true;

-- Seed default policy: 0.00% tolerance, active
INSERT INTO goods_receipt_policies (policy_code, over_delivery_tolerance_percent, is_active)
VALUES ('DEFAULT', 0.00, true)
ON CONFLICT (policy_code) DO NOTHING;
