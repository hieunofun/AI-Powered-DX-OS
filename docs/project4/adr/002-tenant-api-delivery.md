# ADR-002 — Versioned contracts with server-derived tenant and durable operations

Date: 2026-10-14. Status: proposed, awaiting peer review in #37. Owner A; reviewers B/C.

## Context

Frontend/OCR work can proceed in parallel only when identity, decimal, source provenance, state and failure semantics agree. PR3 independently verifies JWT issuer/audience/JWKS, uses decimal.js and persistent workflow intents, but has no tenant context or reviewed OCR persistence.

## Decision

Use `/platform/v1` for generic targets and `/apps/openresolve/v1` for pack targets, while preserving existing unversioned PR3 routes. Publish OpenAPI 3.0.3 and standalone JSON Schema draft-07 in the shared schema subset (no incompatible nullable/boolean exclusive bounds). This works with the existing Node 20 toolchain and permits independently validated examples. OAS 3.1/2020-12 would provide fuller schema alignment but would require changing the current validator/toolchain; defer until needed.

Tenant and actor come from independently verified identity plus server membership/grants. Require a signed `active_tenant_id` claim for target requests, validated against active server membership. Never accept body/query/header tenant override. Switching tenants requires an authenticated identity flow issuing a token for an authorized membership; UI switching endpoint/Keycloak mapper setup is detailed in #43. Missing context returns 400 TENANT_CONTEXT_REQUIRED, bad JWT 401, unavailable membership dependency 503. Service principals are explicitly mapped to tenant + allowlisted actions/resources, without assuming user realm roles. Resource access is denied by default and rechecked by workers/tool execution. Cross-tenant resource IDs return the same 404 NOT_FOUND as absent IDs; authorized in-tenant but disallowed actions return 403. No default cross-tenant support/admin privilege.

Start with application resource checks and tenant-predicated queries using the existing PostgreSQL store; evaluate RLS deployment under #43. Trusting an arbitrary X-Tenant-ID, UI-only filters or unscoped service-admin identities is rejected.

All mutable commands require a scoped idempotency key and durable intent. Tenant+principal+method+route+key identify a request; bind exact payload hash (canonical JSON for JSON bodies, verified byte hash for uploads). Persist a unique record/result transactionally with outbox. Same key and same payload returns persisted status/result and current authorized access; a different payload returns 409 IDEMPOTENCY_CONFLICT. Durable operation recovery retains business uniqueness even beyond the minimum 24-hour HTTP response cache; purging a cache must not permit re-execution of a still-valid domain command. No keys or raw documents in logs.

POST accepted work returns 202 plus a durable operation reference; PENDING is not completed. An ambiguous external result becomes RECONCILIATION_REQUIRED and requires evidence before redispatch. Timeout must not release reservations or mark confirmed success. Reuse PR3 durable-operation approach instead of introducing a broker or 'retry every exception' behavior.

Choose backend-mediated byte upload/download for the first wave. Requests use bearer auth on the same gateway; no public/presigned object URL bypasses quarantine or current ACL. Registration expires upload entitlement after 15 minutes; bytes must match registered metadata and server hash. Download checks CLEAN and authorization every request. A direct S3 upload policy could reduce API throughput but requires additional short-lived auth, hash/scan completion and revocation design; defer until necessary.

Keep quantities/unit prices NUMERIC(18,4), amounts NUMERIC(18,2), VAT fractions at four decimal places, matching PR3. Wire values are unsigned plain decimal strings; pack arithmetic uses the existing isolated Decimal context/ROUND_HALF_UP. Schema validation checks representation, while deterministic domain validation checks positive quantities, totals and business policy. LLMs never calculate financial verdicts.

## Alternatives and consequences

String IDs plus UTC timestamps/cursors keep clients portable; locale formatting happens in vi-VN UI. Whole-request floats and server-generated rounding of invalid excess precision are rejected. A chosen AI provider/model is not forced in architecture: #38 picks one with disclosed cost/terms and evaluation. AV engine choice/license is a #41 gate; failed/unavailable scan is not CLEAN. JSON Schema/examples do not establish runtime acceptance or security. See API_CONVENTIONS and CONTRACT_STATUS for exact first-wave behavior and deferred semantics.
