# [OCR] Extract PDF invoice drafts with field review

## Goal
Implement the existing InvoiceOcrProvider extension point with a reproducible open-source OCR pipeline. Retain raw file hashes and expose extracted drafts for validation before structured matching.

## Delivery
Priority: P1
Responsible role: Data / OCR (third member pending)
Owner: Unassigned - third member pending

## Acceptance criteria
- [ ] Pin OCR/runtime/model versions with their licenses and document reproducible installation.
- [ ] Extract seller/buyer tax IDs, invoice identity/date, lines, quantities, prices, VAT and totals with provenance and confidence.
- [ ] Handle text PDFs and at least one Vietnamese scanned-PDF fixture; maintain a documented evaluation dataset.
- [ ] Require correction/confirmation for uncertain required fields and reject invalid decimal/tax/total combinations.
- [ ] Preserve original PDF bytes and SHA-256; do not invent XML signatures or tax-authority verification.
- [ ] Test malformed/oversized inputs, OCR timeout and repeated ingestion without losing raw files.

## Dependencies
Merged Issue #7; define draft review and confirmation API before implementation.

## Out of scope
Custom model training, automatic payment clearance from OCR output or claiming image-upload support before adding an explicit contract.

## Development workflow
Create an issue-numbered branch from develop. Link the PR, include relevant real validation, request peer review and update CHANGELOG. Do not claim completion from a stub or mocked integration.
