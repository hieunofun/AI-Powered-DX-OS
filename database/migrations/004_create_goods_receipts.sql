-- ==============================================================================
-- Migration: 004_create_goods_receipts.sql
-- Description: Create goods_receipts and goods_receipt_items with quantity conservation checks
-- ==============================================================================

CREATE TABLE IF NOT EXISTS goods_receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    grn_number VARCHAR(50) NOT NULL,
    purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
    reference_note TEXT,
    cancelled_at TIMESTAMPTZ,
    cancelled_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_goods_receipts_grn_number UNIQUE (grn_number),
    CONSTRAINT chk_grn_status CHECK (status IN ('DRAFT', 'RECEIVED', 'CANCELLED'))
);

CREATE TRIGGER trg_goods_receipts_updated_at
BEFORE UPDATE ON goods_receipts
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS goods_receipt_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    goods_receipt_id UUID NOT NULL REFERENCES goods_receipts(id) ON DELETE RESTRICT,
    purchase_order_item_id UUID NOT NULL REFERENCES purchase_order_items(id) ON DELETE RESTRICT,
    line_number INTEGER NOT NULL,
    received_quantity NUMERIC(18,4) NOT NULL,
    accepted_quantity NUMERIC(18,4) NOT NULL DEFAULT 0.0000,
    rejected_quantity NUMERIC(18,4) NOT NULL DEFAULT 0.0000,
    damage_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_grn_item_line UNIQUE (goods_receipt_id, line_number),
    CONSTRAINT chk_grn_item_line_number CHECK (line_number > 0),
    CONSTRAINT chk_grn_item_received_quantity CHECK (received_quantity > 0),
    CONSTRAINT chk_grn_item_accepted_quantity CHECK (accepted_quantity >= 0),
    CONSTRAINT chk_grn_item_rejected_quantity CHECK (rejected_quantity >= 0),
    CONSTRAINT chk_grn_item_conservation CHECK (accepted_quantity + rejected_quantity <= received_quantity)
);

CREATE TRIGGER trg_goods_receipt_items_updated_at
BEFORE UPDATE ON goods_receipt_items
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
