-- SPDX-License-Identifier: MIT
-- Isolated acceptance schema; A assigns numbered migrations at integration.
CREATE TABLE IF NOT EXISTS platform_extraction_records (
  tenant_id UUID NOT NULL, id UUID NOT NULL, evidence_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, data JSONB NOT NULL,
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,evidence_id) REFERENCES platform_evidence_records(tenant_id,id),
  CHECK (data->>'id'=id::text AND data->>'tenantId'=tenant_id::text AND data->>'evidenceId'=evidence_id::text)
);
CREATE INDEX IF NOT EXISTS platform_extraction_source_idx ON platform_extraction_records(tenant_id,evidence_id);
CREATE UNIQUE INDEX IF NOT EXISTS platform_extraction_operation_idx ON platform_extraction_records(tenant_id,((data->'operation'->>'id')));
CREATE TABLE IF NOT EXISTS platform_extraction_commands (
  tenant_id UUID NOT NULL, scope_hash CHAR(64) NOT NULL, request_hash CHAR(64) NOT NULL, record_id UUID NOT NULL, response JSONB NOT NULL,
  PRIMARY KEY (tenant_id,scope_hash),
  FOREIGN KEY (tenant_id,record_id) REFERENCES platform_extraction_records(tenant_id,id),
  CHECK (scope_hash ~ '^[a-f0-9]{64}$' AND request_hash ~ '^[a-f0-9]{64}$')
);
CREATE TABLE IF NOT EXISTS platform_verified_draft_outbox (
  tenant_id UUID NOT NULL, confirmation_id UUID NOT NULL, draft_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, payload_hash CHAR(64) NOT NULL, payload JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','RUNNING','SUCCEEDED','RECONCILIATION_REQUIRED','FAILED')),
  PRIMARY KEY (tenant_id,confirmation_id),
  FOREIGN KEY (tenant_id,draft_id) REFERENCES platform_extraction_records(tenant_id,id)
);
