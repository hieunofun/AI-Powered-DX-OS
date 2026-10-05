#!/usr/bin/env bash
# Real disposable Docker CI stack; no auth/matching repository mocks.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
node infra/matching/validate-three-way-matching.cjs
