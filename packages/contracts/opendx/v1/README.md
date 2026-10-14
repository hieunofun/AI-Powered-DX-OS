# OpenDX Fabric v1 contract review candidate

Artifact version 0.1.0, OpenAPI 3.0.3, JSON Schema draft-07. All API paths are targets; this package does not implement or enable routes. First-wave schemas cover server-derived context, evidence/byte transfer/quarantine, OCR draft/source/correction/confirmation and durable operations. Later contracts are explicitly marked skeletons in OpenAPI and [the status matrix](../../../../docs/project4/CONTRACT_STATUS.md).

- `openapi.json`: bundled specification, operation permissions, errors and embedded request/response examples.
- `schemas/platform.schema.json`: reusable core definitions; no procurement/HR vocabulary.
- `schemas/openresolve.schema.json`: pack-owned invoice payload/decimal and receipt/case definitions.
- `fixtures/manifest.json`: every positive/negative example's schema, expected validity and purpose. All data is synthetic, not runtime results; the sample PDF metadata is not an uploaded document.
- `../validate.cjs`: offline OAS/reference/schema/example checks plus targeted negative fixtures and metadata invariants.

From the repository root: `npm ci`, then `npm run test:contracts`. CI runs this before the existing build/lint/unit/E2E/full-stack pipeline without removing PR3 checks. To validate one standalone definition, register the schema with Ajv and compile its `#/definitions/<Name>` pointer. Frontend/AI consumers can use the same OpenAPI/fixtures while avoiding business assumptions marked pending.

The validator uses development-only `@apidevtools/swagger-parser@10.1.0` and `ajv@6.15.0`, both MIT and pinned in package-lock. They provide OAS structure/ref checking and JSON Schema/example validation respectively; no additional runtime dependency. Licenses/notices are recorded in OPEN_SOURCE_COMPONENTS. The OAS/draft-07 shared subset intentionally avoids nullable and dialect mismatches; see [OpenAPI 3.0.3](https://spec.openapis.org/oas/v3.0.3.html) and [Ajv schema documentation](https://ajv.js.org/json-schema.html).

Structural JSON validation does not enforce ledger trust, tenant ownership, actual AV scanning, financial totals or business state transitions. These require deterministic backend checks and runtime tests in the linked issues. KnownSource geometry/text offset constraints and financial/quantity conservation must be checked by the implementation; unknown locations are explicitly represented.
