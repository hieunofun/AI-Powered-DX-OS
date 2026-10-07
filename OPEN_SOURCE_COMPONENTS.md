# Open Source Components Inventory

This document tracks external software evaluated and integrated into **SmartProcure-Pay**, including open-source and explicitly identified source-available components.

Issue #10 corrects the stale ImmuDB license entry: the selected release is BUSL-1.1 source-available software, not currently Apache-2.0 or OSI-approved open source. Version-specific provenance and limitations follow the registry.

---

## Component Registry

| Component | Repository | Version | License | Role | Integration Type | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Keycloak** | [keycloak/keycloak](https://github.com/keycloak/keycloak) | `24.0.5` | Apache-2.0 | Identity & Access Management (SSO, OIDC, RBAC) | Docker Service | Integrated (Pinned known-working version) |
| **Apache APISIX** | [apache/apisix](https://github.com/apache/apisix) | `3.19.0` | Apache-2.0 | API Gateway (Reverse proxy, rate limiting, routing, JWT validation) | Docker Service | Integrated (Issue #4) |
| **PostgreSQL** | [postgres/postgres](https://github.com/postgres/postgres) | `16-alpine` | PostgreSQL License | Primary Relational Data Store (Domain models, ledger transactions) | Docker Service | Service Defined |
| **MinIO** | [minio/minio](https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z) | `RELEASE.2025-10-15T17-29-55Z`, commit `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a` | GNU AGPLv3 | Private raw invoice archival | Unmodified external service, built from official source | Integrated (Issue #7; upstream images unavailable) |
| **MinIO JavaScript SDK** | [minio/minio-js](https://github.com/minio/minio-js/tree/8.0.7) | `8.0.7` exact | Apache-2.0 | Object upload/stat/read/delete, SHA-256 metadata | Dependency | Integrated (Issue #7) |
| **fast-xml-parser** | [NaturalIntelligence/fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser/tree/v5.11.2) | `5.11.2` exact | MIT | Secure validation and deterministic XML field extraction | Dependency | Integrated (Issue #7) |
| **@types/multer** | [DefinitelyTyped/DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/multer) | `2.3.0` exact | MIT | Compile-time multipart upload types | Dev dependency | Integrated (Issue #7) |
| **Go** | [golang/go](https://github.com/golang/go/tree/go1.24.9) | `1.24.9` | BSD-3-Clause | Build unmodified MinIO source in container | Build tool | Integrated (Issue #7) |
| **Flowable** | [flowable/flowable-engine](https://github.com/flowable/flowable-engine) | `8.0.0` | Apache-2.0 | Invoice approval/exception BPMN orchestration | Official REST Docker service; native Node fetch client | Integrated (Issue #9) |
| **ImmuDB** | [codenotary/immudb v1.11.0](https://github.com/codenotary/immudb/tree/v1.11.0) | `1.11.0` exact | BUSL-1.1; future Change License Apache-2.0 | Independent tamper-evident audit ledger | Pinned official Docker service; PostgreSQL wire SQL | Integrated (Issue #10) |
| **ImmuDB Go client** | [tagged client source](https://github.com/codenotary/immudb/tree/v1.11.0/pkg/client) | `v1.11.0` exact | BUSL-1.1, same tagged LICENSE | Actual inclusion/dual proof validation | Internal isolated native gRPC verifier | Integrated (Issue #10) |
| **Go (audit verifier)** | [golang/go](https://github.com/golang/go/tree/go1.27.1) | `1.27.1` | BSD-3-Clause | Build and test isolated verifier | Build tool | Integrated (Issue #10) |
| **PDFKit** | [foliojs/pdfkit v0.20.2](https://github.com/foliojs/pdfkit/tree/v0.20.2) | `0.20.2` exact | MIT | Human-readable audit PDF with paired JSON attachment | API dependency | Integrated (Issue #10) |
| **@types/pdfkit** | [DefinitelyTyped types](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/pdfkit) | `0.17.6` exact | MIT | PDFKit compile-time types | Dev dependency | Integrated (Issue #10) |
| **Noto Sans** | [google/fonts pinned source](https://github.com/google/fonts/tree/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/notosans) | commit `8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5` | SIL OFL-1.1 | Vietnamese/Unicode PDF rendering | Bundled font and OFL notice | Integrated (Issue #10) |
| **Prometheus** | [prometheus/prometheus](https://github.com/prometheus/prometheus) | `v2.51.x` | Apache-2.0 | System & Business Metrics Monitoring | Docker Service | Planned |
| **Grafana** | [grafana/grafana](https://github.com/grafana/grafana) | `10.4.x` | GNU AGPLv3 | Operational & Observability Dashboards | Docker Service | Planned |
| **React** | [facebook/react](https://github.com/facebook/react) | `^18.3.1` | MIT | Web UI Frontend Application Framework | Dependency | Integrated |
| **keycloak-js** | [keycloak/keycloak](https://github.com/keycloak/keycloak/tree/main/packages/keycloak-js) | `24.0.5` | Apache-2.0 | Frontend OIDC Client Adapter with PKCE Authorization | Dependency | Integrated |
| **NestJS** | [nestjs/nest](https://github.com/nestjs/nest) | `^10.3.9` | MIT | Backend Application Framework & Modular Services | Dependency | Integrated |
| **jsonwebtoken** | [auth0/node-jsonwebtoken](https://github.com/auth0/node-jsonwebtoken) | `^9.0.3` | MIT | JSON Web Token (JWT) Verification and Claims Extraction | Dependency | Integrated |
| **jwks-rsa** | [auth0/node-jwks-rsa](https://github.com/auth0/node-jwks-rsa) | `^3.2.2` | MIT | Retrieval and Caching of RSA Signing Keys from JWKS Endpoints | Dependency | Integrated |
| **@types/jsonwebtoken** | [DefinitelyTyped/DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) | `^9.0.10` | MIT | TypeScript Type Definitions for jsonwebtoken | Dependency | Integrated |
| **Vite** | [vitejs/vite](https://github.com/vitejs/vite) | `^5.3.1` | MIT | Frontend Build Tooling & Development Server | Dependency | Integrated |
| **TypeScript** | [microsoft/TypeScript](https://github.com/microsoft/TypeScript) | `^5.4.5` | Apache-2.0 | Static Type Checking and Code Compilation | Dependency | Integrated |
| **Supertest** | [ladjs/supertest](https://github.com/ladjs/supertest) | `^7.0.0` | MIT | HTTP Assertions for E2E Health Testing | Dependency | Integrated |
| **Jest** | [jestjs/jest](https://github.com/jestjs/jest) | `^29.7.0` | MIT | Test Runner and Assertion Framework | Dependency | Integrated |
| **ESLint** | [eslint/eslint](https://github.com/eslint/eslint) | `^8.57.1` | MIT | Pluggable JavaScript & TypeScript Linter | Dependency | Integrated |
| **typescript-eslint** | [typescript-eslint/typescript-eslint](https://github.com/typescript-eslint/typescript-eslint) | `^7.18.0` | BSD-2-Clause | Tooling for TypeScript Linting Integration | Dependency | Integrated |
| **eslint-plugin-react-hooks** | [facebook/react](https://github.com/facebook/react/tree/main/packages/eslint-plugin-react-hooks) | `^4.6.2` | MIT | React Hooks Rules Enforcement | Dependency | Integrated |
| **eslint-plugin-react** | [jsx-eslint/eslint-plugin-react](https://github.com/jsx-eslint/eslint-plugin-react) | `^7.37.5` | MIT | React-Specific Linting Rules | Dependency | Integrated |
| **pg** | [brianc/node-postgres](https://github.com/brianc/node-postgres) | `^8.23.1` | MIT | PostgreSQL Client for Node.js (Connection pooling, transactional SQL) | Dependency | Integrated (Issue #5) |
| **class-validator** | [typestack/class-validator](https://github.com/typestack/class-validator) | `^0.14.4` | MIT | Decorator-based DTO validation | Dependency | Integrated (Issue #5) |
| **class-transformer** | [typestack/class-transformer](https://github.com/typestack/class-transformer) | `^0.5.1` | MIT | Object transformation and type conversion | Dependency | Integrated (Issue #5) |
| **@nestjs/swagger** | [nestjs/swagger](https://github.com/nestjs/swagger) | `^7.4.2` | MIT | OpenAPI (Swagger) module for NestJS | Dependency | Integrated (Issue #5) |
| **swagger-ui-express** | [scottie1984/swagger-ui-express](https://github.com/scottie1984/swagger-ui-express) | `^5.0.1` | MIT | Serve Swagger UI assets from Express | Dependency | Integrated (Issue #5) |
| **decimal.js** | [MikeMcl/decimal.js](https://github.com/MikeMcl/decimal.js) | `^10.6.0` | MIT | Arbitrary-precision decimal arithmetic for financial calculations | Dependency | Integrated (Issue #5) |

---

## ImmuDB and PDF Issue #10 provenance

- Release: [v1.11.0](https://github.com/codenotary/immudb/releases/tag/v1.11.0), published 2026-04-28; exact [tagged LICENSE](https://github.com/codenotary/immudb/blob/v1.11.0/LICENSE) is Business Source License 1.1. The complete notice is retained in [immudb-v1.11.0-BUSL-1.1.txt](docs/open-source/notices/immudb-v1.11.0-BUSL-1.1.txt) and the verifier image.
- License correction: the previous planned `v1.9.x / Apache-2.0` row did not describe this release. BUSL is source-available and restricts production uses outside its Additional Use Grant; it must not be presented as MIT/Apache permissive open source. The user's Issue #10 instruction explicitly selects this component; [the policy exception](docs/open-source/LICENSE_POLICY.md#5-issue-10-source-available-exception) records that scope.
- Additional Use Grant: production use is allowed provided it does not offer the work to third parties on a hosted or embedded basis to compete with Codenotary's paid versions, as defined in the LICENSE. A competitive offering is paid (including paid support) and significantly overlaps those capabilities. Unpaid products and internal organizational use, including affiliates under common control, are excluded from that definition. Embedded includes packaging that requires downloading/accessing the work. Uses outside the grant require an appropriate commercial license or refraining from that use. Deployment/distribution decisions must follow the full terms.
- Future license: Change Date is four years from publication; the terms also apply the Change License on the fourth anniversary of the first public distribution of the specific version, if earlier. Apache-2.0 is that future Change License, not the current release license. No earlier version's conversion is attributed to 1.11.0.
- Official image: [Docker Hub tag metadata](https://hub.docker.com/v2/repositories/codenotary/immudb/tags/1.11.0) identifies `codenotary/immudb:1.11.0@sha256:460cb34bb0a690ee743336a174c59f2f24edf79dd00c26d936717495db32d1cf`, linux/amd64. Compose pins both tag and digest. Authentication is enabled, SQL is internal port 5432 and native gRPC internal port 3322; only development SQL port 5433 is published on loopback.
- Exact wire semantics: [tagged SQL wrappers](https://github.com/codenotary/immudb/blob/v1.11.0/pkg/pgsql/server/immudb_functions.go) implement `immudb_state()`, `immudb_verify_row(table, primaryKey)` and `immudb_verify_tx(txId)`. The verification wrappers fetch verifiable data and return string `true`; they do not perform client cryptographic verification. SmartProcure therefore uses the existing Node `pg` dependency for SQL and an isolated official Go client for [VerifyRow](https://github.com/codenotary/immudb/blob/v1.11.0/pkg/client/sql.go) and [VerifiedTxByID](https://github.com/codenotary/immudb/blob/v1.11.0/pkg/client/client.go), with persistent trust state. No ImmuDB npm SDK is added. `go.mod/go.sum` pin the client and its dependencies; each dependency retains its own license terms.
- Exact state limitation: tagged `pkg/database/database.go` CurrentState omits the Db field, so the wire `immudb_state()` db column is empty. Bootstrap validates this actual behavior and real transaction/hash fields rather than fabricating a database-name receipt; native verification uses the configured authenticated database.
- PDF: [PDFKit v0.20.2 LICENSE](https://github.com/foliojs/pdfkit/blob/v0.20.2/LICENSE) is MIT. Exact npm versions and integrity hashes are locked. The upstream library handles PDF serialization; Poppler `pdftotext` is used only as a CI parser, not an API dependency. Bundled Noto Sans comes from the pinned upstream commit above, with OFL notice; font SHA-256 is `bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d`.

## Flowable Issue #9 provenance

- Exact engine release: [Flowable OSS 8.0.0](https://github.com/flowable/flowable-engine/releases/tag/flowable-8.0.0), published 2026-02-27 and the latest stable upstream release verified on 2026-10-05. The source uses Spring Boot 4/Spring 7; SmartProcure integrates over REST and does not embed those Java dependencies.
- License: [Apache-2.0 at the exact release tag](https://github.com/flowable/flowable-engine/blob/flowable-8.0.0/LICENSE).
- Image: `flowable/flowable-rest:8.0.0` from the upstream Flowable Docker Hub namespace. The [official REST installation instructions](https://github.com/flowable/flowable-engine/blob/flowable-8.0.0/docs/public-api/README.md) identify this image. [Tag metadata](https://hub.docker.com/v2/repositories/flowable/flowable-rest/tags/8.0.0) was verified against manifest digest `sha256:708dfa32f27b93180bb6e7a30684d881d995fe257f5b8413e14b20a55c25672d` and its linux/amd64 and linux/arm64 images. Compose pins the exact tag and manifest digest.
- REST compatibility: the tagged [TaskResource](https://github.com/flowable/flowable-engine/blob/flowable-8.0.0/modules/flowable-rest/src/main/java/org/flowable/rest/service/api/runtime/task/TaskResource.java) and [HistoricTaskInstanceCollectionResource](https://github.com/flowable/flowable-engine/blob/flowable-8.0.0/modules/flowable-rest/src/main/java/org/flowable/rest/service/api/history/HistoricTaskInstanceCollectionResource.java) define the claim/complete, local completion variables and historic task queries used for recovery. The real CI suite exercises deployment, start, task identity, claim, completion and history with this exact image.
- Integration is the standalone REST engine with a dedicated PostgreSQL store. The prior planned 6.8.x entry is replaced. No Flowable UI or new client library is introduced; native Node fetch and existing dependencies are sufficient. Upstream/image notices remain in the unmodified image. Component and base-image licenses retain their own terms.

## License Compliance & Version Notes

1. **Keycloak Versioning Review**:
   - Pinned known-working version: `24.0.5`.
   - Keycloak `26.8.0` (released October 2026) was evaluated. Keycloak 26 introduced substantial breaking changes in realm JSON export format, role mapping locations, Infinispan Marshalling, and session persistence requirements. Furthermore, `keycloak-js` on npm currently only extends up to `26.2.4`.
   - To avoid unnecessary pipeline flakiness and maintain reproducible zero-configuration realm import, `24.0.5` is pinned as the known-working baseline. Upgrading to the 26.x series is cataloged as a planned security-hardening follow-up.

2. **Apache APISIX Versioning & Architecture Review**:
   - Pinned exact stable upstream release: `3.19.0` (Docker image: `apache/apisix:3.19.0-debian`, released September 28, 2026, licensed under Apache-2.0).
   - Upstream evaluation confirmed `3.19.0` fixes previous batch request DoS vulnerabilities, introduces enhanced `claim_validator.audience` enforcement, and provides mature standalone mode (`config_provider: yaml`).
   - Deployment mode: **Standalone data plane**. By declaring routes, upstreams, and plugins directly in Git (`infra/apisix/apisix.yaml`), we avoid the operational overhead and failure points of a dedicated etcd cluster for single-node development and CI while ensuring complete infrastructure reproducibility.

3. **Permissive Licenses (Apache-2.0, MIT, PostgreSQL License)**:
   - Permissive licenses allow distribution, modification, and integration with minimal obligations beyond preserving copyright notices and disclaimers.
   - SmartProcure-Pay's MIT License is fully compatible with consuming these upstream projects.

3. **AGPL-3.0 Components (MinIO, Grafana)**:
   - MinIO and Grafana are used as unmodified external services (deployed via container orchestration).
   - Any distribution or deployment license obligations must be respected in accordance with their respective upstream licenses.
   - For internal guidelines on adding new dependencies, see [License Policy](docs/open-source/LICENSE_POLICY.md).

## Issue #7 newly introduced npm transitive packages

### External XML format reference (no code dependency)

The Matbao-invoice/MIFI PBan 2.0.0 VAT adapter references the provider's public [XML layout example](https://matbao.in/articles/cau-truc-hoa-don-theo-nd-123) and [field tables](https://matbao.in/articles/quyet-dinh-so-1510-qd-tct-bo-sung-quyet-dinh-1450-2020). Only format/documentation facts were referenced; no external code, article prose or verbatim complete sample was copied, and no npm dependency was added. The fixture contains independently authored fictional test data. No OSS license is asserted for the provider documentation; project-authored adapter/test code remains under the repository MIT license. See [fixture provenance](infra/invoice/fixtures/README.md) for the exact source, scope and limitations.

### Package inventory

The `@nodable/entities@3.1.0` npm archive declares MIT but omits its license file. The official [upstream MIT license at commit ac48e7ea591da372be023a481875c747535812b3](https://github.com/nodable/val-parsers/blob/ac48e7ea591da372be023a481875c747535812b3/LICENSE) is preserved in `docs/open-source/notices/nodable-val-parsers-MIT.txt` and copied into the API runtime image. Other introduced npm artifacts retain their packaged license files.

Exact versions and declared licenses below were verified from installed npm package manifests and their packaged license metadata; package-lock.json pins integrity hashes. Direct integrations are listed above. These packages support the SDK/XML parser. MinIO source dependencies remain governed by the pinned upstream go.mod/go.sum and distribution notices.

| Component | Official upstream | Exact version | License | Purpose |
| --- | --- | --- | --- | --- |
| @nodable/entities | [upstream](https://github.com/nodable/val-parsers) | 3.1.0 | MIT | SDK/XML transitive dependency |
| anynum | [upstream](https://github.com/NaturalIntelligence/anynum) | 1.0.1 | MIT | SDK/XML transitive dependency |
| async | [upstream](https://github.com/caolan/async) | 3.2.6 | MIT | SDK/XML transitive dependency |
| block-stream2 | [upstream](https://github.com/substack/block-stream2) | 2.1.0 | MIT | SDK/XML transitive dependency |
| browser-or-node | [upstream](https://github.com/flexdinesh/browser-or-node) | 2.1.1 | MIT | SDK/XML transitive dependency |
| buffer-crc32 | [upstream](https://github.com/brianloveswords/buffer-crc32) | 1.0.0 | MIT | SDK/XML transitive dependency |
| decode-uri-component | [upstream](https://github.com/SamVerschueren/decode-uri-component) | 0.2.2 | MIT | SDK/XML transitive dependency |
| eventemitter3 | [upstream](https://github.com/primus/eventemitter3) | 5.0.4 | MIT | SDK/XML transitive dependency |
| fast-xml-builder | [upstream](https://github.com/NaturalIntelligence/fast-xml-builder) | 1.3.1 | MIT | SDK/XML transitive dependency |
| filter-obj | [upstream](https://github.com/sindresorhus/filter-obj) | 1.1.0 | MIT | SDK/XML transitive dependency |
| is-unsafe | [upstream](https://github.com/NaturalIntelligence/is-unsafe) | 2.0.2 | MIT | SDK/XML transitive dependency |
| ipaddr.js | [upstream](https://github.com/whitequark/ipaddr.js) | 2.5.0 | MIT | SDK/XML transitive dependency |
| path-expression-matcher | [upstream](https://github.com/NaturalIntelligence/path-expression-matcher) | 1.6.2 | MIT | SDK/XML transitive dependency |
| query-string | [upstream](https://github.com/sindresorhus/query-string) | 7.1.3 | MIT | SDK/XML transitive dependency |
| sax | [upstream](https://github.com/isaacs/sax-js) | 1.6.1 | BlueOak-1.0.0 | SDK/XML transitive dependency |
| split-on-first | [upstream](https://github.com/sindresorhus/split-on-first) | 1.1.0 | MIT | SDK/XML transitive dependency |
| stream-chain | [upstream](https://github.com/uhop/stream-chain) | 2.2.5 | BSD-3-Clause | SDK/XML transitive dependency |
| stream-json | [upstream](https://github.com/uhop/stream-json) | 1.9.1 | BSD-3-Clause | SDK/XML transitive dependency |
| strict-uri-encode | [upstream](https://github.com/kevva/strict-uri-encode) | 2.0.0 | MIT | SDK/XML transitive dependency |
| strnum | [upstream](https://github.com/NaturalIntelligence/strnum) | 2.4.2 | MIT | SDK/XML transitive dependency |
| through2 | [upstream](https://github.com/rvagg/through2) | 4.0.2 | MIT | SDK/XML transitive dependency |
| xml-naming | [upstream](https://github.com/NaturalIntelligence/xml-naming) | 0.3.0 | MIT | SDK/XML transitive dependency |
| xml2js | [upstream](https://github.com/Leonidas-from-XIV/node-xml2js) | 0.6.2 | MIT | SDK/XML transitive dependency |
| xmlbuilder | [upstream](https://github.com/oozcitak/xmlbuilder-js) | 11.0.1 | MIT | SDK/XML transitive dependency |
