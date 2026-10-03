-- ==============================================================================
-- Migration: 008_create_indexes.sql
-- Description: Create targeted performance indexes for foreign keys and lookup queries
-- ==============================================================================

-- Purchase Orders & Items
CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier_id ON purchase_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(status);
CREATE INDEX IF NOT EXISTS idx_purchase_order_items_po_id ON purchase_order_items(purchase_order_id);

-- Goods Receipts & Items
CREATE INDEX IF NOT EXISTS idx_goods_receipts_po_id ON goods_receipts(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_goods_receipts_status ON goods_receipts(status);
CREATE INDEX IF NOT EXISTS idx_goods_receipt_items_grn_id ON goods_receipt_items(goods_receipt_id);
CREATE INDEX IF NOT EXISTS idx_goods_receipt_items_po_item_id ON goods_receipt_items(purchase_order_item_id);

-- Invoices & Items
CREATE INDEX IF NOT EXISTS idx_invoices_supplier_id ON invoices(supplier_id);
CREATE INDEX IF NOT EXISTS idx_invoices_po_id ON invoices(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_po_item_id ON invoice_items(po_item_id);

-- Matching Results & Items
CREATE INDEX IF NOT EXISTS idx_match_results_invoice_id ON match_results(invoice_id);
CREATE INDEX IF NOT EXISTS idx_match_results_po_id ON match_results(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_match_results_status ON match_results(status);
CREATE INDEX IF NOT EXISTS idx_match_result_items_result_id ON match_result_items(match_result_id);
CREATE INDEX IF NOT EXISTS idx_match_result_items_inv_item_id ON match_result_items(invoice_item_id);

-- Approval Cases
CREATE INDEX IF NOT EXISTS idx_approval_cases_invoice_id ON approval_cases(invoice_id);
CREATE INDEX IF NOT EXISTS idx_approval_cases_status ON approval_cases(status);

-- Audit Records
CREATE INDEX IF NOT EXISTS idx_audit_records_entity ON audit_records(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_records_created_at ON audit_records(created_at);
