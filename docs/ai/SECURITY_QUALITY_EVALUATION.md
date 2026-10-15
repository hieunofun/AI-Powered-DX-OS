# AI quality and adversarial evaluation candidate (#63)

The evaluation composes pending B-owned #54 and #25 candidates on `feat/63-security-ai-evaluation`. It adds failure-inclusive scorers, a fixed six-case synthetic adversarial answer corpus, 16 transport/domain attack variants and real SQL/private object/AV/HTTP security probes. Dependencies #44, #46, #25, #54 and #60 still require integration/review. This document and passing fixtures do not close the issue.

## Measured quality

`infra/evaluation/summarize-quality.cjs` recomputes results from gold labels and observed fields/selections. It keeps each fixed historical run separate. Missing/failed samples count against every planned field/case; repeated IDs and duplicate fields/candidates cannot inflate sample size. Mapping match precision has its own predicted-match denominator; an empty denominator is `null`. Exact decimal strings remain exact. There is no combined percentage across tasks or claim of calibrated confidence.

| Fixed run | Distinct held-out cases | Result | Interpretation |
| --- | ---: | --- | --- |
| Original digital OCR | 4 | 36/36 fields; per-field 4/4 | Historical digital-only adapter; later source changed |
| Reviewed image/scanned OCR | 2 | 42/42 fields; 17 fields on both, eight second-line fields on one | Historical real PG/MinIO/AV/Gemini run; source differences explicitly retained |
| Reviewed mapping | 6 | 6/6 exact case results; 3/3 predicted-match precision | Previously observed regression corpus; supplied authorized catalog |
| New adversarial extractive answers | 6 | 6/6 relevant aliases, 6/6 server missing-evidence sets, 5/5 exact source-bound citations; zero unsupported statements | First actual Gemini run after freezing the corpus; synthetic authorized-fact bindings |

The new corpus was committed at `5ac51c5` before the first call. Gold labels were first parsed after all six actual model outputs were fixed. Synthetic facts include role/approval forgery, transfer instructions, local/metadata URLs, unsupported payment questions and values above JavaScript's safe integer range. The provider receives aliases/text, not resource IDs. Each exact fact/evidence/hash/version binding is frozen server side before generation and retained separately for citation scoring. Model selection never invokes an action. The actual run used 12 HTTP attempts and 7,446 reserved tokens; actual billing remains unknown. Repeating these cases later provides regression evidence, not additional independent held-out samples.

Reports are timestamped append-only files under `docs/ai/evidence/issue63-*.json`. Current source verification distinguishes exact Git bytes, a verified CRLF checkout of those bytes, and actual changed source. The retained reviewed-OCR run differs in four intake/repository files after subsequent integration; that historical result is not an exact-head runtime claim. Mapping and new answer selection sources match their recorded Git/CRLF checkouts. Linux CI and current-source acceptance remain separate evidence. All corpora are small, team-authored and fictional, with no independent annotation or production generalization claim.

The initial summary `issue63-quality-summary-20261015184409623.json` classified CRLF checkout bytes as different Git sources. It is retained; the subsequent summary explicitly separates that newline-only byte representation from actual code changes. Scores and planned denominators did not change.

## Security execution

```sh
npm ci
npm run build:api
node --test infra/evaluation/metrics.test.cjs
npm run test --workspace=apps/api -- --runInBand --runTestsByPath src/ai/extraction/adversarial-boundaries.spec.ts
node infra/evaluation/summarize-quality.cjs
docker compose -f infra/mediation/compose.yaml up -d --build
node infra/evaluation/validate-security-runtime.cjs --wait-ready
docker compose -f infra/mediation/compose.yaml stop
```

The ten scorer checks passed, including failed/omitted cases, repeated samples, rounded decimals, foreign/stale citations and empty precision. All 16 new attack variants passed against actual provider/domain code with explicitly labelled transport/owner doubles. The runtime job is pending: it exercises the real XML parser, native ClamAV scan/quarantine, private MinIO/hash/download, tenant predicates, current SQL resource grants and tool/worker guards. Its upstream #54 fixture uses **static server authentication aliases and SQL-backed synthetic membership/policy/decision ports**, and a selection double; this is not production #43 JWT/SSO, a human approval or an actual model security test. The hosted model evaluation above is separate. Harmless AV test bytes are created in memory and never stored in repository/report bodies. CI stops services without removing history or volumes and retains both failed and successful reports.

The first real security run at `5fe78d2` passed malformed/DTD/deep XML and mismatched PDF rejection, then failed the expected infected verdict for a custom XML wrapper around the harmless EICAR text. Its actual CLEAN verdict is preserved in `issue63-security-runtime-20261015185413459.json`. That wrapper does not meet the [official EICAR test-file format](https://www.eicar.org/download-anti-malware-testfile/): the canonical control starts with the exact 68-byte sequence, with only narrowly allowed trailing whitespace. The runner now requires a positive direct canonical control and a PDF containing that canonical file as an attachment (the existing #41 integration pattern). It also records the noncanonical XML scan as a limitation; no scanner change or universal encoded-content detection claim is made. All remaining runtime groups still require the rerun.

## Findings and owner gates

| Finding / remaining check | Owner / evidence |
| --- | --- |
| Foreign tenant/PO candidates and invented catalog IDs | B #25: reject before model or fall back to review with no unauthorized candidate; tested attack variants |
| Unknown/R3/URL/prototype tools and forged approval output | B #54: closed schema/action registry; no action execution from source/model text |
| Current requester/file/worker revocation and upload quarantine | B #41/#46/#54: actual runtime probes pending; production tenant authority remains A #43 |
| Native Onboarding approval, current owner decision and recovery | B #60/PR78: separate native Flowable evidence required; #50/#59 owner integrations remain gates |
| Browser document/correction/reload, literal rendering and cross-tenant links | C #44: implementation absent in the inspected branches; no passing browser claim |
| Production tenancy, owner decisions, SDK registration/dispatcher | A #43/#50/#59: fixture adapters do not replace these APIs or their independent review |
| Reviewed OCR current-source differences | B #26/#63: retained hashes identify the four changed files; current-source runtime must be rerun before release acceptance |

These findings are routed through this committed issue/PR evidence; no teammate message or human approval is fabricated. Root regression, exact-head CI and independent peer review are required before any completion/merge claim.

## Attribution

No dependency is added and no upstream source is copied or patched. New scorers, synthetic corpus, attack orchestration and reports are team-authored MIT. Existing Gemini REST/provider terms, Node/Nest/Ajv, PostgreSQL, pinned source-built MinIO and ClamAV 1.4.6 retain the versions/licenses/notices in `OPEN_SOURCE_COMPONENTS.md` and `docs/open-source/`. Model/AV/database engines remain upstream contributions; ledger eligibility remains separately gated by #22. Live evaluation requires an explicit ignored backend env file; no API key enters source, browser, CI secret or report.
