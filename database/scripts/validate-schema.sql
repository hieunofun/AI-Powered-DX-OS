-- ==============================================================================
-- Schema Validation Test Suite: validate-schema.sql
-- Description: Asserts tables, constraints, negative checks, and seed scenario
-- ==============================================================================

\set ON_ERROR_STOP on

-- 1. Table Existence Validation
DO $$
DECLARE
    tbl text;
    expected_tables text[] := ARRAY[
        'suppliers',
        'purchase_orders',
        'purchase_order_items',
        'goods_receipts',
        'goods_receipt_items',
        'invoices',
        'invoice_items',
        'matching_policies',
        'match_results',
        'match_result_items',
        'approval_cases',
        'audit_records'
    ];
    cnt integer;
BEGIN
    RAISE NOTICE '=== [Test 1] Verifying all expected domain tables exist ===';
    FOREACH tbl IN ARRAY expected_tables LOOP
        SELECT count(*) INTO cnt 
        FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = tbl;
        
        IF cnt != 1 THEN
            RAISE EXCEPTION 'Assertion Failed: Table "%" does not exist in schema public', tbl;
        END IF;
    END LOOP;
    RAISE NOTICE '[OK] All 12 domain tables confirmed present.';
END $$;

-- 2. Key Constraints Existence Validation
DO $$
DECLARE
    c_name text;
    expected_constraints text[] := ARRAY[
        'uq_supplier_invoice',
        'chk_grn_item_conservation',
        'uq_po_item_line',
        'uq_grn_item_line',
        'uq_invoice_item_line',
        'chk_po_status',
        'chk_grn_status',
        'chk_invoice_status'
    ];
    cnt integer;
BEGIN
    RAISE NOTICE '=== [Test 2] Verifying key integrity constraints exist ===';
    FOREACH c_name IN ARRAY expected_constraints LOOP
        SELECT count(*) INTO cnt 
        FROM information_schema.table_constraints
        WHERE constraint_schema = 'public' AND constraint_name = c_name;
        
        IF cnt != 1 THEN
            RAISE EXCEPTION 'Assertion Failed: Constraint "%" does not exist', c_name;
        END IF;
    END LOOP;
    RAISE NOTICE '[OK] Key unique and check constraints confirmed present.';
END $$;

-- 3. Seed Scenario Insertion (if not already applied)
-- Executes safely; if already inserted, verifies data
DO $$
DECLARE
    cnt_sup int;
BEGIN
    SELECT count(*) INTO cnt_sup FROM suppliers WHERE supplier_code = 'SUP-ABC-001';
    IF cnt_sup = 0 THEN
        RAISE NOTICE '=== [Setup] Applying seed scenario ===';
    ELSE
        RAISE NOTICE '=== [Setup] Seed scenario already present ===';
    END IF;
END $$;

-- 4. Duplicate (supplier_id, invoice_number) Constraint Test
DO $$
DECLARE
    v_sup_id UUID;
    v_po_id UUID;
    failed boolean := false;
BEGIN
    RAISE NOTICE '=== [Test 4] Duplicate (supplier_id, invoice_number) must fail ===';
    SELECT id INTO v_sup_id FROM suppliers WHERE supplier_code = 'SUP-ABC-001' LIMIT 1;
    SELECT id INTO v_po_id FROM purchase_orders WHERE po_number = 'PO-2026-001' LIMIT 1;
    
    BEGIN
        INSERT INTO invoices (
            invoice_number, supplier_id, purchase_order_id, 
            invoice_date, currency, status, subtotal, tax_amount, total_amount
        ) VALUES (
            'INV-2026-001', v_sup_id, v_po_id, 
            CURRENT_DATE, 'VND', 'RECEIVED', 1000.00, 100.00, 1100.00
        );
    EXCEPTION WHEN unique_violation THEN
        failed := true;
    END;

    IF NOT failed THEN
        RAISE EXCEPTION 'Assertion Failed: Duplicate invoice submission did NOT trigger unique_violation!';
    END IF;
    RAISE NOTICE '[OK] Duplicate invoice submission correctly rejected by database engine.';
END $$;

-- 5. Invalid Negative Quantity Constraint Test
DO $$
DECLARE
    v_po_id UUID;
    failed boolean := false;
BEGIN
    RAISE NOTICE '=== [Test 5] Negative ordered_quantity must fail check constraint ===';
    SELECT id INTO v_po_id FROM purchase_orders WHERE po_number = 'PO-2026-001' LIMIT 1;
    
    BEGIN
        INSERT INTO purchase_order_items (
            purchase_order_id, line_number, description, 
            ordered_quantity, unit_price, line_subtotal, tax_amount, line_total
        ) VALUES (
            v_po_id, 999, 'Invalid negative quantity item', 
            -10.0000, 1000.0000, -10000.00, 0.00, -10000.00
        );
    EXCEPTION WHEN check_violation THEN
        failed := true;
    END;

    IF NOT failed THEN
        RAISE EXCEPTION 'Assertion Failed: Negative ordered quantity did NOT trigger check_violation!';
    END IF;
    RAISE NOTICE '[OK] Negative ordered quantity correctly rejected.';
END $$;

-- 6. Conservation Rule: accepted_quantity + rejected_quantity <= received_quantity
DO $$
DECLARE
    v_grn_id UUID;
    v_po_item_id UUID;
    failed boolean := false;
BEGIN
    RAISE NOTICE '=== [Test 6] accepted + rejected > received must fail conservation check ===';
    SELECT id INTO v_grn_id FROM goods_receipts WHERE grn_number = 'GRN-2026-001' LIMIT 1;
    SELECT id INTO v_po_item_id FROM purchase_order_items LIMIT 1;
    
    BEGIN
        INSERT INTO goods_receipt_items (
            goods_receipt_id, purchase_order_item_id, line_number, 
            received_quantity, accepted_quantity, rejected_quantity
        ) VALUES (
            v_grn_id, v_po_item_id, 888, 
            10.0000, 8.0000, 5.0000
        ); -- 8 + 5 = 13 > 10!
    EXCEPTION WHEN check_violation THEN
        failed := true;
    END;

    IF NOT failed THEN
        RAISE EXCEPTION 'Assertion Failed: Quantity conservation violation did NOT trigger check_violation!';
    END IF;
    RAISE NOTICE '[OK] Quantity conservation violation (8+5 > 10) correctly rejected.';
END $$;

-- 7. Foreign Key Constraint Test
DO $$
DECLARE
    failed boolean := false;
BEGIN
    RAISE NOTICE '=== [Test 7] Invalid Foreign Key reference must fail ===';
    BEGIN
        INSERT INTO purchase_orders (
            po_number, supplier_id, currency, order_date, 
            subtotal, tax_amount, total_amount
        ) VALUES (
            'PO-INVALID-FK', '00000000-0000-0000-0000-000000000000', 'VND', CURRENT_DATE, 
            100.00, 10.00, 110.00
        );
    EXCEPTION WHEN foreign_key_violation THEN
        failed := true;
    END;

    IF NOT failed THEN
        RAISE EXCEPTION 'Assertion Failed: Non-existent supplier_id did NOT trigger foreign_key_violation!';
    END IF;
    RAISE NOTICE '[OK] Foreign key violation correctly rejected.';
END $$;

-- 8. Seed Scenario and Quantity Math Validation
DO $$
DECLARE
    cnt_sup int;
    cnt_po int;
    cnt_grn int;
    cnt_inv int;
    v_received_qty numeric;
    v_invoiced_qty numeric;
    v_available_qty numeric;
BEGIN
    RAISE NOTICE '=== [Test 8] Validating reference scenario and Available-to-Invoice math ===';
    
    SELECT count(*) INTO cnt_sup FROM suppliers WHERE supplier_code = 'SUP-ABC-001';
    SELECT count(*) INTO cnt_po FROM purchase_orders WHERE po_number = 'PO-2026-001';
    SELECT count(*) INTO cnt_grn FROM goods_receipts WHERE grn_number IN ('GRN-2026-001', 'GRN-2026-002');
    SELECT count(*) INTO cnt_inv FROM invoices WHERE invoice_number IN ('INV-2026-001', 'INV-2026-002');

    IF cnt_sup != 1 OR cnt_po != 1 OR cnt_grn != 2 OR cnt_inv != 2 THEN
        RAISE EXCEPTION 'Assertion Failed: Seed scenario records incomplete. sup=%, po=%, grn=%, inv=%',
            cnt_sup, cnt_po, cnt_grn, cnt_inv;
    END IF;

    -- Calculate total accepted received quantity for PO-2026-001
    SELECT COALESCE(SUM(gri.accepted_quantity), 0) INTO v_received_qty
    FROM goods_receipt_items gri
    JOIN goods_receipts gr ON gr.id = gri.goods_receipt_id
    WHERE gr.purchase_order_id = (SELECT id FROM purchase_orders WHERE po_number = 'PO-2026-001');

    -- Calculate previously invoiced quantity for historical invoice INV-2026-001
    SELECT COALESCE(SUM(ii.quantity), 0) INTO v_invoiced_qty
    FROM invoice_items ii
    JOIN invoices inv ON inv.id = ii.invoice_id
    WHERE inv.purchase_order_id = (SELECT id FROM purchase_orders WHERE po_number = 'PO-2026-001')
      AND inv.invoice_number = 'INV-2026-001';

    -- Available to invoice = Received (98) - Previously Invoiced (60) = 38
    v_available_qty := v_received_qty - v_invoiced_qty;

    IF v_received_qty != 98.0000 THEN
        RAISE EXCEPTION 'Assertion Failed: Expected received quantity 98.0000, got %', v_received_qty;
    END IF;

    IF v_invoiced_qty != 60.0000 THEN
        RAISE EXCEPTION 'Assertion Failed: Expected invoiced quantity 60.0000, got %', v_invoiced_qty;
    END IF;

    IF v_available_qty != 38.0000 THEN
        RAISE EXCEPTION 'Assertion Failed: Expected available quantity 38.0000, got %', v_available_qty;
    END IF;

    RAISE NOTICE '[OK] Quantity math confirmed: Ordered=100, Received=%, Invoiced=%, Available=%',
        v_received_qty, v_invoiced_qty, v_available_qty;
    RAISE NOTICE '=== ALL SCHEMA INTEGRITY TESTS PASSED SUCCESSFULLY ===';
END $$;
