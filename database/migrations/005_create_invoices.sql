-- ==============================================================================
-- Migration: 005_create_invoices.sql
-- Description: Create invoices and invoice_items tables with duplicate protection
-- ==============================================================================

CREATE TABLE IF NOT EXISTS invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_number VARCHAR(100) NOT NULL,
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
    invoice_date DATE NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'VND',
    status VARCHAR(30) NOT NULL DEFAULT 'RECEIVED',
    subtotal NUMERIC(18,2) NOT NULL,
    tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0.00,
    total_amount NUMERIC(18,2) NOT NULL,
    external_file_id VARCHAR(255),
    source_type VARCHAR(50) DEFAULT 'MANUAL_UPLOAD',
    cancelled_at TIMESTAMPTZ,
    cancelled_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_supplier_invoice UNIQUE (supplier_id, invoice_number),
    CONSTRAINT chk_invoice_status CHECK (status IN (
        'RECEIVED', 'PARSED', 'PENDING_MATCH', 'MATCHED',
        'EXCEPTION', 'APPROVED', 'READY_FOR_PAYMENT', 'REJECTED', 'CANCELLED'
    )),
    CONSTRAINT chk_invoice_cancellation CHECK (
        (status != 'CANCELLED' AND cancelled_at IS NULL AND cancelled_reason IS NULL)
        OR
        (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND trim(COALESCE(cancelled_reason, '')) != '')
    ),
    CONSTRAINT chk_invoice_subtotal CHECK (subtotal >= 0),
    CONSTRAINT chk_invoice_tax_amount CHECK (tax_amount >= 0),
    CONSTRAINT chk_invoice_total_amount CHECK (total_amount >= 0)
);

CREATE TRIGGER trg_invoices_updated_at
BEFORE UPDATE ON invoices
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS invoice_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    line_number INTEGER NOT NULL,
    po_item_id UUID REFERENCES purchase_order_items(id) ON DELETE RESTRICT,
    sku VARCHAR(100),
    description TEXT NOT NULL,
    quantity NUMERIC(18,4) NOT NULL,
    unit_price NUMERIC(18,4) NOT NULL,
    tax_rate NUMERIC(7,4) NOT NULL DEFAULT 0.0000,
    line_subtotal NUMERIC(18,2) NOT NULL,
    tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0.00,
    line_total NUMERIC(18,2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_invoice_item_line UNIQUE (invoice_id, line_number),
    CONSTRAINT chk_invoice_item_line_number CHECK (line_number > 0),
    CONSTRAINT chk_invoice_item_quantity CHECK (quantity > 0),
    CONSTRAINT chk_invoice_item_unit_price CHECK (unit_price >= 0),
    CONSTRAINT chk_invoice_item_tax_rate CHECK (tax_rate >= 0),
    CONSTRAINT chk_invoice_item_line_subtotal CHECK (line_subtotal >= 0),
    CONSTRAINT chk_invoice_item_tax_amount CHECK (tax_amount >= 0),
    CONSTRAINT chk_invoice_item_line_total CHECK (line_total >= 0)
);

CREATE TRIGGER trg_invoice_items_updated_at
BEFORE UPDATE ON invoice_items
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Consistency Check: Invoice Item must reference PO Item of the same Purchase Order
-- (when po_item_id IS NOT NULL)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_invoice_item_po_consistency()
RETURNS TRIGGER AS $$
DECLARE
    v_inv_po_id UUID;
    v_po_item_po_id UUID;
BEGIN
    IF NEW.po_item_id IS NOT NULL THEN
        SELECT purchase_order_id INTO v_inv_po_id
        FROM invoices
        WHERE id = NEW.invoice_id;

        SELECT purchase_order_id INTO v_po_item_po_id
        FROM purchase_order_items
        WHERE id = NEW.po_item_id;

        IF v_inv_po_id IS DISTINCT FROM v_po_item_po_id THEN
            RAISE EXCEPTION 'Cross-PO integrity violation: invoice_item (po_item_id %) does not belong to parent invoice purchase_order (%)',
                NEW.po_item_id, v_inv_po_id
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_invoice_item_po_consistency
BEFORE INSERT OR UPDATE OF invoice_id, po_item_id
ON invoice_items
FOR EACH ROW
EXECUTE FUNCTION check_invoice_item_po_consistency();

CREATE OR REPLACE FUNCTION check_invoice_parent_po_consistency()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id THEN
        IF EXISTS (
            SELECT 1
            FROM invoice_items ii
            JOIN purchase_order_items poi ON ii.po_item_id = poi.id
            WHERE ii.invoice_id = NEW.id
              AND poi.purchase_order_id IS DISTINCT FROM NEW.purchase_order_id
        ) THEN
            RAISE EXCEPTION 'Cross-PO integrity violation: cannot change invoice purchase_order_id because child items reference another purchase_order'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_invoice_parent_po_consistency
BEFORE UPDATE OF purchase_order_id
ON invoices
FOR EACH ROW
EXECUTE FUNCTION check_invoice_parent_po_consistency();
