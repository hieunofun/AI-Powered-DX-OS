#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node infra/workflow/bootstrap-flowable.cjs
node infra/workflow/validate-invoice-workflow.cjs

