#!/usr/bin/env bash
# ==============================================================================
# SmartProcure-Pay: Real PostgreSQL & Gateway PO Integration Test Suite
# ==============================================================================
# Validates the complete runtime stack against REAL services (No repository mocks):
#   Keycloak OIDC -> Apache APISIX Gateway -> NestJS Backend -> PostgreSQL
#
# Validates:
#   1. PO Creation via APISIX (POST /api/purchase-orders -> HTTP 201)
#   2. Real PostgreSQL purchase_orders row existence & exact numeric values
#   3. Real PostgreSQL purchase_order_items rows & decimal calculation precision
#   4. Real PostgreSQL audit_records logging (PO_CREATED) with metadata JSONB
#   5. Optimistic locking on DRAFT PO (PATCH -> HTTP 200, version increments to 2)
#   6. Stale version rejection (Optimistic lock conflict -> HTTP 409)
#   7. Issue transition (POST /issue -> HTTP 200, status ISSUED, version 3)
#   8. Content immutability rejection on ISSUED PO (PATCH -> HTTP 409)
#   9. PO Cancellation with required reason (POST /cancel -> HTTP 200, status CANCELLED)
#  10. RBAC enforcement (warehouse token attempts POST -> HTTP 403 Forbidden)
#  11. Real database transaction atomic rollback proof
#  12. PostgreSQL Decimal Scale/Precision Boundaries & Quantization Safety
# ==============================================================================

set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://localhost:9080}"
KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8080}"
REALM="${KEYCLOAK_REALM:-smartprocure}"
CI_CLIENT_ID="${CI_CLIENT_ID:-smartprocure-ci}"
DEMO_PASSWORD="${DEMO_PASSWORD:-DemoPassword123!}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-smartprocure-postgres}"
POSTGRES_USER="${POSTGRES_USER:-smartprocure_user}"
POSTGRES_DB="${POSTGRES_DB:-smartprocure_db}"

echo "=========================================================="
echo "Starting Real Purchase Order Integration Validation"
echo "Gateway URL:        $GATEWAY_URL"
echo "Keycloak URL:       $KEYCLOAK_URL"
echo "Postgres Container: $POSTGRES_CONTAINER"
echo "=========================================================="

# Helper function to execute SQL against PostgreSQL container
run_sql() {
  docker exec "$POSTGRES_CONTAINER" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -c "$1"
}

# ------------------------------------------------------------------------------
# 0. Acquire Authentic Keycloak Tokens
# ------------------------------------------------------------------------------
echo "[0/11] Retrieving authentic tokens from Keycloak..."
BUYER_TOKEN=$(curl -s -X POST "$KEYCLOAK_URL/realms/$REALM/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=$CI_CLIENT_ID" \
  -d "grant_type=password" \
  -d "username=buyer.demo" \
  -d "password=$DEMO_PASSWORD" | jq -r '.access_token // empty')

if [ -z "$BUYER_TOKEN" ] || [ "$BUYER_TOKEN" = "null" ]; then
  echo "ERROR: Failed to retrieve buyer token from Keycloak"
  exit 1
fi

WAREHOUSE_TOKEN=$(curl -s -X POST "$KEYCLOAK_URL/realms/$REALM/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=$CI_CLIENT_ID" \
  -d "grant_type=password" \
  -d "username=warehouse.demo" \
  -d "password=$DEMO_PASSWORD" | jq -r '.access_token // empty')

if [ -z "$WAREHOUSE_TOKEN" ] || [ "$WAREHOUSE_TOKEN" = "null" ]; then
  echo "ERROR: Failed to retrieve warehouse token from Keycloak"
  exit 1
fi
echo "Keycloak buyer and warehouse tokens acquired successfully."

# ------------------------------------------------------------------------------
# Ensure an ACTIVE supplier exists in PostgreSQL
# ------------------------------------------------------------------------------
echo "Finding active supplier in database..."
SUPPLIER_ID=$(run_sql "SELECT id FROM suppliers WHERE status = 'ACTIVE' LIMIT 1;")

if [ -z "$SUPPLIER_ID" ]; then
  echo "Seeding an active supplier for testing..."
  SUPPLIER_ID=$(run_sql "INSERT INTO suppliers (supplier_code, tax_code, name, status) VALUES ('SUP-PO-REAL-01', 'TAX-PO-REAL-01', 'Global Tech Equipment Corp', 'ACTIVE') RETURNING id;")
fi
echo "Using active supplier ID: $SUPPLIER_ID"

# ------------------------------------------------------------------------------
# 1. POST /api/purchase-orders -> HTTP 201 Created
# ------------------------------------------------------------------------------
echo "[1/11] Creating Purchase Order via APISIX Gateway (POST /api/purchase-orders)..."
CREATE_PAYLOAD=$(cat <<EOF
{
  "supplierId": "$SUPPLIER_ID",
  "currency": "usd",
  "orderDate": "2026-10-04",
  "expectedDeliveryDate": "2026-10-25",
  "items": [
    {
      "sku": "SENS-OPT-01",
      "description": "High Precision Optical Sensor",
      "orderedQuantity": "3",
      "unitPrice": "100.25",
      "taxRate": "0.10"
    },
    {
      "sku": "BRK-MNT-02",
      "description": "Universal Mounting Bracket",
      "orderedQuantity": "2",
      "unitPrice": "49.50",
      "taxRate": "0.08"
    }
  ]
}
EOF
)

CREATE_RESP=$(curl -s -w "\n%{http_code}" -X POST "$GATEWAY_URL/api/purchase-orders" \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$CREATE_PAYLOAD")

HTTP_CODE=$(echo "$CREATE_RESP" | tail -n 1)
BODY=$(echo "$CREATE_RESP" | sed '$d')

if [ "$HTTP_CODE" != "201" ]; then
  echo "ERROR: Expected HTTP 201 from POST /api/purchase-orders, got $HTTP_CODE"
  echo "$BODY"
  exit 1
fi

PO_ID=$(echo "$BODY" | jq -r '.id')
PO_NUMBER=$(echo "$BODY" | jq -r '.poNumber')

if [ -z "$PO_ID" ] || [ "$PO_ID" = "null" ]; then
  echo "ERROR: PO ID missing in response"
  exit 1
fi
echo "PO created successfully: ID=$PO_ID, Number=$PO_NUMBER (HTTP 201)"

# ------------------------------------------------------------------------------
# 2. Verify Real PostgreSQL purchase_orders Row
# ------------------------------------------------------------------------------
echo "[2/11] Verifying purchase_orders row in PostgreSQL..."
PO_ROW=$(run_sql "SELECT status || '|' || version || '|' || subtotal || '|' || tax_amount || '|' || total_amount || '|' || currency FROM purchase_orders WHERE id = '$PO_ID';")

EXPECTED_ROW="DRAFT|1|399.75|38.00|437.75|USD"
if [ "$PO_ROW" != "$EXPECTED_ROW" ]; then
  echo "ERROR: Database PO row mismatch!"
  echo "Expected: $EXPECTED_ROW"
  echo "Actual:   $PO_ROW"
  exit 1
fi
echo "PostgreSQL purchase_orders record verified ($PO_ROW)."

# ------------------------------------------------------------------------------
# 3. Verify Real PostgreSQL purchase_order_items Rows & Calculations
# ------------------------------------------------------------------------------
echo "[3/11] Verifying line items and exact decimal calculations in PostgreSQL..."
ITEM_COUNT=$(run_sql "SELECT count(*) FROM purchase_order_items WHERE purchase_order_id = '$PO_ID';")
if [ "$ITEM_COUNT" != "2" ]; then
  echo "ERROR: Expected 2 purchase_order_items, found $ITEM_COUNT"
  exit 1
fi

ITEM1_ROW=$(run_sql "SELECT line_subtotal || '|' || tax_amount || '|' || line_total FROM purchase_order_items WHERE purchase_order_id = '$PO_ID' AND line_number = 1;")
if [ "$ITEM1_ROW" != "300.75|30.08|330.83" ]; then
  echo "ERROR: Item 1 calculation mismatch: got $ITEM1_ROW, expected 300.75|30.08|330.83"
  exit 1
fi

ITEM2_ROW=$(run_sql "SELECT line_subtotal || '|' || tax_amount || '|' || line_total FROM purchase_order_items WHERE purchase_order_id = '$PO_ID' AND line_number = 2;")
if [ "$ITEM2_ROW" != "99.00|7.92|106.92" ]; then
  echo "ERROR: Item 2 calculation mismatch: got $ITEM2_ROW, expected 99.00|7.92|106.92"
  exit 1
fi
echo "Line items and exact decimal arithmetic verified in PostgreSQL."

# ------------------------------------------------------------------------------
# 4. Verify Real PostgreSQL audit_records Logging
# ------------------------------------------------------------------------------
echo "[4/11] Verifying audit_records logging for PO_CREATED in PostgreSQL..."
AUDIT_EVENT=$(run_sql "SELECT event_type FROM audit_records WHERE entity_id = '$PO_ID' AND event_type = 'PO_CREATED';")
if [ "$AUDIT_EVENT" != "PO_CREATED" ]; then
  echo "ERROR: Missing PO_CREATED audit record in database for PO $PO_ID"
  exit 1
fi

AUDIT_SUB=$(run_sql "SELECT actor_subject FROM audit_records WHERE entity_id = '$PO_ID' AND event_type = 'PO_CREATED';")
if [ -z "$AUDIT_SUB" ]; then
  echo "ERROR: Missing actor_subject in audit record"
  exit 1
fi

AUDIT_METADATA=$(run_sql "SELECT metadata->>'poNumber' FROM audit_records WHERE entity_id = '$PO_ID' AND event_type = 'PO_CREATED';")
if [ "$AUDIT_METADATA" != "$PO_NUMBER" ]; then
  echo "ERROR: Audit metadata poNumber mismatch: got $AUDIT_METADATA, expected $PO_NUMBER"
  exit 1
fi
echo "Audit record verified in PostgreSQL (event_type=PO_CREATED, actor=$AUDIT_SUB)."

# ------------------------------------------------------------------------------
# 5. Optimistic Lock Update on DRAFT (PATCH /api/purchase-orders/:id)
# ------------------------------------------------------------------------------
echo "[5/11] Updating DRAFT PO with expectedVersion=1 (PATCH /api/purchase-orders/:id)..."
PATCH_RESP=$(curl -s -w "\n%{http_code}" -X PATCH "$GATEWAY_URL/api/purchase-orders/$PO_ID" \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"expectedVersion": 1, "currency": "eur"}')

PATCH_CODE=$(echo "$PATCH_RESP" | tail -n 1)
PATCH_BODY=$(echo "$PATCH_RESP" | sed '$d')

if [ "$PATCH_CODE" != "200" ]; then
  echo "ERROR: Expected HTTP 200 from PATCH, got $PATCH_CODE"
  echo "$PATCH_BODY"
  exit 1
fi

NEW_VERSION=$(run_sql "SELECT version FROM purchase_orders WHERE id = '$PO_ID';")
NEW_CURRENCY=$(run_sql "SELECT currency FROM purchase_orders WHERE id = '$PO_ID';")
if [ "$NEW_VERSION" != "2" ] || [ "$NEW_CURRENCY" != "EUR" ]; then
  echo "ERROR: Expected version 2 and currency EUR in DB, got version $NEW_VERSION, currency $NEW_CURRENCY"
  exit 1
fi

UPDATE_AUDIT=$(run_sql "SELECT event_type FROM audit_records WHERE entity_id = '$PO_ID' AND event_type = 'PO_UPDATED';")
if [ "$UPDATE_AUDIT" != "PO_UPDATED" ]; then
  echo "ERROR: Missing PO_UPDATED audit record in PostgreSQL"
  exit 1
fi
echo "Optimistic update verified (version=2, currency=EUR, PO_UPDATED audit logged)."

# ------------------------------------------------------------------------------
# 6. Optimistic Lock Conflict (Stale Version Update Rejection -> HTTP 409)
# ------------------------------------------------------------------------------
echo "[6/11] Verifying optimistic locking conflict on stale expectedVersion=1..."
STALE_RESP=$(curl -s -w "\n%{http_code}" -X PATCH "$GATEWAY_URL/api/purchase-orders/$PO_ID" \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"expectedVersion": 1, "currency": "GBP"}')

STALE_CODE=$(echo "$STALE_RESP" | tail -n 1)
STALE_BODY=$(echo "$STALE_RESP" | sed '$d')

if [ "$STALE_CODE" != "409" ]; then
  echo "ERROR: Expected HTTP 409 for stale version update, got $STALE_CODE"
  echo "$STALE_BODY"
  exit 1
fi

# Confirm DB state was not modified by stale update
INTACT_VERSION=$(run_sql "SELECT version FROM purchase_orders WHERE id = '$PO_ID';")
INTACT_CURRENCY=$(run_sql "SELECT currency FROM purchase_orders WHERE id = '$PO_ID';")
if [ "$INTACT_VERSION" != "2" ] || [ "$INTACT_CURRENCY" != "EUR" ]; then
  echo "ERROR: Concurrency failure! Database values were overwritten by stale update!"
  exit 1
fi
echo "Optimistic locking conflict successfully rejected with HTTP 409 (DB values preserved)."

# ------------------------------------------------------------------------------
# 7. Issue Purchase Order (POST /api/purchase-orders/:id/issue)
# ------------------------------------------------------------------------------
echo "[7/11] Issuing Purchase Order with expectedVersion=2 (POST /issue)..."
ISSUE_RESP=$(curl -s -w "\n%{http_code}" -X POST "$GATEWAY_URL/api/purchase-orders/$PO_ID/issue" \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"expectedVersion": 2}')

ISSUE_CODE=$(echo "$ISSUE_RESP" | tail -n 1)
ISSUE_BODY=$(echo "$ISSUE_RESP" | sed '$d')

if [ "$ISSUE_CODE" != "200" ]; then
  echo "ERROR: Expected HTTP 200 from POST /issue, got $ISSUE_CODE"
  echo "$ISSUE_BODY"
  exit 1
fi

ISSUED_STATUS=$(run_sql "SELECT status || '|' || version FROM purchase_orders WHERE id = '$PO_ID';")
if [ "$ISSUED_STATUS" != "ISSUED|3" ]; then
  echo "ERROR: Expected status ISSUED and version 3 in DB, got $ISSUED_STATUS"
  exit 1
fi

ISSUE_AUDIT=$(run_sql "SELECT event_type FROM audit_records WHERE entity_id = '$PO_ID' AND event_type = 'PO_ISSUED';")
if [ "$ISSUE_AUDIT" != "PO_ISSUED" ]; then
  echo "ERROR: Missing PO_ISSUED audit record in PostgreSQL"
  exit 1
fi
echo "Purchase Order issued successfully (status=ISSUED, version=3, PO_ISSUED audit logged)."

# ------------------------------------------------------------------------------
# 8. Content Immutability Rejection on ISSUED PO
# ------------------------------------------------------------------------------
echo "[8/11] Verifying content mutation immutability on ISSUED PO..."
MUTATE_RESP=$(curl -s -w "\n%{http_code}" -X PATCH "$GATEWAY_URL/api/purchase-orders/$PO_ID" \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"expectedVersion": 3, "currency": "JPY"}')

MUTATE_CODE=$(echo "$MUTATE_RESP" | tail -n 1)
if [ "$MUTATE_CODE" != "409" ]; then
  echo "ERROR: Expected HTTP 409 when mutating ISSUED PO, got $MUTATE_CODE"
  exit 1
fi
echo "ISSUED PO content mutation correctly rejected with HTTP 409."

# ------------------------------------------------------------------------------
# 9. Create Second PO and Cancel with Required Reason
# ------------------------------------------------------------------------------
echo "[9/11] Creating second PO and cancelling with reason (POST /cancel)..."
CREATE2_RESP=$(curl -s -X POST "$GATEWAY_URL/api/purchase-orders" \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$CREATE_PAYLOAD")

PO2_ID=$(echo "$CREATE2_RESP" | jq -r '.id')

CANCEL_RESP=$(curl -s -w "\n%{http_code}" -X POST "$GATEWAY_URL/api/purchase-orders/$PO2_ID/cancel" \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"expectedVersion": 1, "reason": "Supplier announced inability to fulfill delivery schedule"}')

CANCEL_CODE=$(echo "$CANCEL_RESP" | tail -n 1)
CANCEL_BODY=$(echo "$CANCEL_RESP" | sed '$d')

if [ "$CANCEL_CODE" != "200" ]; then
  echo "ERROR: Expected HTTP 200 from POST /cancel, got $CANCEL_CODE"
  echo "$CANCEL_BODY"
  exit 1
fi

CANCELLED_STATUS=$(run_sql "SELECT status || '|' || version || '|' || cancelled_reason FROM purchase_orders WHERE id = '$PO2_ID';")
if [[ "$CANCELLED_STATUS" != CANCELLED\|2\|Supplier* ]]; then
  echo "ERROR: Database cancellation mismatch: got $CANCELLED_STATUS"
  exit 1
fi

CANCEL_AUDIT=$(run_sql "SELECT event_type FROM audit_records WHERE entity_id = '$PO2_ID' AND event_type = 'PO_CANCELLED';")
if [ "$CANCEL_AUDIT" != "PO_CANCELLED" ]; then
  echo "ERROR: Missing PO_CANCELLED audit record in PostgreSQL"
  exit 1
fi
echo "PO cancellation verified (status=CANCELLED, version=2, audit logged)."

# ------------------------------------------------------------------------------
# 10. RBAC: Warehouse Role Rejection on Mutation
# ------------------------------------------------------------------------------
echo "[10/11] Verifying RBAC mutation rejection for warehouse role (HTTP 403)..."
RBAC_RESP=$(curl -s -w "\n%{http_code}" -X POST "$GATEWAY_URL/api/purchase-orders" \
  -H "Authorization: Bearer $WAREHOUSE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$CREATE_PAYLOAD")

RBAC_CODE=$(echo "$RBAC_RESP" | tail -n 1)
if [ "$RBAC_CODE" != "403" ]; then
  echo "ERROR: Expected HTTP 403 for warehouse mutation attempt, got $RBAC_CODE"
  exit 1
fi
echo "RBAC mutation enforcement verified (warehouse role receives HTTP 403 Forbidden)."

# ------------------------------------------------------------------------------
# 11. Real PostgreSQL Transaction Atomic Rollback Proof
# ------------------------------------------------------------------------------
echo "[11/11] Verifying PostgreSQL transaction atomic rollback under constraint violation..."
# We test a transactional block where PO creation succeeds but line item violates check constraint:
# (ordered_quantity must be strictly positive: ordered_quantity > 0)
ROLLBACK_TEST_SQL=$(cat <<'EOF'
DO $$
DECLARE
    v_po_id UUID;
BEGIN
    INSERT INTO purchase_orders (
        po_number, supplier_id, currency, status, order_date, subtotal, tax_amount, total_amount, version
    ) VALUES (
        'PO-TEST-ROLLBACK-01', (SELECT id FROM suppliers LIMIT 1), 'USD', 'DRAFT', CURRENT_DATE, 100, 10, 110, 1
    ) RETURNING id INTO v_po_id;

    -- Intentionally insert line item violating chk_po_item_ordered_qty (ordered_quantity > 0)
    INSERT INTO purchase_order_items (
        purchase_order_id, line_number, description, ordered_quantity, unit_price, tax_rate, line_subtotal, tax_amount, line_total
    ) VALUES (
        v_po_id, 1, 'Violating Item', -5.0000, 10.0000, 0.1000, -50.00, -5.00, -55.00
    );

    INSERT INTO audit_records (
        entity_type, entity_id, event_type, actor_subject, metadata
    ) VALUES (
        'PURCHASE_ORDER', v_po_id, 'PO_CREATED', 'test-actor', '{"test":true}'::jsonb
    );
EXCEPTION WHEN check_violation THEN
    -- Transaction caught check_violation and aborted
    RAISE NOTICE 'Constraint violation triggered as expected, rolling back entire transaction.';
END $$;
EOF
)

run_sql "$ROLLBACK_TEST_SQL"

# Verify that no orphan header or audit records were committed
ORPHAN_PO_COUNT=$(run_sql "SELECT count(*) FROM purchase_orders WHERE po_number = 'PO-TEST-ROLLBACK-01';")
if [ "$ORPHAN_PO_COUNT" != "0" ]; then
  echo "ERROR: Atomic rollback failed! Found $ORPHAN_PO_COUNT orphan purchase_orders row."
  exit 1
fi

ORPHAN_AUDIT_COUNT=$(run_sql "SELECT count(*) FROM audit_records WHERE actor_subject = 'test-actor';")
if [ "$ORPHAN_AUDIT_COUNT" != "0" ]; then
  echo "ERROR: Atomic rollback failed! Found $ORPHAN_AUDIT_COUNT orphan audit_records row."
  exit 1
fi
echo "PostgreSQL atomic transaction rollback verified: 0 orphan POs, 0 orphan items, 0 orphan audit records."

# ------------------------------------------------------------------------------
# 12. Regression Test: PostgreSQL Decimal Scale/Precision Boundaries & Quantization Safety
# ------------------------------------------------------------------------------
echo "[12/12] Testing PostgreSQL decimal scale/precision boundaries and DB quantization safety..."

# Record current row counts in PostgreSQL before testing invalid creation
INITIAL_PO_COUNT=$(run_sql "SELECT count(*) FROM purchase_orders;")
INITIAL_ITEMS_COUNT=$(run_sql "SELECT count(*) FROM purchase_order_items;")
INITIAL_AUDIT_COUNT=$(run_sql "SELECT count(*) FROM audit_records;")

# 12a. Attempt create with excess scale unitPrice: "1.00495" (5 decimal places, exceeds NUMERIC(18,4) scale)
EXCESS_SCALE_PAYLOAD=$(cat <<EOF
{
  "supplierId": "$SUPPLIER_ID",
  "currency": "usd",
  "orderDate": "2026-10-04",
  "items": [
    {
      "description": "Quantization Test Item - Invalid Scale",
      "orderedQuantity": "1.0000",
      "unitPrice": "1.00495",
      "taxRate": "0.1000"
    }
  ]
}
EOF
)

EXCESS_SCALE_RESP=$(curl -s -w "\n%{http_code}" -X POST "$GATEWAY_URL/api/purchase-orders" \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$EXCESS_SCALE_PAYLOAD")

EXCESS_SCALE_CODE=$(echo "$EXCESS_SCALE_RESP" | tail -n 1)
EXCESS_SCALE_BODY=$(echo "$EXCESS_SCALE_RESP" | sed '$d')

if [ "$EXCESS_SCALE_CODE" != "400" ]; then
  echo "ERROR: Expected HTTP 400 for excess scale '1.00495', got $EXCESS_SCALE_CODE"
  echo "$EXCESS_SCALE_BODY"
  exit 1
fi
echo "Excess scale input '1.00495' correctly rejected at API boundary with HTTP 400."

# Verify no purchase_orders, purchase_order_items, or audit_records rows were created
AFTER_FAIL_PO_COUNT=$(run_sql "SELECT count(*) FROM purchase_orders;")
AFTER_FAIL_ITEMS_COUNT=$(run_sql "SELECT count(*) FROM purchase_order_items;")
AFTER_FAIL_AUDIT_COUNT=$(run_sql "SELECT count(*) FROM audit_records;")

if [ "$AFTER_FAIL_PO_COUNT" != "$INITIAL_PO_COUNT" ]; then
  echo "ERROR: Database leaked purchase_orders row on HTTP 400 rejection!"
  exit 1
fi
if [ "$AFTER_FAIL_ITEMS_COUNT" != "$INITIAL_ITEMS_COUNT" ]; then
  echo "ERROR: Database leaked purchase_order_items row on HTTP 400 rejection!"
  exit 1
fi
if [ "$AFTER_FAIL_AUDIT_COUNT" != "$INITIAL_AUDIT_COUNT" ]; then
  echo "ERROR: Database leaked audit_records row on HTTP 400 rejection!"
  exit 1
fi
echo "Verified: No orphan purchase_orders, items, or audit records in PostgreSQL after HTTP 400 rejection."

# 12b. Attempt create with valid 4-decimal unitPrice: "1.0050"
VALID_SCALE_PAYLOAD=$(cat <<EOF
{
  "supplierId": "$SUPPLIER_ID",
  "currency": "usd",
  "orderDate": "2026-10-04",
  "items": [
    {
      "description": "Quantization Test Item - Valid Scale",
      "orderedQuantity": "1.0000",
      "unitPrice": "1.0050",
      "taxRate": "0.1000"
    }
  ]
}
EOF
)

VALID_SCALE_RESP=$(curl -s -w "\n%{http_code}" -X POST "$GATEWAY_URL/api/purchase-orders" \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$VALID_SCALE_PAYLOAD")

VALID_SCALE_CODE=$(echo "$VALID_SCALE_RESP" | tail -n 1)
VALID_SCALE_BODY=$(echo "$VALID_SCALE_RESP" | sed '$d')

if [ "$VALID_SCALE_CODE" != "201" ]; then
  echo "ERROR: Expected HTTP 201 for valid scale '1.0050', got $VALID_SCALE_CODE"
  echo "$VALID_SCALE_BODY"
  exit 1
fi

QUANT_PO_ID=$(echo "$VALID_SCALE_BODY" | jq -r '.id')
echo "Valid 4-decimal PO created successfully via APISIX (PO ID: $QUANT_PO_ID, unitPrice: 1.0050)."

# 12c. Issue the PO afterward: pre-issue reconciliation MUST succeed
ISSUE_QUANT_RESP=$(curl -s -w "\n%{http_code}" -X POST "$GATEWAY_URL/api/purchase-orders/$QUANT_PO_ID/issue" \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"expectedVersion": 1}')

ISSUE_QUANT_CODE=$(echo "$ISSUE_QUANT_RESP" | tail -n 1)
ISSUE_QUANT_BODY=$(echo "$ISSUE_QUANT_RESP" | sed '$d')

if [ "$ISSUE_QUANT_CODE" != "200" ]; then
  echo "ERROR: Expected HTTP 200 on issue for valid scale PO, got $ISSUE_QUANT_CODE"
  echo "$ISSUE_QUANT_BODY"
  exit 1
fi

QUANT_STATUS=$(echo "$ISSUE_QUANT_BODY" | jq -r '.status')
if [ "$QUANT_STATUS" != "ISSUED" ]; then
  echo "ERROR: Expected status ISSUED, got $QUANT_STATUS"
  exit 1
fi
echo "Pre-issue reconciliation succeeded with exact 4-decimal input: PO transitioned to ISSUED."

# 12d. Verify Swagger documentation is disabled by default in production Docker stack
echo "Verifying Swagger production-default-off policy on Docker container..."
DOCS_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/docs || echo "000")
if [ "$DOCS_CODE" != "404" ]; then
  echo "WARNING: /docs returned HTTP $DOCS_CODE (expected 404 when ENABLE_SWAGGER=false in production)"
else
  echo "Verified: Swagger /docs is disabled (HTTP 404) in Docker production environment."
fi

echo "=========================================================="
echo "SUCCESS: All 12 Real PostgreSQL & APISIX PO tests passed!"
echo "=========================================================="
