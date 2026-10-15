-- SPDX-License-Identifier: MIT
-- Opt-in candidate only. No numbered production migration, owner Decision/Case replacement or permissive default.
CREATE TABLE IF NOT EXISTS openresolve_ai_controls (
  tenant_id UUID PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT FALSE,
  revision BIGINT NOT NULL CHECK (revision > 0), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS openresolve_ai_explanations (
  tenant_id UUID NOT NULL, id UUID NOT NULL, data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(tenant_id,id),
  CHECK (data->>'tenantId'=tenant_id::text AND data->>'id'=id::text)
);
CREATE INDEX IF NOT EXISTS openresolve_ai_jobs_queue ON openresolve_ai_explanations(tenant_id,created_at,id)
  WHERE data->'operation'->>'state' IN ('PENDING','RUNNING');
CREATE TABLE IF NOT EXISTS openresolve_ai_proposals (
  tenant_id UUID NOT NULL, id UUID NOT NULL, explanation_id UUID NOT NULL,
  data JSONB NOT NULL, PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,explanation_id) REFERENCES openresolve_ai_explanations(tenant_id,id),
  CHECK (data->>'tenantId'=tenant_id::text AND data->>'id'=id::text AND data->>'explanationId'=explanation_id::text)
);
CREATE TABLE IF NOT EXISTS openresolve_ai_commands (
  tenant_id UUID NOT NULL, scope_hash CHAR(64) NOT NULL, request_hash CHAR(64) NOT NULL,
  response JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,scope_hash)
);
CREATE TABLE IF NOT EXISTS openresolve_ai_history (
  sequence BIGSERIAL PRIMARY KEY, tenant_id UUID NOT NULL, resource_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('EXPLANATION','PROPOSAL')), snapshot JSONB NOT NULL,
  sha256 CHAR(64) NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION openresolve_ai_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'AI history/commands are append-only'; END $$;
DROP TRIGGER IF EXISTS openresolve_ai_history_immutable ON openresolve_ai_history;
CREATE TRIGGER openresolve_ai_history_immutable BEFORE UPDATE OR DELETE ON openresolve_ai_history FOR EACH ROW EXECUTE FUNCTION openresolve_ai_append_only();
DROP TRIGGER IF EXISTS openresolve_ai_commands_immutable ON openresolve_ai_commands;
CREATE TRIGGER openresolve_ai_commands_immutable BEFORE UPDATE OR DELETE ON openresolve_ai_commands FOR EACH ROW EXECUTE FUNCTION openresolve_ai_append_only();
CREATE OR REPLACE FUNCTION openresolve_ai_control_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI controls cannot be deleted'; END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.revision <= OLD.revision THEN RAISE EXCEPTION 'AI control revision must advance'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS openresolve_ai_controls_revision ON openresolve_ai_controls;
CREATE TRIGGER openresolve_ai_controls_revision BEFORE UPDATE OR DELETE ON openresolve_ai_controls FOR EACH ROW EXECUTE FUNCTION openresolve_ai_control_revision();
CREATE OR REPLACE FUNCTION openresolve_ai_record_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE field TEXT;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI source/proposal records cannot be deleted'; END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'AI identity is immutable'; END IF;
  IF TG_TABLE_NAME='openresolve_ai_explanations' THEN
    IF NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.data->'operation'->>'id' IS DISTINCT FROM OLD.data->'operation'->>'id' THEN RAISE EXCEPTION 'AI operation identity is immutable'; END IF;
    FOREACH field IN ARRAY ARRAY['id','tenantId','requester','caseId','question','controlVersion','acknowledgement','createdAt'] LOOP
      IF NEW.data->field IS DISTINCT FROM OLD.data->field THEN RAISE EXCEPTION 'AI request is immutable'; END IF;
    END LOOP;
    IF OLD.data ? 'snapshot' AND NEW.data->'snapshot' IS DISTINCT FROM OLD.data->'snapshot' THEN RAISE EXCEPTION 'AI source snapshot is immutable'; END IF;
    IF OLD.data->'operation'->>'state' IN ('SUCCEEDED','FAILED') AND NEW.data IS DISTINCT FROM OLD.data THEN RAISE EXCEPTION 'AI terminal result is immutable'; END IF;
  ELSE
    FOREACH field IN ARRAY ARRAY['id','tenantId','explanationId','requester','caseId','snapshotHash','policyHash','controlVersion','input','risk','requiresApproval','hash','createdAt'] LOOP
      IF NEW.data->field IS DISTINCT FROM OLD.data->field THEN RAISE EXCEPTION 'AI proposal is immutable'; END IF;
    END LOOP;
    IF OLD.data ? 'approval' AND NEW.data->'approval' IS DISTINCT FROM OLD.data->'approval' THEN RAISE EXCEPTION 'AI approval is immutable'; END IF;
    IF OLD.data->>'state'='EXECUTED' AND NEW.data IS DISTINCT FROM OLD.data THEN RAISE EXCEPTION 'AI execution receipt is immutable'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS openresolve_ai_explanations_immutable ON openresolve_ai_explanations;
CREATE TRIGGER openresolve_ai_explanations_immutable BEFORE UPDATE OR DELETE ON openresolve_ai_explanations FOR EACH ROW EXECUTE FUNCTION openresolve_ai_record_immutable();
DROP TRIGGER IF EXISTS openresolve_ai_proposals_immutable ON openresolve_ai_proposals;
CREATE TRIGGER openresolve_ai_proposals_immutable BEFORE UPDATE OR DELETE ON openresolve_ai_proposals FOR EACH ROW EXECUTE FUNCTION openresolve_ai_record_immutable();
