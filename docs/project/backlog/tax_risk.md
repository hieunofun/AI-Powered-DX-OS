# [TAX] Track supplier tax-risk checks with source provenance

## Goal
Evaluate permitted sources for supplier tax status/risk and implement an adapter with explicit provenance, freshness and failure behavior. Keep demo data visibly labeled.

## Delivery
Priority: P1
Responsible role: Data integration (third member pending)
Owner: Unassigned - third member pending

## Acceptance criteria
- [ ] Document the permitted source, access conditions, credentials handling and available fields before implementation.
- [ ] Persist source identifier, retrieval time, status/reason and relevant evidence for each lookup.
- [ ] Distinguish verified source results, stale data, unavailable data and simulated demo fixtures.
- [ ] Define a reviewed workflow policy for risk/unknown states; never report an unavailable lookup as a clean supplier.
- [ ] Test unavailable source, stale response, supplier tax-ID mismatch and manual review.
- [ ] Document the limits of the source instead of claiming guaranteed tax deductibility or comprehensive blacklist coverage.

## Dependencies
Merged Issues #7-#9; approved and technically accessible data source.

## Out of scope
Undisclosed scraping, live legal accusations from mock data or representing supplier master status as a government risk check.

## Development workflow
Create an issue-numbered branch from develop. Link the PR, include relevant real validation, request peer review and update CHANGELOG. Do not claim completion from a stub or mocked integration.
