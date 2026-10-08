# [AI] Add reviewed semantic product matching suggestions

## Goal
Add a separately versioned semantic suggestion layer for unresolved item descriptions. Preserve the deterministic matcher and immutable historical evidence. Resolve uncertain candidates through a recorded human decision before payment clearance.

## Delivery
Priority: P1
Responsible role: Backend / AI
Owner: hieunofun

## Acceptance criteria
- [ ] Document and pin an appropriately licensed local model/runtime and reproduce its setup.
- [ ] Include held-out examples such as HP 85A / CE285A, unrelated items, duplicate candidates and ambiguous descriptions.
- [ ] Return candidate PO item IDs, confidence, model/version and reasons; benchmark correctness and latency on a documented dataset.
- [ ] Require confirmation below the reviewed threshold and for ambiguous candidates; record actor and selected mapping.
- [ ] Do not rewrite completed matching evidence or use an AI score alone to authorize payment.
- [ ] Keep the rule-based path available when the model is unavailable; test timeout and misleading-nearest-candidate cases.

## Dependencies
Merged Issues #7-#9; documented item-resolution contract and licensing review.

## Out of scope
Autonomous payment, unmeasured accuracy claims, rewriting historical match results or using external proprietary APIs as an undisclosed dependency.

## Development workflow
Create an issue-numbered branch from develop. Link the PR, include relevant real validation, request peer review and update CHANGELOG. Do not claim completion from a stub or mocked integration.
