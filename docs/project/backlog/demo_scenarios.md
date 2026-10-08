# [DEMO] Provide reproducible procurement reconciliation scenarios

## Goal
Create an isolated, repeatable demo dataset and rehearsal script for the complete user workflow. Extend beyond the historical reference seed while preserving real backend decisions.

## Delivery
Priority: P0
Responsible role: QA / demo (third member pending)
Owner: Unassigned - third member pending

## Acceptance criteria
- [ ] Provide clean-match, increased-price and insufficient-accepted-quantity cases with expected discrepancies and workflow roles.
- [ ] Cover terminal audit verification/export and a tamper-detection demonstration confined to an explicitly disposable environment.
- [ ] Document prerequisites, role accounts, fixture provenance, seed/reset behavior and commands usable from a fresh clone.
- [ ] Require an explicit destructive-demo flag for any tamper/reset operation and constrain it to demo-owned data.
- [ ] Run the UI/API scenarios against the real stack and provide evidence linked to the tested commit/CI run.
- [ ] Produce a 10-15 minute rehearsal outline separating implemented behavior from roadmap items.

## Dependencies
UI workspaces; merged backend Issues #5-#10; release gate requires the ledger-license decision.

## Out of scope
Production-data mutation, fake verification receipts or claiming the current reference seed alone demonstrates all scenarios.

## Development workflow
Create an issue-numbered branch from develop. Link the PR, include relevant real validation, request peer review and update CHANGELOG. Do not claim completion from a stub or mocked integration.
