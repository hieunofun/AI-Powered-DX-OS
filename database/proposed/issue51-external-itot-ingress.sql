-- SPDX-License-Identifier: MIT
-- Candidate isolated schema. A assigns numbered migrations and production membership/source/PO constraints.
CREATE TABLE IF NOT EXISTS openresolve_connector_sources (
  tenant_id UUID NOT NULL,id UUID NOT NULL,principal TEXT NOT NULL CHECK(length(principal) BETWEEN 1 AND 200),
  kind TEXT NOT NULL CHECK(kind IN ('EXTERNAL_ORDER','RECEIVING_SENSOR')),active BOOLEAN NOT NULL,simulated BOOLEAN NOT NULL,
  PRIMARY KEY(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS openresolve_source_observations (
  tenant_id UUID NOT NULL,id UUID NOT NULL,source_id UUID NOT NULL,source_event_id TEXT NOT NULL CHECK(length(source_event_id) BETWEEN 1 AND 100),
  content_hash CHAR(64) NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),received_at TIMESTAMPTZ NOT NULL,data JSONB NOT NULL,
  PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,source_id,source_event_id,content_hash),
  FOREIGN KEY(tenant_id,source_id) REFERENCES openresolve_connector_sources(tenant_id,id),
  CHECK(data->>'id'=id::text AND data->>'tenantId'=tenant_id::text AND data->>'sourceId'=source_id::text AND data->>'contentHash'=content_hash)
);
CREATE UNIQUE INDEX IF NOT EXISTS openresolve_connector_operations ON openresolve_source_observations(tenant_id,((data->'operation'->>'id')));
CREATE TABLE IF NOT EXISTS openresolve_source_event_anchors (
  tenant_id UUID NOT NULL,source_id UUID NOT NULL,source_event_id TEXT NOT NULL,observation_id UUID NOT NULL,
  PRIMARY KEY(tenant_id,source_id,source_event_id),FOREIGN KEY(tenant_id,observation_id) REFERENCES openresolve_source_observations(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS openresolve_source_receipts (
  tenant_id UUID NOT NULL,source_id UUID NOT NULL,source_event_id TEXT NOT NULL,raw_hash CHAR(64) NOT NULL CHECK(raw_hash ~ '^[a-f0-9]{64}$'),
  observation_id UUID NOT NULL,received_at TIMESTAMPTZ NOT NULL,raw_bytes BYTEA NOT NULL CHECK(octet_length(raw_bytes) BETWEEN 1 AND 65536),
  PRIMARY KEY(tenant_id,source_id,source_event_id,raw_hash),FOREIGN KEY(tenant_id,observation_id) REFERENCES openresolve_source_observations(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS openresolve_connector_commands (
  tenant_id UUID NOT NULL,scope_hash CHAR(64) NOT NULL,request_hash CHAR(64) NOT NULL,observation_id UUID NOT NULL,response JSONB NOT NULL,
  PRIMARY KEY(tenant_id,scope_hash),FOREIGN KEY(tenant_id,observation_id) REFERENCES openresolve_source_observations(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS openresolve_connector_case_outbox (
  tenant_id UUID NOT NULL,observation_id UUID NOT NULL,request_hash CHAR(64) NOT NULL,case_request JSONB NOT NULL,event_envelope JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','RUNNING','SUCCEEDED','FAILED','RECONCILIATION_REQUIRED')),
  PRIMARY KEY(tenant_id,observation_id),FOREIGN KEY(tenant_id,observation_id) REFERENCES openresolve_source_observations(tenant_id,id)
);
CREATE OR REPLACE FUNCTION openresolve_preserve_source_bytes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Source receipts and event anchors are append-only'; END; $$;
DROP TRIGGER IF EXISTS openresolve_source_receipt_immutable ON openresolve_source_receipts;
CREATE TRIGGER openresolve_source_receipt_immutable BEFORE UPDATE OR DELETE ON openresolve_source_receipts FOR EACH ROW EXECUTE FUNCTION openresolve_preserve_source_bytes();
DROP TRIGGER IF EXISTS openresolve_source_anchor_immutable ON openresolve_source_event_anchors;
CREATE TRIGGER openresolve_source_anchor_immutable BEFORE UPDATE OR DELETE ON openresolve_source_event_anchors FOR EACH ROW EXECUTE FUNCTION openresolve_preserve_source_bytes();
CREATE OR REPLACE FUNCTION openresolve_preserve_observation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Source observations are retained'; END IF;
  IF (NEW.data - ARRAY['operation','evidenceId','evidenceSha256','attempts','nextAttemptAt','lease','outcome','failures']) IS DISTINCT FROM
     (OLD.data - ARRAY['operation','evidenceId','evidenceSha256','attempts','nextAttemptAt','lease','outcome','failures'])
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.source_event_id IS DISTINCT FROM OLD.source_event_id OR NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR (OLD.data->>'evidenceId' IS NOT NULL AND NEW.data->>'evidenceId' IS DISTINCT FROM OLD.data->>'evidenceId')
     OR (OLD.data->>'evidenceSha256' IS NOT NULL AND NEW.data->>'evidenceSha256' IS DISTINCT FROM OLD.data->>'evidenceSha256')
     OR (OLD.data->'outcome' IS NOT NULL AND NEW.data->'outcome' IS DISTINCT FROM OLD.data->'outcome') THEN
    RAISE EXCEPTION 'Original source observation and finalized outcome are immutable';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS openresolve_observation_preserve ON openresolve_source_observations;
CREATE TRIGGER openresolve_observation_preserve BEFORE UPDATE OR DELETE ON openresolve_source_observations FOR EACH ROW EXECUTE FUNCTION openresolve_preserve_observation();
