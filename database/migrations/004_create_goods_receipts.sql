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
    CONSTRAINT chk_grn_status CHECK (status IN ('DRAFT', 'RECEIVED', 'CANCELLED')),
    CONSTRAINT chk_grn_cancellation CHECK (
        (status != 'CANCELLED' AND cancelled_at IS NULL AND cancelled_reason IS NULL)
        OR
        (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND trim(COALESCE(cancelled_reason, '')) != '')
    )
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

-- -----------------------------------------------------------------------------
-- Consistency Check: GRN Item must reference PO Item of the same Purchase Order
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_grn_item_po_consistency()
RETURNS TRIGGER AS $$
DECLARE
    v_grn_po_id UUID;
    v_po_item_po_id UUID;
BEGIN
    SELECT purchase_order_id INTO v_grn_po_id
    FROM goods_receipts
    WHERE id = NEW.goods_receipt_id;

    SELECT purchase_order_id INTO v_po_item_po_id
    FROM purchase_order_items
    WHERE id = NEW.purchase_order_item_id;

    IF v_grn_po_id IS DISTINCT FROM v_po_item_po_id THEN
        RAISE EXCEPTION 'Cross-PO integrity violation: goods_receipt_item (PO item %) does not belong to parent goods_receipt purchase_order (%)',
            NEW.purchase_order_item_id, v_grn_po_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_grn_item_po_consistency
BEFORE INSERT OR UPDATE OF goods_receipt_id, purchase_order_item_id
ON goods_receipt_items
FOR EACH ROW
EXECUTE FUNCTION check_grn_item_po_consistency();

CREATE OR REPLACE FUNCTION check_grn_parent_po_consistency()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id THEN
        IF EXISTS (
            SELECT 1
            FROM goods_receipt_items gri
            JOIN purchase_order_items poi ON gri.purchase_order_item_id = poi.id
            WHERE gri.goods_receipt_id = NEW.id
              AND poi.purchase_order_id IS DISTINCT FROM NEW.purchase_order_id
        ) THEN
            RAISE EXCEPTION 'Cross-PO integrity violation: cannot change goods_receipt purchase_order_id because child items reference another purchase_order'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_grn_parent_po_consistency
BEFORE UPDATE OF purchase_order_id
ON goods_receipts
FOR EACH ROW
EXECUTE FUNCTION check_grn_parent_po_consistency();
