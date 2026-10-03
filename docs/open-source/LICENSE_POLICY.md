# Open Source Licensing & Compliance Policy

As an open-source project participating in the Vietnam National Olympiad in Informatics (OLP) Open Source Software Category 2026, **SmartProcure-Pay** adheres to strict open-source governance principles. This policy defines the mandatory standards for incorporating, modifying, and distributing open-source software.

---

## 1. Core Licensing Principles

1. **OSI-Approved Licenses**: All third-party dependencies, libraries, frameworks, and infrastructure tools MUST use licenses recognized by the [Open Source Initiative (OSI)](https://opensource.org/licenses).
2. **Preference for Permissive Licenses**: We strongly prioritize permissive licenses—primarily **MIT**, **Apache-2.0**, and **BSD-2-Clause / BSD-3-Clause**—to maximize reusability, modularity, and integration flexibility.
3. **No Unidentified Licenses**: No package, library, snippet, or Docker image with an unidentified, missing, or custom non-standard license may be introduced into the codebase.

---

## 2. Dependency Management & Inventory

- Every significant external software component, runtime service, or major dependency MUST be recorded in [OPEN_SOURCE_COMPONENTS.md](../../OPEN_SOURCE_COMPONENTS.md).
- Before introducing any new dependency:
  - Verify upstream repository and its primary `LICENSE` file.
  - Check transitive dependencies for restrictive or viral copyleft constraints.
  - Document the component's name, repository URL, version, verified license, role, and integration type.

---

## 3. Code Reuse, Forking, and Attribution

When reusing snippets, algorithms, or forking code from public repositories:
1. **Source Attribution**: Always cite the original author, upstream repository URL, and commit hash in the code comments or module header.
2. **License Preservation**: The original license text and copyright headers of upstream code must remain intact. NEVER delete or alter upstream copyright statements.
3. **Tracking in Documentation**: Reused and modified code must be explicitly listed in [OUR_CONTRIBUTIONS.md](../../OUR_CONTRIBUTIONS.md) under the appropriate section.

---

## 4. License Compatibility & Copyleft Considerations

- **Application Codebase**: The original code written by the SmartProcure-Pay team is licensed under the permissive **MIT License**.
- **Copyleft & AGPL Considerations**:
  - Strong copyleft code (e.g., GPL-2.0, GPL-3.0) must NOT be statically or dynamically linked into our MIT-licensed core application libraries without prior architectural review.
  - Third-party components licensed under AGPL-3.0 (such as MinIO or Grafana) are utilized strictly as unmodified external services deployed via container orchestration.
  - Distribution and deployment license obligations must be respected according to their respective upstream licenses.
- **Review Prior to Merge**: Pull Requests that introduce new external dependencies or services must undergo license compliance review before being merged into `develop`.
