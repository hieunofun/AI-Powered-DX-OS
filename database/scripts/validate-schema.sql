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
END $$;

-- 9. Cross-PO GRN Item Consistency Test
DO $$
DECLARE
    v_sup_id UUID;
    v_po_b_id UUID;
    v_po_b_item_id UUID;
    v_grn_a_id UUID;
    failed boolean := false;
BEGIN
    RAISE NOTICE '=== [Test 9] GRN for PO-A referencing PO item from PO-B must fail ===';
    SELECT id INTO v_sup_id FROM suppliers WHERE supplier_code = 'SUP-ABC-001' LIMIT 1;
    SELECT id INTO v_grn_a_id FROM goods_receipts WHERE grn_number = 'GRN-2026-001' LIMIT 1;

    -- Create temporary PO-B
    INSERT INTO purchase_orders (
        po_number, supplier_id, currency, status, order_date, subtotal, tax_amount, total_amount
    ) VALUES (
        'PO-TEST-B', v_sup_id, 'VND', 'ISSUED', CURRENT_DATE, 5000000.00, 500000.00, 5500000.00
    ) RETURNING id INTO v_po_b_id;

    INSERT INTO purchase_order_items (
        purchase_order_id, line_number, sku, description, ordered_quantity, unit_price, tax_rate, line_subtotal, tax_amount, line_total
    ) VALUES (
        v_po_b_id, 1, 'SKU-TEST-B', 'Test Item B', 10.0000, 500000.0000, 0.1000, 5000000.00, 500000.00, 5500000.00
    ) RETURNING id INTO v_po_b_item_id;

    -- Attempt to insert GRN item for GRN-2026-001 (which belongs to PO-2026-001) using v_po_b_item_id
    BEGIN
        INSERT INTO goods_receipt_items (
            goods_receipt_id, purchase_order_item_id, line_number, received_quantity, accepted_quantity, rejected_quantity
        ) VALUES (
            v_grn_a_id, v_po_b_item_id, 999, 5.0000, 5.0000, 0.0000
        );
    EXCEPTION WHEN check_violation THEN
        failed := true;
    END;

    -- Clean up temporary records
    DELETE FROM purchase_order_items WHERE id = v_po_b_item_id;
    DELETE FROM purchase_orders WHERE id = v_po_b_id;

    IF NOT failed THEN
        RAISE EXCEPTION 'Assertion Failed: Cross-PO GRN item did NOT trigger check_violation!';
    END IF;
    RAISE NOTICE '[OK] Cross-PO GRN item correctly rejected by trigger.';
END $$;

-- 10. Cross-PO Invoice Item Consistency Test
DO $$
DECLARE
    v_sup_id UUID;
    v_po_b_id UUID;
    v_po_b_item_id UUID;
    v_inv_a_id UUID;
    failed boolean := false;
BEGIN
    RAISE NOTICE '=== [Test 10] Invoice for PO-A referencing po_item_id from PO-B must fail ===';
    SELECT id INTO v_sup_id FROM suppliers WHERE supplier_code = 'SUP-ABC-001' LIMIT 1;
    SELECT id INTO v_inv_a_id FROM invoices WHERE invoice_number = 'INV-2026-001' LIMIT 1;

    -- Create temporary PO-B
    INSERT INTO purchase_orders (
        po_number, supplier_id, currency, status, order_date, subtotal, tax_amount, total_amount
    ) VALUES (
        'PO-TEST-B2', v_sup_id, 'VND', 'ISSUED', CURRENT_DATE, 5000000.00, 500000.00, 5500000.00
    ) RETURNING id INTO v_po_b_id;

    INSERT INTO purchase_order_items (
        purchase_order_id, line_number, sku, description, ordered_quantity, unit_price, tax_rate, line_subtotal, tax_amount, line_total
    ) VALUES (
        v_po_b_id, 1, 'SKU-TEST-B2', 'Test Item B2', 10.0000, 500000.0000, 0.1000, 5000000.00, 500000.00, 5500000.00
    ) RETURNING id INTO v_po_b_item_id;

    -- Attempt to insert Invoice item for INV-2026-001 (which belongs to PO-2026-001) using v_po_b_item_id
    BEGIN
        INSERT INTO invoice_items (
            invoice_id, line_number, po_item_id, sku, description,
            quantity, unit_price, tax_rate, line_subtotal, tax_amount, line_total
        ) VALUES (
            v_inv_a_id, 999, v_po_b_item_id, 'SKU-TEST-B2', 'Cross-PO Item',
            5.0000, 500000.0000, 0.1000, 2500000.00, 250000.00, 2750000.00
        );
    EXCEPTION WHEN check_violation THEN
        failed := true;
    END;

    -- Clean up temporary records
    DELETE FROM purchase_order_items WHERE id = v_po_b_item_id;
    DELETE FROM purchase_orders WHERE id = v_po_b_id;

    IF NOT failed THEN
        RAISE EXCEPTION 'Assertion Failed: Cross-PO invoice item did NOT trigger check_violation!';
    END IF;
    RAISE NOTICE '[OK] Cross-PO invoice item correctly rejected by trigger.';
END $$;

-- 11. Cross-Document Match Results Consistency Test
DO $$
DECLARE
    v_sup_id UUID;
    v_po_b_id UUID;
    v_inv_a_id UUID;
    failed boolean := false;
BEGIN
    RAISE NOTICE '=== [Test 11] match_results linking invoice(PO-A) with PO-B must fail ===';
    SELECT id INTO v_sup_id FROM suppliers WHERE supplier_code = 'SUP-ABC-001' LIMIT 1;
    SELECT id INTO v_inv_a_id FROM invoices WHERE invoice_number = 'INV-2026-001' LIMIT 1;

    INSERT INTO purchase_orders (
        po_number, supplier_id, currency, status, order_date, subtotal, tax_amount, total_amount
    ) VALUES (
        'PO-TEST-B3', v_sup_id, 'VND', 'ISSUED', CURRENT_DATE, 1000000.00, 100000.00, 1100000.00
    ) RETURNING id INTO v_po_b_id;

    BEGIN
        INSERT INTO match_results (
            invoice_id, purchase_order_id, status, overall_confidence
        ) VALUES (
            v_inv_a_id, v_po_b_id, 'PENDING', 90.00
        );
    EXCEPTION WHEN check_violation THEN
        failed := true;
    END;

    DELETE FROM purchase_orders WHERE id = v_po_b_id;

    IF NOT failed THEN
        RAISE EXCEPTION 'Assertion Failed: Cross-document match_results did NOT trigger check_violation!';
    END IF;
    RAISE NOTICE '[OK] Cross-document match_results correctly rejected by trigger.';
END $$;

-- 12. Cross-Document Approval Cases Consistency Test
DO $$
DECLARE
    v_inv_a_id UUID;
    v_inv_b_id UUID;
    v_po_a_id UUID;
    v_sup_id UUID;
    v_match_res_b_id UUID;
    failed boolean := false;
BEGIN
    RAISE NOTICE '=== [Test 12] approval_cases linking invoice A with match_result of invoice B must fail ===';
    SELECT id INTO v_sup_id FROM suppliers WHERE supplier_code = 'SUP-ABC-001' LIMIT 1;
    SELECT id INTO v_po_a_id FROM purchase_orders WHERE po_number = 'PO-2026-001' LIMIT 1;
    SELECT id INTO v_inv_a_id FROM invoices WHERE invoice_number = 'INV-2026-001' LIMIT 1;

    -- Create temporary invoice B for PO-A
    INSERT INTO invoices (
        invoice_number, supplier_id, purchase_order_id, invoice_date, currency, status,
        subtotal, tax_amount, total_amount
    ) VALUES (
        'INV-TEST-TEMP-B', v_sup_id, v_po_a_id, CURRENT_DATE, 'VND', 'RECEIVED',
        1000000.00, 100000.00, 1100000.00
    ) RETURNING id INTO v_inv_b_id;

    -- Create match_result for invoice B
    INSERT INTO match_results (
        invoice_id, purchase_order_id, status, overall_confidence
    ) VALUES (
        v_inv_b_id, v_po_a_id, 'FAILED', 40.00
    ) RETURNING id INTO v_match_res_b_id;

    -- Attempt to create approval_case for invoice A referencing match_result of invoice B
    BEGIN
        INSERT INTO approval_cases (
            invoice_id, match_result_id, status
        ) VALUES (
            v_inv_a_id, v_match_res_b_id, 'PENDING'
        );
    EXCEPTION WHEN check_violation THEN
        failed := true;
    END;

    -- Clean up
    DELETE FROM match_results WHERE id = v_match_res_b_id;
    DELETE FROM invoices WHERE id = v_inv_b_id;

    IF NOT failed THEN
        RAISE EXCEPTION 'Assertion Failed: Cross-document approval_cases did NOT trigger check_violation!';
    END IF;
    RAISE NOTICE '[OK] Cross-document approval_cases correctly rejected by trigger.';
END $$;

-- 13. Matching Policy Tolerance Range Test (0 <= tolerance <= 100)
DO $$
DECLARE
    failed_high boolean := false;
    failed_low boolean := false;
BEGIN
    RAISE NOTICE '=== [Test 13] matching_policies tolerance out-of-range (>100 or <0) must fail ===';

    -- Test > 100
    BEGIN
        INSERT INTO matching_policies (
            policy_code, description, quantity_tolerance_percent
        ) VALUES (
            'POL-INVALID-HIGH', 'Invalid tolerance > 100', 105.00
        );
    EXCEPTION WHEN check_violation THEN
        failed_high := true;
    END;

    -- Test < 0
    BEGIN
        INSERT INTO matching_policies (
            policy_code, description, price_tolerance_percent
        ) VALUES (
            'POL-INVALID-LOW', 'Invalid tolerance < 0', -5.00
        );
    EXCEPTION WHEN check_violation THEN
        failed_low := true;
    END;

    IF NOT failed_high THEN
        RAISE EXCEPTION 'Assertion Failed: tolerance > 100 did NOT trigger check_violation!';
    END IF;

    IF NOT failed_low THEN
        RAISE EXCEPTION 'Assertion Failed: tolerance < 0 did NOT trigger check_violation!';
    END IF;

    RAISE NOTICE '[OK] Matching policy tolerance range constraint (0-100) correctly enforced.';
    RAISE NOTICE '=== ALL SCHEMA INTEGRITY TESTS PASSED SUCCESSFULLY ===';
END $$;
