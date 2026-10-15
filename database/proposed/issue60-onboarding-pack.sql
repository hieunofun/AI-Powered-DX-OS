-- SPDX-License-Identifier: MIT
-- Pack-owned review candidate. No numbered core migration, HR core column or external provisioning.
CREATE TABLE IF NOT EXISTS onboarding_cases (
  tenant_id UUID NOT NULL, id UUID NOT NULL, data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(tenant_id,id), CHECK(data->>'tenantId'=tenant_id::text AND data->>'id'=id::text AND data->>'provisioningState'='NOT_PROVISIONED')
);
CREATE INDEX IF NOT EXISTS onboarding_worker_queue ON onboarding_cases(tenant_id,created_at,id)
  WHERE data->'intent' IS NOT NULL;
CREATE TABLE IF NOT EXISTS onboarding_commands (
  tenant_id UUID NOT NULL, scope_hash CHAR(64) NOT NULL, request_hash CHAR(64) NOT NULL,
  response JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,scope_hash)
);
CREATE TABLE IF NOT EXISTS onboarding_history (
  sequence BIGSERIAL PRIMARY KEY, tenant_id UUID NOT NULL, case_id UUID NOT NULL, record JSONB NOT NULL,
  sha256 CHAR(64) NOT NULL, recorded_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY(tenant_id,case_id) REFERENCES onboarding_cases(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS onboarding_snapshots (
  tenant_id UUID NOT NULL, id UUID NOT NULL, case_id UUID NOT NULL, data JSONB NOT NULL, sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,case_id) REFERENCES onboarding_cases(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS onboarding_event_outbox (
  tenant_id UUID NOT NULL, id UUID NOT NULL, case_id UUID NOT NULL, event JSONB NOT NULL,
  snapshot_id UUID NOT NULL, state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state='PENDING'),
  PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,case_id) REFERENCES onboarding_cases(tenant_id,id),
  FOREIGN KEY(tenant_id,snapshot_id) REFERENCES onboarding_snapshots(tenant_id,id)
);
CREATE OR REPLACE FUNCTION onboarding_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Onboarding source history/commands/snapshots/intents are append-only'; END; $$;
DROP TRIGGER IF EXISTS onboarding_history_immutable ON onboarding_history;
CREATE TRIGGER onboarding_history_immutable BEFORE UPDATE OR DELETE ON onboarding_history FOR EACH ROW EXECUTE FUNCTION onboarding_append_only();
DROP TRIGGER IF EXISTS onboarding_commands_immutable ON onboarding_commands;
CREATE TRIGGER onboarding_commands_immutable BEFORE UPDATE OR DELETE ON onboarding_commands FOR EACH ROW EXECUTE FUNCTION onboarding_append_only();
DROP TRIGGER IF EXISTS onboarding_snapshots_immutable ON onboarding_snapshots;
CREATE TRIGGER onboarding_snapshots_immutable BEFORE UPDATE OR DELETE ON onboarding_snapshots FOR EACH ROW EXECUTE FUNCTION onboarding_append_only();
DROP TRIGGER IF EXISTS onboarding_events_immutable ON onboarding_event_outbox;
CREATE TRIGGER onboarding_events_immutable BEFORE UPDATE OR DELETE ON onboarding_event_outbox FOR EACH ROW EXECUTE FUNCTION onboarding_append_only();
CREATE OR REPLACE FUNCTION onboarding_case_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE field TEXT; receipt JSONB;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Onboarding cases cannot be deleted'; END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'Onboarding identity is immutable'; END IF;
  FOREACH field IN ARRAY ARRAY['id','tenantId','requester','displayLabel','createdAt','manifestSha256','binding','provisioningState'] LOOP
    IF NEW.data->field IS DISTINCT FROM OLD.data->field THEN RAISE EXCEPTION 'Onboarding source is immutable'; END IF;
  END LOOP;
  FOR receipt IN SELECT value FROM jsonb_array_elements(OLD.data->'checklist') LOOP
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.data->'checklist') item WHERE item=receipt) THEN RAISE EXCEPTION 'Checklist receipts are immutable'; END IF;
  END LOOP;
  IF OLD.data ? 'request' AND (NEW.data->'request' IS DISTINCT FROM OLD.data->'request' OR NEW.data->'requestHash' IS DISTINCT FROM OLD.data->'requestHash' OR NEW.data->'checklist' IS DISTINCT FROM OLD.data->'checklist') THEN RAISE EXCEPTION 'Requested checklist/facts are immutable'; END IF;
  IF OLD.data ? 'decision' AND NEW.data->'decision' IS DISTINCT FROM OLD.data->'decision' THEN RAISE EXCEPTION 'Verified decision is immutable'; END IF;
  IF OLD.data ? 'workflow' AND (NEW.data->'workflow'->>'businessKey' IS DISTINCT FROM OLD.data->'workflow'->>'businessKey' OR NEW.data->'workflow'->>'definitionId' IS DISTINCT FROM OLD.data->'workflow'->>'definitionId') THEN RAISE EXCEPTION 'Workflow intent is immutable'; END IF;
  IF OLD.data->'workflow' ? 'processId' AND NEW.data->'workflow'->>'processId' IS DISTINCT FROM OLD.data->'workflow'->>'processId' THEN RAISE EXCEPTION 'Workflow binding is immutable'; END IF;
  IF OLD.data->'workflow' ? 'taskId' AND NEW.data->'workflow'->>'taskId' IS DISTINCT FROM OLD.data->'workflow'->>'taskId' THEN RAISE EXCEPTION 'Task binding is immutable'; END IF;
  IF OLD.data->>'state' IN ('COMPLETED','REJECTED') AND NEW.data IS DISTINCT FROM OLD.data THEN RAISE EXCEPTION 'Terminal case is immutable'; END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS onboarding_cases_guard ON onboarding_cases;
CREATE TRIGGER onboarding_cases_guard BEFORE UPDATE OR DELETE ON onboarding_cases FOR EACH ROW EXECUTE FUNCTION onboarding_case_guard();
