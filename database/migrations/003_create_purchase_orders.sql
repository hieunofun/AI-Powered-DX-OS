-- ==============================================================================
-- Migration: 003_create_purchase_orders.sql
-- Description: Create purchase_orders and purchase_order_items tables with strict numerical precision
-- ==============================================================================

CREATE TABLE IF NOT EXISTS purchase_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    po_number VARCHAR(50) NOT NULL,
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    currency CHAR(3) NOT NULL DEFAULT 'VND',
    status VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
    order_date DATE NOT NULL,
    expected_delivery_date DATE,
    subtotal NUMERIC(18,2) NOT NULL DEFAULT 0.00,
    tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0.00,
    total_amount NUMERIC(18,2) NOT NULL DEFAULT 0.00,
    cancelled_at TIMESTAMPTZ,
    cancelled_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_purchase_orders_po_number UNIQUE (po_number),
    CONSTRAINT chk_po_status CHECK (status IN ('DRAFT', 'ISSUED', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'CLOSED', 'CANCELLED')),
    CONSTRAINT chk_po_subtotal CHECK (subtotal >= 0),
    CONSTRAINT chk_po_tax_amount CHECK (tax_amount >= 0),
    CONSTRAINT chk_po_total_amount CHECK (total_amount >= 0)
);

CREATE TRIGGER trg_purchase_orders_updated_at
BEFORE UPDATE ON purchase_orders
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS purchase_order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
    line_number INTEGER NOT NULL,
    sku VARCHAR(100),
    description TEXT NOT NULL,
    ordered_quantity NUMERIC(18,4) NOT NULL,
    unit_price NUMERIC(18,4) NOT NULL,
    tax_rate NUMERIC(7,4) NOT NULL DEFAULT 0.0000,
    line_subtotal NUMERIC(18,2) NOT NULL,
    tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0.00,
    line_total NUMERIC(18,2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_po_item_line UNIQUE (purchase_order_id, line_number),
    CONSTRAINT chk_po_item_line_number CHECK (line_number > 0),
    CONSTRAINT chk_po_item_ordered_quantity CHECK (ordered_quantity > 0),
    CONSTRAINT chk_po_item_unit_price CHECK (unit_price >= 0),
    CONSTRAINT chk_po_item_tax_rate CHECK (tax_rate >= 0),
    CONSTRAINT chk_po_item_line_subtotal CHECK (line_subtotal >= 0),
    CONSTRAINT chk_po_item_tax_amount CHECK (tax_amount >= 0),
    CONSTRAINT chk_po_item_line_total CHECK (line_total >= 0)
);

CREATE TRIGGER trg_purchase_order_items_updated_at
BEFORE UPDATE ON purchase_order_items
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
