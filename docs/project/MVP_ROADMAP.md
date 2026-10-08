# MVP delivery backlog

The initial Issues #1-#10 are merged backend/foundation work. The next delivery scope closes the gap between that baseline and a demonstrable procurement product. Each specification below links to its published GitHub issue and testable completion criteria.

Documentation refresh: [Issue #21](https://github.com/hieunofun/SmartProcure-Pay/issues/21), branch `docs/21-mvp-documentation-backlog`, owner `huybitvvt`.

## Integration evidence

Documentation is integrated through [PR #31](https://github.com/hieunofun/AI-Powered-DX-OS/pull/31); procurement workspaces through [PR #32](https://github.com/hieunofun/AI-Powered-DX-OS/pull/32); invoice/task/audit workspaces through [PR #33](https://github.com/hieunofun/AI-Powered-DX-OS/pull/33). [Issue #34 / PR #35](https://github.com/hieunofun/AI-Powered-DX-OS/pull/35) adds quantity-reservation protection in this integration. The ledger decision (#22), demo scenarios (#29), release (#30) and third-member assignment remain open. Maintainer reviews performed through Codex are recorded as automated verification, not independent human peer review.

## Working team allocation

| Member | Account | Working responsibility |
| --- | --- | --- |
| Member 1 | [huybitvvt](https://github.com/huybitvvt) | Documentation, frontend and release preparation |
| Member 2 | [hieunofun](https://github.com/hieunofun) | Backend, AI/matching and ledger integration |
| Member 3 | Pending | OCR, data integration and demo/QA tasks are currently unassigned |

This allocation follows current backend ownership and the next frontend needs. Adjust ownership transparently in issues. The third account is pending; no contribution or review is attributed to an unidentified member.

## Issues and specifications

| Priority | Work item and acceptance criteria | Owner | GitHub issue |
| --- | --- | --- | --- |
| P0 | [Resolve open-source eligibility of the immutable ledger](backlog/ledger_license.md) | [hieunofun](https://github.com/hieunofun) | [#22](https://github.com/hieunofun/SmartProcure-Pay/issues/22) |
| P0 | [Build purchase order and goods receipt workspaces](backlog/ui_procurement.md) | [huybitvvt](https://github.com/huybitvvt) | [#23](https://github.com/hieunofun/SmartProcure-Pay/issues/23) |
| P0 | [Build invoice reconciliation approval and audit workspaces](backlog/ui_reconciliation.md) | [huybitvvt](https://github.com/huybitvvt) | [#24](https://github.com/hieunofun/SmartProcure-Pay/issues/24) |
| P1 | [Add reviewed semantic product matching suggestions](backlog/semantic_matching.md) | [hieunofun](https://github.com/hieunofun) | [#25](https://github.com/hieunofun/SmartProcure-Pay/issues/25) |
| P1 | [Extract PDF invoice drafts with field review](backlog/invoice_ocr.md) | Unassigned - third member pending | [#26](https://github.com/hieunofun/SmartProcure-Pay/issues/26) |
| P1 | [Verify invoice XML signatures and certificate trust](backlog/xml_signatures.md) | [hieunofun](https://github.com/hieunofun) | [#27](https://github.com/hieunofun/SmartProcure-Pay/issues/27) |
| P1 | [Track supplier tax-risk checks with source provenance](backlog/tax_risk.md) | Unassigned - third member pending | [#28](https://github.com/hieunofun/SmartProcure-Pay/issues/28) |
| P0 | [Provide reproducible procurement reconciliation scenarios](backlog/demo_scenarios.md) | Unassigned - third member pending | [#29](https://github.com/hieunofun/SmartProcure-Pay/issues/29) |
| P0 | [Publish a reviewed reproducible MVP demo version](backlog/release_governance.md) | [huybitvvt](https://github.com/huybitvvt) | [#30](https://github.com/hieunofun/SmartProcure-Pay/issues/30) |

P0 items establish a reproducible, reviewable MVP; P1 items add the capabilities proposed in the product pitch. An initial backlog being closed does not satisfy these follow-up acceptance criteria.


## Delivery order

1. Synchronize implemented-versus-planned documentation and attribution. Resolve the ledger's source-available licensing gate before a competition release.
2. Complete procurement/receiving and invoice/task/audit workspaces against the existing APIs. Keep platform diagnostics separate from everyday operations.
3. Produce repeatable clean-match, higher-price and short-receipt cases. Rehearse audit verification/export; any tamper probe must use disposable test data.
4. Add semantic suggestions with measured confidence and a recorded human decision. Preserve deterministic price/quantity/tax checks and historical evidence.
5. Add reviewed OCR drafts, explicit XML signature trust and tax-risk provenance as separately validated capabilities.
6. Obtain genuine peer review, finish the release checks, prepare a develop-to-main PR, and publish an actual tag/release through the repository process.

## Reviewable completion evidence

Each implementation issue must include its assigned owner, issue-numbered branch, linked PR, relevant tests, updated changelog and a peer review. Record the exact commit used for CI/demo evidence. Do not rewrite history, manufacture review/author records or claim unimplemented stubs are completed features.

A demo release requires working operational UI, reproducible data, successful real-stack acceptance and a recorded licensing decision. `READY_FOR_PAYMENT` remains clearance until a distinct payment integration exists. Hash proofs do not imply a legal CFO signature or ten-year retention compliance.
