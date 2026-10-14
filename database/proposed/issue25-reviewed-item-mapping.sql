-- SPDX-License-Identifier: MIT
-- Proposed isolated acceptance schema; A assigns production migration/tenant integration.
CREATE TABLE IF NOT EXISTS openresolve_mapping_records (
  tenant_id UUID NOT NULL,id UUID NOT NULL,evidence_id UUID NOT NULL,created_at TIMESTAMPTZ NOT NULL,data JSONB NOT NULL,
  PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,evidence_id) REFERENCES platform_evidence_records(tenant_id,id),
  CHECK(data->>'id'=id::text AND data->>'tenantId'=tenant_id::text AND data->>'evidenceId'=evidence_id::text)
);
CREATE UNIQUE INDEX IF NOT EXISTS openresolve_mapping_operations ON openresolve_mapping_records(tenant_id,((data->'operation'->>'id')));
CREATE TABLE IF NOT EXISTS openresolve_mapping_commands (
  tenant_id UUID NOT NULL,scope_hash CHAR(64) NOT NULL,request_hash CHAR(64) NOT NULL,record_id UUID NOT NULL,response JSONB NOT NULL,
  PRIMARY KEY(tenant_id,scope_hash),FOREIGN KEY(tenant_id,record_id) REFERENCES openresolve_mapping_records(tenant_id,id),
  CHECK(scope_hash ~ '^[a-f0-9]{64}$' AND request_hash ~ '^[a-f0-9]{64}$')
);
CREATE TABLE IF NOT EXISTS openresolve_mapping_decisions (
  tenant_id UUID NOT NULL,id UUID NOT NULL,mapping_id UUID NOT NULL,data JSONB NOT NULL,
  PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,mapping_id),FOREIGN KEY(tenant_id,mapping_id) REFERENCES openresolve_mapping_records(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS openresolve_mapping_outbox (
  tenant_id UUID NOT NULL,decision_id UUID NOT NULL,payload_hash CHAR(64) NOT NULL,payload JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','RUNNING','SUCCEEDED','FAILED','RECONCILIATION_REQUIRED')),
  PRIMARY KEY(tenant_id,decision_id),FOREIGN KEY(tenant_id,decision_id) REFERENCES openresolve_mapping_decisions(tenant_id,id)
);
CREATE OR REPLACE FUNCTION openresolve_mapping_preserve_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Reviewed mapping decisions are append-only'; END; $$;
DROP TRIGGER IF EXISTS openresolve_mapping_decision_immutable ON openresolve_mapping_decisions;
CREATE TRIGGER openresolve_mapping_decision_immutable BEFORE UPDATE OR DELETE ON openresolve_mapping_decisions FOR EACH ROW EXECUTE FUNCTION openresolve_mapping_preserve_decision();
