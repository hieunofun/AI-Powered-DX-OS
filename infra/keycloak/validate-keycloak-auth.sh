#!/usr/bin/env bash
# ==============================================================================
# SmartProcure-Pay: Keycloak SSO & RBAC Validation Script
# ==============================================================================
# Validates Keycloak startup, realm import, token issuance, API JWT verification,
# and RBAC role enforcement (401 Unauthorized vs 403 Forbidden).
# ==============================================================================

set -euo pipefail

KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8080}"
REALM="${KEYCLOAK_REALM:-smartprocure}"
API_URL="${API_URL:-http://localhost:4000}"
CLIENT_ID="${CLIENT_ID:-smartprocure-web}"
DEMO_PASSWORD="${DEMO_PASSWORD:-DemoPassword123!}"

echo "=========================================================="
echo "Starting Keycloak SSO & RBAC Validation"
echo "Keycloak URL: $KEYCLOAK_URL"
echo "Realm:        $REALM"
echo "API URL:      $API_URL"
echo "=========================================================="

# 1. Wait for Keycloak realm to be available
echo "[1/7] Waiting for Keycloak realm '$REALM'..."
REALM_READY=0
for i in $(seq 1 35); do
  HTTP_CODE=$(curl -s -o /tmp/kc_realm.json -w "%{http_code}" "$KEYCLOAK_URL/realms/$REALM" || true)
  if [ "$HTTP_CODE" = "200" ]; then
    echo "Keycloak realm '$REALM' is ready! (attempt $i)"
    REALM_READY=1
    break
  fi
  echo "Attempt $i/35: Keycloak not ready yet (HTTP $HTTP_CODE). Retrying in 2s..."
  sleep 2
done

if [ "$REALM_READY" -ne 1 ]; then
  echo "ERROR: Timed out waiting for Keycloak realm '$REALM'."
  exit 1
fi

# 2. Validate OIDC Discovery endpoint
echo "[2/7] Validating OIDC Well-Known Discovery endpoint..."
DISCOVERY_CODE=$(curl -s -o /tmp/kc_discovery.json -w "%{http_code}" "$KEYCLOAK_URL/realms/$REALM/.well-known/openid-configuration")
if [ "$DISCOVERY_CODE" != "200" ]; then
  echo "ERROR: OIDC Discovery failed with HTTP $DISCOVERY_CODE"
  exit 1
fi

grep -q "jwks_uri" /tmp/kc_discovery.json || { echo "ERROR: Missing jwks_uri in discovery document"; exit 1; }
echo "OIDC Discovery document verified successfully."

# 3. Request tokens for demo accounts using direct grant
echo "[3/7] Requesting JWT tokens for buyer.demo and admin.demo..."
BUYER_TOKEN=$(curl -s -X POST "$KEYCLOAK_URL/realms/$REALM/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=$CLIENT_ID" \
  -d "grant_type=password" \
  -d "username=buyer.demo" \
  -d "password=$DEMO_PASSWORD" | jq -r '.access_token // empty')

if [ -z "$BUYER_TOKEN" ] || [ "$BUYER_TOKEN" = "null" ]; then
  echo "ERROR: Failed to obtain access token for buyer.demo"
  exit 1
fi
echo "Successfully obtained JWT for buyer.demo"

ADMIN_TOKEN=$(curl -s -X POST "$KEYCLOAK_URL/realms/$REALM/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=$CLIENT_ID" \
  -d "grant_type=password" \
  -d "username=admin.demo" \
  -d "password=$DEMO_PASSWORD" | jq -r '.access_token // empty')

if [ -z "$ADMIN_TOKEN" ] || [ "$ADMIN_TOKEN" = "null" ]; then
  echo "ERROR: Failed to obtain access token for admin.demo"
  exit 1
fi
echo "Successfully obtained JWT for admin.demo"

# 4. Verify unauthenticated requests produce 401 Unauthorized
echo "[4/7] Verifying unauthenticated requests return HTTP 401..."
STATUS_NO_AUTH=$(curl -s -o /tmp/no_auth.json -w "%{http_code}" "$API_URL/auth/me")
if [ "$STATUS_NO_AUTH" != "401" ]; then
  echo "ERROR: Expected HTTP 401 for unauthenticated request, got $STATUS_NO_AUTH"
  cat /tmp/no_auth.json
  exit 1
fi

STATUS_BAD_TOKEN=$(curl -s -o /tmp/bad_token.json -w "%{http_code}" \
  -H "Authorization: Bearer invalid.token.payload" "$API_URL/auth/me")
if [ "$STATUS_BAD_TOKEN" != "401" ]; then
  echo "ERROR: Expected HTTP 401 for invalid token, got $STATUS_BAD_TOKEN"
  cat /tmp/bad_token.json
  exit 1
fi
echo "HTTP 401 enforcement verified."

# 5. Verify valid buyer token on /auth/me and /auth/buyer-test
echo "[5/7] Verifying buyer token against API..."
BUYER_ME_STATUS=$(curl -s -o /tmp/buyer_me.json -w "%{http_code}" \
  -H "Authorization: Bearer $BUYER_TOKEN" "$API_URL/auth/me")
if [ "$BUYER_ME_STATUS" != "200" ]; then
  echo "ERROR: Expected HTTP 200 on /auth/me for buyer, got $BUYER_ME_STATUS"
  cat /tmp/buyer_me.json
  exit 1
fi

grep -q '"username":"buyer.demo"' /tmp/buyer_me.json || { echo "ERROR: Username buyer.demo missing in /auth/me"; exit 1; }
grep -q '"buyer"' /tmp/buyer_me.json || { echo "ERROR: Role 'buyer' missing in /auth/me"; exit 1; }
echo "Buyer profile verified: $(cat /tmp/buyer_me.json)"

BUYER_TEST_STATUS=$(curl -s -o /tmp/buyer_test.json -w "%{http_code}" \
  -H "Authorization: Bearer $BUYER_TOKEN" "$API_URL/auth/buyer-test")
if [ "$BUYER_TEST_STATUS" != "200" ]; then
  echo "ERROR: Expected HTTP 200 on /auth/buyer-test for buyer, got $BUYER_TEST_STATUS"
  exit 1
fi
echo "Buyer access to /auth/buyer-test verified."

# 6. Verify RBAC 403 Forbidden enforcement (buyer accessing admin endpoint)
echo "[6/7] Verifying 403 Forbidden enforcement for insufficient role..."
BUYER_ADMIN_STATUS=$(curl -s -o /tmp/buyer_admin.json -w "%{http_code}" \
  -H "Authorization: Bearer $BUYER_TOKEN" "$API_URL/auth/admin-test")
if [ "$BUYER_ADMIN_STATUS" != "403" ]; then
  echo "ERROR: Expected HTTP 403 when buyer accesses /auth/admin-test, got $BUYER_ADMIN_STATUS"
  cat /tmp/buyer_admin.json
  exit 1
fi

grep -q '"error":"Forbidden"' /tmp/buyer_admin.json || { echo "ERROR: Missing Forbidden in 403 response"; exit 1; }
echo "HTTP 403 Forbidden enforcement verified."

# 7. Verify admin token on /auth/admin-test and /auth/buyer-test
echo "[7/7] Verifying admin token on protected endpoints..."
ADMIN_TEST_STATUS=$(curl -s -o /tmp/admin_test.json -w "%{http_code}" \
  -H "Authorization: Bearer $ADMIN_TOKEN" "$API_URL/auth/admin-test")
if [ "$ADMIN_TEST_STATUS" != "200" ]; then
  echo "ERROR: Expected HTTP 200 on /auth/admin-test for admin, got $ADMIN_TEST_STATUS"
  exit 1
fi

ADMIN_BUYER_STATUS=$(curl -s -o /tmp/admin_buyer.json -w "%{http_code}" \
  -H "Authorization: Bearer $ADMIN_TOKEN" "$API_URL/auth/buyer-test")
if [ "$ADMIN_BUYER_STATUS" != "200" ]; then
  echo "ERROR: Expected HTTP 200 on /auth/buyer-test for admin, got $ADMIN_BUYER_STATUS"
  exit 1
fi
echo "Admin access to protected endpoints verified."

echo "=========================================================="
echo "SUCCESS: All Keycloak SSO & RBAC validations passed!"
echo "=========================================================="
