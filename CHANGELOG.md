# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Issue #23: Vietnamese purchase-order and goods-receipt workspaces using authenticated APIs, with paginated search, role-aware draft forms, confirmations and receipt fulfillment details.
- Read-only bounded supplier lookup and cumulative finalized receipt quantities for procurement UI.
- Real browser acceptance tests through Keycloak, APISIX and PostgreSQL; fixed-scale decimal tests and CI execution.
- Initial project structure
- Open-source governance documentation
- Development workflow

### Fixed
- Reuse Keycloak initialization during React StrictMode effect remounts.
- Pin missing Babel/Browserslist compatibility data so Vite development can run after a clean install; license review recorded in the component inventory.
- Allow explicitly clearing an optional PO expected delivery date with `null`.
