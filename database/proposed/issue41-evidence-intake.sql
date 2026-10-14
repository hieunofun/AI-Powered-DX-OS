-- SPDX-License-Identifier: MIT
-- Review candidate, applied only to an isolated acceptance database.
-- A assigns a numbered migration from current develop during integration.
CREATE TABLE IF NOT EXISTS platform_evidence_records (
  tenant_id UUID NOT NULL,
  id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL,
  PRIMARY KEY (tenant_id,id),
  CHECK (data->'evidence'->>'id'=id::text),
  CHECK (data->'evidence'->>'tenant_id'=tenant_id::text),
  CHECK (data->'evidence'->>'quarantine_state' IN ('PENDING_UPLOAD','PENDING_SCAN','CLEAN','INFECTED','SCAN_FAILED')),
  CONSTRAINT platform_evidence_processing_guard CHECK (
    data->'evidence'->>'processing_state' IN ('NOT_STARTED','QUEUED','PROCESSING','REVIEW_REQUIRED','CONFIRMED','FAILED') AND
    (data->'evidence'->>'quarantine_state'='CLEAN' OR data->'evidence'->>'processing_state'='NOT_STARTED'))
);
CREATE INDEX IF NOT EXISTS platform_evidence_page_idx ON platform_evidence_records(tenant_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS platform_evidence_operation_idx ON platform_evidence_records(tenant_id,((data->'operation'->>'id')));
CREATE TABLE IF NOT EXISTS platform_evidence_commands (
  tenant_id UUID NOT NULL,
  scope_hash CHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  evidence_id UUID NOT NULL,
  PRIMARY KEY (tenant_id,scope_hash),
  FOREIGN KEY (tenant_id,evidence_id) REFERENCES platform_evidence_records(tenant_id,id),
  CHECK (scope_hash ~ '^[a-f0-9]{64}$'),
  CHECK (request_hash ~ '^[a-f0-9]{64}$')
);
