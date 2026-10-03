#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_USER="${POSTGRES_USER:-smartprocure_user}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgres_password}"
POSTGRES_DB="${POSTGRES_DB:-smartprocure_db}"

export PGPASSWORD="${POSTGRES_PASSWORD}"

echo "=================================================="
echo "SmartProcure-Pay PostgreSQL Schema Validation"
echo "Target: ${POSTGRES_USER}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"
echo "=================================================="

# Function to run psql command
run_sql_file() {
    local file_path="$1"
    if command -v psql > /dev/null 2>&1; then
        psql -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -v ON_ERROR_STOP=1 -f "${file_path}"
    elif command -v docker > /dev/null 2>&1; then
        docker compose exec -T smartprocure-postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -v ON_ERROR_STOP=1 < "${file_path}"
    else
        echo "Error: Neither psql nor docker is available to execute tests."
        exit 1
    fi
}

echo "Applying seed reference scenario..."
run_sql_file "${ROOT_DIR}/database/seed/001_seed_scenario.sql"

echo "Executing schema integrity assertion suite..."
run_sql_file "${SCRIPT_DIR}/validate-schema.sql"

echo "=================================================="
echo "Schema validation completed successfully!"
echo "=================================================="
