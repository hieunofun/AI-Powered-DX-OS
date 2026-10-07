#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
for service in smartprocure-immudb smartprocure-audit-verifier; do
  ready=0
  for attempt in {1..60}; do
    if [ "$(docker inspect --format='{{.State.Health.Status}}' "$service" 2>/dev/null)" = healthy ]; then ready=1; break; fi
    sleep 2
  done
  if [ "$ready" != 1 ]; then echo "Audit service health timed out: $service"; exit 1; fi
done
docker compose exec -T smartprocure-immudb /usr/sbin/immudb version | grep -E '1\.11\.0'
docker compose exec -T smartprocure-api node infra/audit/bootstrap-immudb.cjs
if [ "${1:-}" = --bootstrap-only ]; then exit 0; fi
if ! command -v pdftotext >/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq poppler-utils
fi
node infra/audit/validate-immutable-audit.cjs
