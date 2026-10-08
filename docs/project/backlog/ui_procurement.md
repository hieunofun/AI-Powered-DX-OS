# [UI] Build purchase order and goods receipt workspaces

## Goal
Replace the auth-only operational experience with role-aware PO and GRN lists, detail views and action forms using the existing backend. Keep platform diagnostics available separately.

## Delivery
Priority: P0
Responsible role: Frontend
Owner: huybitvvt

## Acceptance criteria
- [ ] Buyer/admin can create and edit a draft PO, issue it and cancel eligible documents through the existing APIs.
- [ ] Warehouse/admin can create and finalize GRNs, display accepted/rejected quantities and see cumulative PO fulfillment.
- [ ] Render decimal amounts as strings without float recalculation; display backend validation and version conflicts.
- [ ] Provide loading/empty/error states, keyboard-accessible labeled forms and read-only states for unauthorized roles.
- [ ] Demonstrate real API persistence after reload; verify an issue/partial-receipt lifecycle and 401/403/409 handling.

## Dependencies
Merged Issues #3-#6; documentation baseline #21.

## Out of scope
Supplier ERP connectors, new PO approval states, fabricated transactions or authorization enforced only in the browser.

## Development workflow
Create an issue-numbered branch from develop. Link the PR, include relevant real validation, request peer review and update CHANGELOG. Do not claim completion from a stub or mocked integration.
