# [UI] Build invoice reconciliation approval and audit workspaces

## Goal
Connect invoice upload, matching evidence, role-specific task decisions and audit verification/export to existing API endpoints.

## Delivery
Priority: P0
Responsible role: Frontend
Owner: huybitvvt

## Acceptance criteria
- [ ] Accountant/admin can upload supported XML/PDF and see PARSED, OCR_REQUIRED and failure states accurately.
- [ ] Show PO/accepted GRN/invoice line comparisons, all discrepancy codes, applied policy and match status.
- [ ] Start workflow explicitly and show clean STP versus exception cases; eligible users can claim/complete tasks with required reasons.
- [ ] Display READY_FOR_PAYMENT as clearance, not proof of payment; do not imply a digital signature exists.
- [ ] Authorized audit users can verify and download JSON/PDF; surface TAMPERED, LEDGER_MISMATCH and UNAVAILABLE distinctly.
- [ ] Run at least one clean and one exception scenario against the real stack and check RBAC/error states.

## Dependencies
Merged Issues #7-#10; procurement workspace for navigating linked documents.

## Out of scope
Bank transfers, sending vendor messages, semantic matching/OCR implementation or hiding failed audit checks.

## Development workflow
Create an issue-numbered branch from develop. Link the PR, include relevant real validation, request peer review and update CHANGELOG. Do not claim completion from a stub or mocked integration.
