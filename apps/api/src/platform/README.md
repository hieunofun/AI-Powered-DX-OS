# Headless platform ports (#40)

`PlatformModule` composes working JWT identity/guards, PostgreSQL access and generic Flowable transport. Import public classes and interfaces from `platform/index.ts`. It can boot a Nest application context without business modules, controllers, BPMN files or the web app:

```ts
import { NestFactory } from '@nestjs/core';
import { PlatformModule, FlowableTransport } from './platform';

const context = await NestFactory.createApplicationContext(PlatformModule);
const engine = context.get(FlowableTransport);
// Supply a verified definition ID, authorized generic subject/business key,
// exact string/boolean variables and a previously persisted durable intent.
// Reconcile uncertain dispatch; this transport does not provide HTTP idempotency.
await context.close();
```

Identity retains signature/issuer/audience checks and generic role guards. Data access retains existing transaction/pool behavior and exact PostgreSQL values. Flowable transport provides actual history/task/start/claim/complete requests with bounded timeout and `EngineError.retrySafe`; an uncertain write is not confirmed success. The transport does not grant business permissions or decide policy. Legacy import paths re-export identical class/decorator tokens, preserving existing controllers and dependency overrides.

The legacy Flowable adapter retains business definition selection, process-key guard and resource hash verification outside platform. All business orchestration, roles, matching/reservations and frozen history remain in their existing modules. No route/table rename or data migration occurs in this extraction. Environment variable names/defaults remain compatible; configure credentials and deployment values explicitly as before.

`npm run test:boundaries` enforces project import and vocabulary separation. `npm run test:platform --workspace=apps/api` tests actual headless DI composition and generic transport behavior with explicitly simulated HTTP responses. Existing full CI checks actual services and business regressions. Later tenant/resource authorization (#43), versioned workflow/task APIs (#45), evidence/policy/decision/pack semantics remain separate work; this extraction does not claim their acceptance.

See [ADR-004](../../../../docs/project4/adr/004-headless-core-extraction.md). No new runtime dependency is added; Nest/pg/JWT/JWKS/Flowable remain upstream infrastructure, and TypeScript supplies the boundary checker's parser/resolver. The team owns adapter composition, boundary policy and tests.
