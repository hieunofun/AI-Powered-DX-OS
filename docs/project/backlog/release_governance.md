# [RELEASE] Publish a reviewed reproducible MVP demo version

## Goal
Prepare a versioned MVP snapshot and reviewer-facing release evidence after the demo and licensing gates are satisfied. Keep the issue/branch/PR chain intact.

## Delivery
Priority: P0
Responsible role: Project / release
Owner: huybitvvt

## Acceptance criteria
- [ ] Confirm team names/roles; leave the third member pending until identified and assign implementation issues transparently.
- [ ] Have another team member review the implementation PRs; preserve genuine reviews and contribution history.
- [ ] Complete the licensing decision, operating instructions, contribution attribution and changelog for the selected version.
- [ ] Run required checks on the release candidate and link reproducible demo evidence to the exact commit.
- [ ] Prepare develop-to-main PR, version tag and release notes through the repository review process; do not bypass approval or rewrite history.
- [ ] Verify a fresh clone of the selected version can build and run the documented demo.

## Dependencies
Issue #21, ledger licensing, demo scenarios and completed UI workspaces.

## Out of scope
Creating retrospective fake contributions, force-pushing main/develop, changing repository permissions or releasing an unreviewed candidate.

## Development workflow
Create an issue-numbered branch from develop. Link the PR, include relevant real validation, request peer review and update CHANGELOG. Do not claim completion from a stub or mocked integration.
