-- ==============================================================================
-- Migration: 009_add_po_optimistic_lock.sql
-- Description: Add optimistic locking version column to purchase_orders and atomic PO number sequence
-- ==============================================================================

-- 1. Add optimistic locking version column to purchase_orders
ALTER TABLE purchase_orders
ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_po_version'
    ) THEN
        ALTER TABLE purchase_orders ADD CONSTRAINT chk_po_version CHECK (version >= 1);
    END IF;
END $$;

-- 2. Create atomic sequence for deterministic, concurrency-safe PO numbers
CREATE SEQUENCE IF NOT EXISTS purchase_order_number_seq START WITH 1 INCREMENT BY 1;
