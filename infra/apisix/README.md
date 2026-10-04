# Apache APISIX Gateway Configuration

This directory contains the declarative infrastructure configuration for **Apache APISIX** (`3.19.0-debian`) deployed as the unified entry point for **SmartProcure-Pay** (GitHub Issue #4).

---

## Architecture Overview

```
                      +---------------------------------------+
                      |   Client Browser / Mobile / Testing   |
                      +---------------------------------------+
                                          |
                                          v HTTP :9080
                      +---------------------------------------+
                      |       Apache APISIX API Gateway       |
                      |  (Standalone Mode - Declarative YAML) |
                      +---------------------------------------+
                             /            |            \
            GET /*          /     GET /api/health       \     /api/* (Protected)
                           /              |              \    (OIDC Token Verification)
                          v               v               v
             +------------------+  +--------------------------------+
             | smartprocure-web |  |        smartprocure-api        |
             |   (Nginx / SPA)  |  |       (NestJS Port 4000)       |
             |      Port 80     |  +--------------------------------+
             +------------------+                 |
                                                  v
                                      +-------------------------+
                                      |   PostgreSQL Database   |
                                      +-------------------------+
```

---

## File Directory

- `config.yaml`: Core APISIX deployment settings, configuring standalone mode (`role: data_plane`, `config_provider: yaml`), disabling public Admin API, enabling Prometheus exporter on internal port `9091`, and routing access logs to `/dev/stdout`.
- `apisix.yaml`: Declarative definition of routes, upstreams, and plugins (`proxy-rewrite`, `openid-connect`, `cors`, `limit-count`, `prometheus`). Must end with the `#END` marker.
- `validate-apisix-gateway.sh`: Automated validation test suite verifying gateway routing, OIDC token rejection/acceptance, CORS headers, rate limiting (429), and Prometheus metrics.

---

## Routing & Security Matrix

| Route Pattern | Upstream | Authentication | Plugins Active | Priority |
| :--- | :--- | :--- | :--- | :--- |
| `/*` | `smartprocure-web:80` | Public | None | `0` |
| `/api/health` | `smartprocure-api:4000/health` | Public | `proxy-rewrite`, `cors`, `limit-count`, `prometheus` | `10` |
| `/api/rate-limit-test` | `smartprocure-api:4000/health` | Public | `proxy-rewrite`, `cors`, `limit-count` (5/10s), `prometheus` | `20` |
| `/api/*` | `smartprocure-api:4000/*` | Keycloak Bearer JWT Required | `proxy-rewrite`, `openid-connect`, `cors`, `limit-count`, `prometheus` | `5` |

---

## Defense in Depth Strategy

1. **Gateway Layer (APISIX)**:
   - Validates JWT signature against Keycloak JWKS (`/protocol/openid-connect/certs`).
   - Validates token expiration (`exp`) and issuer (`iss`).
   - Enforces audience claim matching `smartprocure-api`.
   - Strips client-supplied spoofing headers (`X-User-*`).
   - Rate limits traffic using `limit-count` (100 req/60s).
   - Rejects unauthenticated/invalid requests with `401 Unauthorized`.

2. **Backend Application Layer (NestJS)**:
   - `JwtAuthGuard` cryptographically re-verifies JWT signature and audience `smartprocure-api`.
   - `RolesGuard` evaluates domain role authorization (`admin`, `buyer`, etc.).
   - Returns `403 Forbidden` if role is insufficient.

---

## Prometheus Metrics

APISIX exposes Prometheus metrics on internal port `9091`:
```bash
curl http://localhost:9091/apisix/prometheus/metrics
```
