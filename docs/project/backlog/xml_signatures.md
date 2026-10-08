# [SECURITY] Verify invoice XML signatures and certificate trust

## Goal
Add explicit XML signature verification and certificate trust outcomes for supported invoice profiles. Keep syntactic parsing and legal/trust verification separate.

## Delivery
Priority: P1
Responsible role: Backend / security
Owner: hieunofun

## Acceptance criteria
- [ ] Record trusted certificate sources, validity/revocation strategy, supported algorithms and implementation-library licenses.
- [ ] Verify the exact signed business payload and reject wrapping/substitution, altered payload and mismatched references.
- [ ] Expose VALID, INVALID and UNVERIFIED/UNAVAILABLE states with reasons and the verification time.
- [ ] Test valid, expired, tampered and untrusted-certificate fixtures without committing private keys or actual customer data.
- [ ] Document what is and is not established by verification; do not claim tax-authority certification or a CFO signature.
- [ ] Define the workflow blocking policy for unverified or invalid signatures and test it.

## Dependencies
Merged Issue #7; reviewed trust policy and source availability.

## Out of scope
CFO PKI signing, manufacturing certificate trust or treating an archived Signature element as successful verification.

## Development workflow
Create an issue-numbered branch from develop. Link the PR, include relevant real validation, request peer review and update CHANGELOG. Do not claim completion from a stub or mocked integration.
