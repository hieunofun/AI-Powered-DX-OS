# Contributing to SmartProcure-Pay

Thank you for your interest in contributing to SmartProcure-Pay! As an open-source project participating in the OLP Open Source Software competition 2026, we follow strict software engineering standards, collaborative governance, and open-source licensing principles.

---

## 1. Development & Contribution Workflow

All code contributions must follow this standard lifecycle:

```text
Issue ──► Branch ──► Code ──► Test ──► Pull Request ──► Code Review ──► Merge
```

1. **Issue**: Identify or create a GitHub Issue describing the bug, feature, or task before writing code.
2. **Branch**: Create a dedicated working branch branching from `develop`.
3. **Code**: Implement changes respecting architectural boundaries and coding standards.
4. **Test**: Write automated tests and ensure all existing checks pass.
5. **Pull Request**: Open a PR targeting `develop`. Link the PR to the issue using `Closes #<issue>` or `Fixes #<issue>`.
6. **Code Review**: At least one maintainer review and approval is required.
7. **Merge**: Merged into `develop` via squash/rebase merge. Production/demo releases are tagged on `main`.

> [!IMPORTANT]
> Never push directly to `main` or `develop`. All contributions must arrive via Pull Requests.

---

## 2. Branch Naming Conventions

Branches must follow the naming pattern with the issue number and a short descriptive kebab-case name:

- Feature branches: `feature/<issue-number>-<short-name>`
  - Example: `feature/5-purchase-order-crud`
- Bug fixes: `fix/<issue-number>-<short-name>`
  - Example: `fix/8-tolerance-rounding-error`
- Documentation: `docs/<issue-number>-<short-name>`
  - Example: `docs/1-dxos-architecture-guide`

---

## 3. Commit Message Standards (Conventional Commits)

We follow the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) specification:

```text
<type>(<scope>): <short description>
```

### Types
- `feat`: A new feature or business capability
- `fix`: A bug fix
- `docs`: Documentation changes only
- `test`: Adding or updating test suites
- `refactor`: Code changes that neither fix a bug nor add a feature
- `chore`: Maintenance tasks, dependencies, tooling, or repository setup

### Scopes
Common scopes include:
- `procurement`: Purchase Orders, vendor master data
- `warehouse`: Goods Receipts, inventory receiving
- `invoice`: Ingestion, XML/PDF parsing, object storage
- `matching`: 3-Way Matching Engine, tolerance policies
- `workflow`: BPMN approval flows, exception routing
- `audit`: Cryptographic hashing, ImmuDB audit trails
- `gateway`: APISIX routing, rate-limiting, CORS
- `identity`: Keycloak integration, RBAC, JWT
- `architecture`: DX-OS design, system structure

### Examples
- `feat(procurement): implement purchase order creation`
- `test(matching): cover partial delivery case`
- `docs(architecture): document DX-OS layers`
- `fix(matching): resolve rounding mismatch on fractional VAT`
- `chore(project): initialize SmartProcure-Pay repository foundation`

---

## 4. Pull Request Requirements

When submitting a Pull Request:
1. Provide a clear description of what changed and why.
2. Link the corresponding issue in the PR description:
   - `Closes #<issue-number>` or `Fixes #<issue-number>`
3. Ensure no secrets, tokens, credentials, or `.env` files are included.
4. Verify that any new third-party dependency is evaluated for license compatibility and documented in [OPEN_SOURCE_COMPONENTS.md](OPEN_SOURCE_COMPONENTS.md).
5. Ensure automated linter, formatting, and unit tests pass locally before opening PR.

---

## 5. Licensing and Attribution

By contributing to SmartProcure-Pay, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).
For third-party libraries and reused code, please review our [License Policy](docs/open-source/LICENSE_POLICY.md).
