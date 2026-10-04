#!/usr/bin/env bash
# ==============================================================================
# SmartProcure-Pay: Apache APISIX Gateway Validation Script (Issue #4)
# ==============================================================================
# Validates:
#   1. Gateway unified root route (GET / -> Web React SPA, HTTP 200)
#   2. Gateway public API health route (GET /api/health -> NestJS API, HTTP 200)
#   3. Gateway unauthenticated protected route rejection (HTTP 401)
#   4. Gateway invalid token rejection (HTTP 401)
#   5. Gateway valid buyer token acceptance (GET /api/auth/me -> HTTP 200)
#   6. Gateway buyer token accessing authorized endpoint (GET /api/auth/buyer-test -> HTTP 200)
#   7. Gateway buyer token accessing unauthorized endpoint (GET /api/auth/admin-test -> HTTP 403)
#   8. Gateway admin token accessing admin endpoint (GET /api/auth/admin-test -> HTTP 200)
#   9. CORS preflight allowed origin verification (HTTP 200 with Access-Control-Allow-Origin)
#  10. CORS disallowed origin non-permissive response
#  11. Rate limiting enforcement (GET /api/rate-limit-test -> HTTP 429 Too Many Requests)
#  12. Prometheus metrics exporter verification (GET :9091/apisix/prometheus/metrics)
#  13. Direct NestJS verification (Defense in depth preservation)
#  14. Anti-spoofing identity header stripping verification
# ==============================================================================

set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://localhost:9080}"
METRICS_URL="${METRICS_URL:-http://localhost:9091}"
KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8080}"
DIRECT_API_URL="${DIRECT_API_URL:-http://localhost:4000}"
REALM="${KEYCLOAK_REALM:-smartprocure}"
CI_CLIENT_ID="${CI_CLIENT_ID:-smartprocure-ci}"
DEMO_PASSWORD="${DEMO_PASSWORD:-DemoPassword123!}"

echo "=========================================================="
echo "Starting Apache APISIX Gateway Automated Validation"
echo "Gateway URL:    $GATEWAY_URL"
echo "Metrics URL:    $METRICS_URL"
echo "Keycloak URL:   $KEYCLOAK_URL"
echo "Direct API URL: $DIRECT_API_URL"
echo "=========================================================="

# ------------------------------------------------------------------------------
# 0. Wait for APISIX Gateway to be ready
# ------------------------------------------------------------------------------
echo "[0/14] Waiting for APISIX Gateway on $GATEWAY_URL..."
GATEWAY_READY=0
for i in $(seq 1 30); do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$GATEWAY_URL/" || true)
  if [ "$HTTP_CODE" = "200" ]; then
    echo "APISIX Gateway is responding! (attempt $i)"
    GATEWAY_READY=1
    break
  fi
  echo "Attempt $i/30: Gateway returned HTTP $HTTP_CODE. Retrying in 2s..."
  sleep 2
done

if [ "$GATEWAY_READY" -ne 1 ]; then
  echo "ERROR: Timed out waiting for APISIX Gateway."
  exit 1
fi

# ------------------------------------------------------------------------------
# 1. GET / -> Web React Application
# ------------------------------------------------------------------------------
echo "[1/14] Verifying root path (GET /) serves Web Frontend..."
STATUS_WEB=$(curl -s -o /tmp/gateway_web.html -w "%{http_code}" "$GATEWAY_URL/")
if [ "$STATUS_WEB" != "200" ]; then
  echo "ERROR: Expected HTTP 200 for GET /, got $STATUS_WEB"
  exit 1
fi

grep -iq "doctype html" /tmp/gateway_web.html || { echo "ERROR: Missing HTML doctype in root response"; exit 1; }
echo "Web client routed successfully through APISIX (HTTP 200)."

# ------------------------------------------------------------------------------
# 2. GET /api/health -> Public Backend Health Endpoint
# ------------------------------------------------------------------------------
echo "[2/14] Verifying public API health route (GET /api/health)..."
STATUS_HEALTH=$(curl -s -o /tmp/gateway_health.json -w "%{http_code}" "$GATEWAY_URL/api/health")
if [ "$STATUS_HEALTH" != "200" ]; then
  echo "ERROR: Expected HTTP 200 for GET /api/health, got $STATUS_HEALTH"
  cat /tmp/gateway_health.json
  exit 1
fi

grep -q '"status":"ok"' /tmp/gateway_health.json || { echo "ERROR: Missing 'status: ok' in /api/health response"; exit 1; }
grep -q '"service":"smartprocure-api"' /tmp/gateway_health.json || { echo "ERROR: Missing 'service: smartprocure-api'"; exit 1; }
echo "Public API healthcheck routed successfully (HTTP 200)."

# ------------------------------------------------------------------------------
# 3. GET /api/auth/me without token -> 401 Unauthorized
# ------------------------------------------------------------------------------
echo "[3/14] Verifying protected route without token returns HTTP 401..."
STATUS_NO_AUTH=$(curl -s -o /tmp/gateway_no_auth.json -w "%{http_code}" "$GATEWAY_URL/api/auth/me")
if [ "$STATUS_NO_AUTH" != "401" ]; then
  echo "ERROR: Expected HTTP 401 for unauthenticated request, got $STATUS_NO_AUTH"
  cat /tmp/gateway_no_auth.json
  exit 1
fi
echo "Unauthenticated request rejected at gateway with HTTP 401."

# ------------------------------------------------------------------------------
# 4. GET /api/auth/me with invalid token -> 401 Unauthorized
# ------------------------------------------------------------------------------
echo "[4/14] Verifying protected route with forged token returns HTTP 401..."
STATUS_INVALID_TOKEN=$(curl -s -o /tmp/gateway_invalid_token.json -w "%{http_code}" \
  -H "Authorization: Bearer invalid.bogus.jwt" "$GATEWAY_URL/api/auth/me")
if [ "$STATUS_INVALID_TOKEN" != "401" ]; then
  echo "ERROR: Expected HTTP 401 for invalid bearer token, got $STATUS_INVALID_TOKEN"
  cat /tmp/gateway_invalid_token.json
  exit 1
fi
echo "Invalid bearer token rejected at gateway with HTTP 401."

# ------------------------------------------------------------------------------
# Fetch valid test tokens from Keycloak using dedicated CI client
# ------------------------------------------------------------------------------
echo "Fetching authentic test tokens from Keycloak..."
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

ADMIN_TOKEN=$(curl -s -X POST "$KEYCLOAK_URL/realms/$REALM/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=$CI_CLIENT_ID" \
  -d "grant_type=password" \
  -d "username=admin.demo" \
  -d "password=$DEMO_PASSWORD" | jq -r '.access_token // empty')

if [ -z "$ADMIN_TOKEN" ] || [ "$ADMIN_TOKEN" = "null" ]; then
  echo "ERROR: Failed to retrieve admin token from Keycloak"
  exit 1
fi
echo "Test tokens acquired successfully."

# Verify layered audiences in Keycloak token payload
echo "Verifying token contains layered audiences (smartprocure-gateway and smartprocure-api)..."
PAYLOAD=$(echo "$BUYER_TOKEN" | awk -F. '{print $2}' | tr -d '\r\n')
# Pad base64 string if needed
REM=$(( ${#PAYLOAD} % 4 ))
if [ $REM -eq 2 ]; then PAYLOAD="${PAYLOAD}=="; elif [ $REM -eq 3 ]; then PAYLOAD="${PAYLOAD}="; fi
DECODED_PAYLOAD=$(echo "$PAYLOAD" | base64 -d 2>/dev/null || echo "$PAYLOAD" | base64 --decode 2>/dev/null || true)

if [ -n "$DECODED_PAYLOAD" ]; then
  echo "$DECODED_PAYLOAD" | grep -q "smartprocure-gateway" || {
    echo "ERROR: Token audience missing smartprocure-gateway"
    echo "$DECODED_PAYLOAD"
    exit 1
  }
  echo "$DECODED_PAYLOAD" | grep -q "smartprocure-api" || {
    echo "ERROR: Token audience missing smartprocure-api"
    echo "$DECODED_PAYLOAD"
    exit 1
  }
  echo "Token payload audience verified: contains both smartprocure-gateway and smartprocure-api."
fi

# Verify APISIX is configured with smartprocure-gateway client
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -q "smartprocure-apisix"; then
  GATEWAY_CLIENT=$(docker exec smartprocure-apisix printenv APISIX_OIDC_CLIENT_ID || true)
  if [ -n "$GATEWAY_CLIENT" ] && [ "$GATEWAY_CLIENT" != "smartprocure-gateway" ]; then
    echo "ERROR: Expected APISIX_OIDC_CLIENT_ID to be smartprocure-gateway, got: $GATEWAY_CLIENT"
    exit 1
  fi
  echo "Verified APISIX is operating with dedicated smartprocure-gateway client."
fi

# ------------------------------------------------------------------------------
# 5. GET /api/auth/me with valid buyer token -> 200 OK
# ------------------------------------------------------------------------------
echo "[5/14] Verifying buyer token on GET /api/auth/me..."
STATUS_BUYER_ME=$(curl -s -o /tmp/gateway_buyer_me.json -w "%{http_code}" \
  -H "Authorization: Bearer $BUYER_TOKEN" "$GATEWAY_URL/api/auth/me")
if [ "$STATUS_BUYER_ME" != "200" ]; then
  echo "ERROR: Expected HTTP 200 for buyer /api/auth/me, got $STATUS_BUYER_ME"
  cat /tmp/gateway_buyer_me.json
  exit 1
fi

grep -q '"username":"buyer.demo"' /tmp/gateway_buyer_me.json || { echo "ERROR: Expected buyer.demo in me profile"; exit 1; }
grep -q '"buyer"' /tmp/gateway_buyer_me.json || { echo "ERROR: Expected role buyer in me profile"; exit 1; }
echo "Buyer authenticated successfully through APISIX (HTTP 200)."

# ------------------------------------------------------------------------------
# 6. GET /api/auth/buyer-test with buyer token -> 200 OK
# ------------------------------------------------------------------------------
echo "[6/14] Verifying buyer token on GET /api/auth/buyer-test..."
STATUS_BUYER_TEST=$(curl -s -o /tmp/gateway_buyer_test.json -w "%{http_code}" \
  -H "Authorization: Bearer $BUYER_TOKEN" "$GATEWAY_URL/api/auth/buyer-test")
if [ "$STATUS_BUYER_TEST" != "200" ]; then
  echo "ERROR: Expected HTTP 200 on /api/auth/buyer-test, got $STATUS_BUYER_TEST"
  cat /tmp/gateway_buyer_test.json
  exit 1
fi
echo "Buyer access to /api/auth/buyer-test verified (HTTP 200)."

# ------------------------------------------------------------------------------
# 7. GET /api/auth/admin-test with buyer token -> 403 Forbidden (RBAC)
# ------------------------------------------------------------------------------
echo "[7/14] Verifying buyer token on GET /api/auth/admin-test produces HTTP 403..."
STATUS_BUYER_ADMIN=$(curl -s -o /tmp/gateway_buyer_admin.json -w "%{http_code}" \
  -H "Authorization: Bearer $BUYER_TOKEN" "$GATEWAY_URL/api/auth/admin-test")
if [ "$STATUS_BUYER_ADMIN" != "403" ]; then
  echo "ERROR: Expected HTTP 403 for buyer accessing admin endpoint, got $STATUS_BUYER_ADMIN"
  cat /tmp/gateway_buyer_admin.json
  exit 1
fi

grep -q '"Forbidden"' /tmp/gateway_buyer_admin.json || { echo "ERROR: Missing Forbidden in 403 response"; exit 1; }
echo "RBAC authorization guard enforced successfully (HTTP 403)."

# ------------------------------------------------------------------------------
# 8. GET /api/auth/admin-test with admin token -> 200 OK
# ------------------------------------------------------------------------------
echo "[8/14] Verifying admin token on GET /api/auth/admin-test produces HTTP 200..."
STATUS_ADMIN_TEST=$(curl -s -o /tmp/gateway_admin_test.json -w "%{http_code}" \
  -H "Authorization: Bearer $ADMIN_TOKEN" "$GATEWAY_URL/api/auth/admin-test")
if [ "$STATUS_ADMIN_TEST" != "200" ]; then
  echo "ERROR: Expected HTTP 200 for admin accessing admin endpoint, got $STATUS_ADMIN_TEST"
  cat /tmp/gateway_admin_test.json
  exit 1
fi
echo "Admin access to /api/auth/admin-test verified (HTTP 200)."

# ------------------------------------------------------------------------------
# 9. CORS Preflight on Protected Route (/api/auth/me) with allowed origin
# ------------------------------------------------------------------------------
echo "[9/14] Verifying CORS preflight on protected route (/api/auth/me) with allowed origin..."
CORS_HEADERS=$(curl -s -i -X OPTIONS "$GATEWAY_URL/api/auth/me" \
  -H "Origin: http://localhost:3000" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: Authorization,Content-Type")

echo "$CORS_HEADERS" | grep -iqE "HTTP/.* (200|204)" || {
  echo "ERROR: Expected HTTP 200/204 for OPTIONS preflight, got:"
  echo "$CORS_HEADERS"
  exit 1
}

echo "$CORS_HEADERS" | grep -iq "access-control-allow-origin: http://localhost:3000" || {
  echo "ERROR: Missing or incorrect Access-Control-Allow-Origin for allowed origin"
  echo "$CORS_HEADERS"
  exit 1
}

echo "$CORS_HEADERS" | grep -iq "access-control-allow-credentials: true" || {
  echo "ERROR: Missing Access-Control-Allow-Credentials: true"
  echo "$CORS_HEADERS"
  exit 1
}

echo "$CORS_HEADERS" | grep -iqE "access-control-allow-methods:.*GET" || {
  echo "ERROR: Missing GET in Access-Control-Allow-Methods"
  echo "$CORS_HEADERS"
  exit 1
}

echo "$CORS_HEADERS" | grep -iqE "access-control-allow-headers:.*(authorization|content-type)" || {
  echo "ERROR: Missing expected headers in Access-Control-Allow-Headers"
  echo "$CORS_HEADERS"
  exit 1
}
echo "Protected route CORS preflight verified successfully (no Bearer token required)."

# ------------------------------------------------------------------------------
# 10. CORS Preflight on Protected Route (/api/auth/me) with disallowed origin
# ------------------------------------------------------------------------------
echo "[10/14] Verifying CORS preflight on protected route (/api/auth/me) with disallowed origin..."
DISALLOWED_CORS=$(curl -s -i -X OPTIONS "$GATEWAY_URL/api/auth/me" \
  -H "Origin: http://unauthorized-hacker-domain.com" \
  -H "Access-Control-Request-Method: GET")

if echo "$DISALLOWED_CORS" | grep -iq "access-control-allow-origin: http://unauthorized-hacker-domain.com"; then
  echo "ERROR: Gateway permissively allowed an unauthorized origin on protected route!"
  echo "$DISALLOWED_CORS"
  exit 1
fi
echo "Disallowed origin correctly rejected from CORS response on protected route."

# ------------------------------------------------------------------------------
# 11. Rate Limiting Enforcement (exceed quota -> HTTP 429)
# ------------------------------------------------------------------------------
echo "[11/14] Verifying rate limit enforcement on /api/rate-limit-test (5 requests / 10s)..."
GOT_429=0
for i in $(seq 1 8); do
  CODE=$(curl -s -o /tmp/rate_resp.json -w "%{http_code}" "$GATEWAY_URL/api/rate-limit-test" || true)
  if [ "$CODE" = "429" ]; then
    echo "Rate limit exceeded as expected on request $i (HTTP 429 Too Many Requests)."
    GOT_429=1
    break
  fi
done

if [ "$GOT_429" -ne 1 ]; then
  echo "ERROR: Rate limiting failed to trigger HTTP 429 after 8 rapid requests"
  exit 1
fi
echo "APISIX limit-count plugin verified successfully."

# ------------------------------------------------------------------------------
# 12. Prometheus Metrics Endpoint
# ------------------------------------------------------------------------------
echo "[12/14] Verifying Prometheus metrics exporter on $METRICS_URL/apisix/prometheus/metrics..."
STATUS_METRICS=$(curl -s -o /tmp/metrics.txt -w "%{http_code}" "$METRICS_URL/apisix/prometheus/metrics")
if [ "$STATUS_METRICS" != "200" ]; then
  echo "ERROR: Expected HTTP 200 from Prometheus exporter, got $STATUS_METRICS"
  exit 1
fi

grep -qE "apisix_http_requests_total|apisix_http_status" /tmp/metrics.txt || {
  echo "ERROR: Expected APISIX request metrics in Prometheus export"
  head -n 20 /tmp/metrics.txt
  exit 1
}
echo "APISIX Prometheus metrics exporter verified successfully."

# ------------------------------------------------------------------------------
# 13. Direct NestJS JWT Validation (Defense in Depth Preservation)
# ------------------------------------------------------------------------------
echo "[13/14] Verifying direct NestJS container health and JWT validation (Defense in Depth)..."
DIRECT_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "$DIRECT_API_URL/health")
if [ "$DIRECT_HEALTH" != "200" ]; then
  echo "ERROR: Direct API health failed with HTTP $DIRECT_HEALTH"
  exit 1
fi

DIRECT_BUYER=$(curl -s -o /tmp/direct_buyer.json -w "%{http_code}" \
  -H "Authorization: Bearer $BUYER_TOKEN" "$DIRECT_API_URL/auth/me")
if [ "$DIRECT_BUYER" != "200" ]; then
  echo "ERROR: Direct API authentication failed with HTTP $DIRECT_BUYER"
  exit 1
fi
echo "Direct NestJS container health and JWT validation verified."

# ------------------------------------------------------------------------------
# 14. Anti-Spoofing: Gateway Strips Injected Identity Headers
# ------------------------------------------------------------------------------
echo "[14/15] Verifying anti-spoofing header stripping..."
SPOOF_STATUS=$(curl -s -o /tmp/spoof_resp.json -w "%{http_code}" \
  -H "Authorization: Bearer $BUYER_TOKEN" \
  -H "X-User-Sub: spoofed_admin_sub" \
  -H "X-User-Roles: admin" \
  "$GATEWAY_URL/api/auth/admin-test")

if [ "$SPOOF_STATUS" != "403" ]; then
  echo "ERROR: Injected X-User-Roles spoofed the backend! Expected 403, got $SPOOF_STATUS"
  cat /tmp/spoof_resp.json
  exit 1
fi
echo "Injected identity headers safely ignored/stripped. NestJS cryptographic JWT remains source of truth."

# ------------------------------------------------------------------------------
# 15. Purchase Order Routing Through APISIX Gateway (Issue #5)
# ------------------------------------------------------------------------------
echo "[15/15] Verifying Purchase Order API routing through APISIX Gateway..."
PO_UNAUTH=$(curl -s -o /tmp/po_unauth.json -w "%{http_code}" "$GATEWAY_URL/api/purchase-orders")
if [ "$PO_UNAUTH" != "401" ]; then
  echo "ERROR: Expected HTTP 401 for unauthenticated PO request via gateway, got $PO_UNAUTH"
  cat /tmp/po_unauth.json
  exit 1
fi

PO_AUTH=$(curl -s -o /tmp/po_auth.json -w "%{http_code}" \
  -H "Authorization: Bearer $BUYER_TOKEN" "$GATEWAY_URL/api/purchase-orders")
if [ "$PO_AUTH" != "200" ]; then
  echo "ERROR: Expected HTTP 200 for buyer token accessing PO list via gateway, got $PO_AUTH"
  cat /tmp/po_auth.json
  exit 1
fi
echo "Purchase Order API routing through APISIX Gateway verified successfully."

echo "=========================================================="
echo "SUCCESS: All 15 Apache APISIX Gateway tests passed!"
echo "=========================================================="


