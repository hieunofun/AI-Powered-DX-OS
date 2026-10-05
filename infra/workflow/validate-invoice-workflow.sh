#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
ready=0
for attempt in {1..60}; do
  if [ "$(docker inspect --format='{{.State.Health.Status}}' smartprocure-flowable 2>/dev/null)" = "healthy" ]; then
    ready=1
    break
  fi
  sleep 3
done
if [ "$ready" -ne 1 ]; then
  echo "Flowable container did not become healthy within 180 seconds."
  docker compose ps
  docker compose logs --tail=100 smartprocure-flowable
  exit 1
fi
node infra/workflow/bootstrap-flowable.cjs
node infra/workflow/validate-invoice-workflow.cjs

