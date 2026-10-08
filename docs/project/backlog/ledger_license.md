# [LICENSE] Resolve open-source eligibility of the immutable ledger

## Goal
Compare the exact integrated ImmuDB server/client licenses with candidate OSI-licensed releases or replacements. Record an architecture decision with upstream provenance, proof compatibility, data migration and recovery requirements. Keep the existing ledger until a reviewed decision is implemented.

## Delivery
Priority: P0
Responsible role: Backend / infrastructure
Owner: hieunofun

## Acceptance criteria
- [ ] Record the exact server/client versions, upstream LICENSE links and production/distribution terms for each candidate.
- [ ] Select a competition-compatible option or record explicit organizer acceptance; an internal policy exception alone is insufficient evidence.
- [ ] Verify actual inclusion/consistency proofs, persisted trust state, tamper detection and outage recovery against any replacement.
- [ ] If changing the ledger, document migration/rollback without discarding historical receipts; preserve notices and update the component inventory.

## Dependencies
Issues #10 and #21.

## Out of scope
Silently changing versions, deleting existing seals, claiming BUSL is OSI-approved or claiming organizer approval without evidence.

## Development workflow
Create an issue-numbered branch from develop. Link the PR, include relevant real validation, request peer review and update CHANGELOG. Do not claim completion from a stub or mocked integration.
