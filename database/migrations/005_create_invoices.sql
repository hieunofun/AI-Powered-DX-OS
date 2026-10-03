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
    po_item_id UUID REFERENCES purchase_order_items(id) ON DELETE SET NULL,
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
