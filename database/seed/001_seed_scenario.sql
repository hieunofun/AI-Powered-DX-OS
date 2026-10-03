-- ==============================================================================
-- Seed: 001_seed_scenario.sql
-- Description: Baseline reference dataset for Procure-to-Pay and 3-Way Matching
-- Scenario:
--   Supplier: ABC Office Solutions
--   PO: PO-2026-001 (100 units HP 85A @ 1,000,000 VND)
--   GRN-001: 60 units accepted
--   GRN-002: 38 units accepted -> Total received = 98 units
--   Invoice-001: 60 units -> Total previously invoiced = 60 units
--   Available to invoice: 98 - 60 = 38 units
--   Invoice-002: Candidate invoice for exactly 38 units (Pending Match)
-- ==============================================================================

DO $$
DECLARE
    v_supplier_id UUID;
    v_po_id UUID;
    v_po_item_id UUID;
    v_grn1_id UUID;
    v_grn2_id UUID;
    v_inv1_id UUID;
    v_inv2_id UUID;
    v_policy_id UUID;
BEGIN
    -- 1. Default Matching Policy
    INSERT INTO matching_policies (
        policy_code,
        description,
        quantity_tolerance_percent,
        price_tolerance_percent,
        tax_tolerance_percent,
        is_active
    ) VALUES (
        'GLOBAL_DEFAULT',
        'Chính sách đối soát 3 bên tiêu chuẩn toàn hệ thống',
        0.00,
        1.00,
        0.00,
        true
    ) RETURNING id INTO v_policy_id;

    -- 2. Supplier ABC
    INSERT INTO suppliers (
        supplier_code,
        tax_code,
        name,
        status,
        email,
        phone
    ) VALUES (
        'SUP-ABC-001',
        '0101234567',
        'Công ty Cổ phần Thiết bị Văn phòng ABC',
        'ACTIVE',
        'sales@abc-office.vn',
        '02438889999'
    ) RETURNING id INTO v_supplier_id;

    -- 3. Purchase Order (100 units @ 1,000,000 VND + 10% VAT)
    INSERT INTO purchase_orders (
        po_number,
        supplier_id,
        currency,
        status,
        order_date,
        expected_delivery_date,
        subtotal,
        tax_amount,
        total_amount
    ) VALUES (
        'PO-2026-001',
        v_supplier_id,
        'VND',
        'PARTIALLY_RECEIVED',
        '2026-09-01',
        '2026-09-15',
        100000000.00,
        10000000.00,
        110000000.00
    ) RETURNING id INTO v_po_id;

    -- 3.1 PO Item: HP 85A Ink Cartridge
    INSERT INTO purchase_order_items (
        purchase_order_id,
        line_number,
        sku,
        description,
        ordered_quantity,
        unit_price,
        tax_rate,
        line_subtotal,
        tax_amount,
        line_total
    ) VALUES (
        v_po_id,
        1,
        'INK-HP-85A',
        'Hộp mực máy in HP LaserJet 85A (CE285A)',
        100.0000,
        1000000.0000,
        0.1000,
        100000000.00,
        10000000.00,
        110000000.00
    ) RETURNING id INTO v_po_item_id;

    -- 4. Goods Receipt Note 1: First delivery (60 units accepted)
    INSERT INTO goods_receipts (
        grn_number,
        purchase_order_id,
        received_at,
        status,
        reference_note
    ) VALUES (
        'GRN-2026-001',
        v_po_id,
        '2026-09-05 10:00:00+07',
        'RECEIVED',
        'Đợt giao hàng 1 - Kho Hà Nội tiếp nhận 60 hộp mực'
    ) RETURNING id INTO v_grn1_id;

    INSERT INTO goods_receipt_items (
        goods_receipt_id,
        purchase_order_item_id,
        line_number,
        received_quantity,
        accepted_quantity,
        rejected_quantity
    ) VALUES (
        v_grn1_id,
        v_po_item_id,
        1,
        60.0000,
        60.0000,
        0.0000
    );

    -- 5. Goods Receipt Note 2: Second delivery (38 units accepted)
    INSERT INTO goods_receipts (
        grn_number,
        purchase_order_id,
        received_at,
        status,
        reference_note
    ) VALUES (
        'GRN-2026-002',
        v_po_id,
        '2026-09-12 14:30:00+07',
        'RECEIVED',
        'Đợt giao hàng 2 - Kho Hà Nội tiếp nhận 38 hộp mực'
    ) RETURNING id INTO v_grn2_id;

    INSERT INTO goods_receipt_items (
        goods_receipt_id,
        purchase_order_item_id,
        line_number,
        received_quantity,
        accepted_quantity,
        rejected_quantity
    ) VALUES (
        v_grn2_id,
        v_po_item_id,
        1,
        38.0000,
        38.0000,
        0.0000
    );

    -- 6. Historical Invoice 1: Cleared for payment (60 units)
    INSERT INTO invoices (
        invoice_number,
        supplier_id,
        purchase_order_id,
        invoice_date,
        currency,
        status,
        subtotal,
        tax_amount,
        total_amount,
        source_type
    ) VALUES (
        'INV-2026-001',
        v_supplier_id,
        v_po_id,
        '2026-09-08',
        'VND',
        'READY_FOR_PAYMENT',
        60000000.00,
        6000000.00,
        66000000.00,
        'EINVOICE_XML'
    ) RETURNING id INTO v_inv1_id;

    INSERT INTO invoice_items (
        invoice_id,
        line_number,
        po_item_id,
        sku,
        description,
        quantity,
        unit_price,
        tax_rate,
        line_subtotal,
        tax_amount,
        line_total
    ) VALUES (
        v_inv1_id,
        1,
        v_po_item_id,
        'INK-HP-85A',
        'Hộp mực in HP LaserJet 85A (CE285A)',
        60.0000,
        1000000.0000,
        0.1000,
        60000000.00,
        6000000.00,
        66000000.00
    );

    -- 7. Candidate Invoice 2: Exactly matching remaining available quantity (38 units)
    INSERT INTO invoices (
        invoice_number,
        supplier_id,
        purchase_order_id,
        invoice_date,
        currency,
        status,
        subtotal,
        tax_amount,
        total_amount,
        source_type
    ) VALUES (
        'INV-2026-002',
        v_supplier_id,
        v_po_id,
        '2026-09-15',
        'VND',
        'PENDING_MATCH',
        38000000.00,
        3800000.00,
        41800000.00,
        'EINVOICE_XML'
    ) RETURNING id INTO v_inv2_id;

    INSERT INTO invoice_items (
        invoice_id,
        line_number,
        po_item_id,
        sku,
        description,
        quantity,
        unit_price,
        tax_rate,
        line_subtotal,
        tax_amount,
        line_total
    ) VALUES (
        v_inv2_id,
        1,
        v_po_item_id,
        'INK-HP-85A',
        'Hộp mực in HP LaserJet 85A',
        38.0000,
        1000000.0000,
        0.1000,
        38000000.00,
        3800000.00,
        41800000.00
    );

    -- 8. Audit Record baseline
    INSERT INTO audit_records (
        entity_type,
        entity_id,
        event_type,
        actor_subject,
        metadata
    ) VALUES (
        'PURCHASE_ORDER',
        v_po_id,
        'PO_ISSUED',
        'buyer@smartprocure.local',
        jsonb_build_object(
            'po_number', 'PO-2026-001',
            'ordered_quantity', 100,
            'supplier_code', 'SUP-ABC-001'
        )
    );

END $$;
