-- SPDX-License-Identifier: MIT
-- Apply only to a SEPARATE cold database. No hot migration number, source rewrite or purge.
CREATE TABLE IF NOT EXISTS platform_history_snapshots (
  tenant_id UUID NOT NULL, stream TEXT NOT NULL, id UUID NOT NULL,
  capture_sequence BIGSERIAL NOT NULL UNIQUE,
  epoch UUID NOT NULL, source_sequence BIGINT NOT NULL CHECK(source_sequence>0),
  event_id UUID NOT NULL, captured_at TIMESTAMPTZ NOT NULL,
  native_hash CHAR(64) NOT NULL, case_key TEXT NOT NULL, data JSONB NOT NULL,
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,stream,event_id), UNIQUE(tenant_id,stream,epoch,source_sequence),
  CHECK(data->>'tenantId'=tenant_id::text AND data->>'id'=id::text AND data->>'stream'=stream AND data->>'nativeHash'=native_hash::text)
);
CREATE INDEX IF NOT EXISTS platform_history_latest_case ON platform_history_snapshots(tenant_id,stream,case_key,source_sequence DESC);
CREATE INDEX IF NOT EXISTS platform_history_source_page ON platform_history_snapshots(tenant_id,stream,source_sequence);
CREATE INDEX IF NOT EXISTS platform_history_capture_page ON platform_history_snapshots(tenant_id,stream,capture_sequence);
CREATE TABLE IF NOT EXISTS platform_history_lineage (
  tenant_id UUID NOT NULL, snapshot_id UUID NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=0), edge JSONB NOT NULL,
  PRIMARY KEY(tenant_id,snapshot_id,ordinal), FOREIGN KEY(tenant_id,snapshot_id) REFERENCES platform_history_snapshots(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS platform_history_projection_jobs (
  tenant_id UUID NOT NULL, stream TEXT NOT NULL, job_id TEXT NOT NULL,
  data JSONB NOT NULL, PRIMARY KEY(tenant_id,stream,job_id),
  CHECK(data->>'tenantId'=tenant_id::text AND data->>'stream'=stream AND data->>'jobId'=job_id)
);
CREATE TABLE IF NOT EXISTS platform_history_projection_runs (
  id BIGSERIAL PRIMARY KEY, tenant_id UUID NOT NULL, stream TEXT NOT NULL, job_id TEXT NOT NULL,
  previous_cursor BIGINT NOT NULL, scanned_through BIGINT NOT NULL CHECK(scanned_through>=previous_cursor),
  source_through BIGINT NOT NULL CHECK(source_through>=scanned_through),
  inserted INTEGER NOT NULL CHECK(inserted>=0), replayed INTEGER NOT NULL CHECK(replayed>=0),
  captured_at TIMESTAMPTZ NOT NULL, epoch UUID NOT NULL,
  FOREIGN KEY(tenant_id,stream,job_id) REFERENCES platform_history_projection_jobs(tenant_id,stream,job_id)
);
CREATE OR REPLACE FUNCTION platform_history_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Cold snapshots, lineage and projection runs are append-only'; END $$;
DROP TRIGGER IF EXISTS platform_history_snapshots_immutable ON platform_history_snapshots;
CREATE TRIGGER platform_history_snapshots_immutable BEFORE UPDATE OR DELETE ON platform_history_snapshots FOR EACH ROW EXECUTE FUNCTION platform_history_append_only();
DROP TRIGGER IF EXISTS platform_history_lineage_immutable ON platform_history_lineage;
CREATE TRIGGER platform_history_lineage_immutable BEFORE UPDATE OR DELETE ON platform_history_lineage FOR EACH ROW EXECUTE FUNCTION platform_history_append_only();
DROP TRIGGER IF EXISTS platform_history_projection_runs_immutable ON platform_history_projection_runs;
CREATE TRIGGER platform_history_projection_runs_immutable BEFORE UPDATE OR DELETE ON platform_history_projection_runs FOR EACH ROW EXECUTE FUNCTION platform_history_append_only();
CREATE OR REPLACE FUNCTION platform_history_checkpoint_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Projection checkpoints cannot be deleted'; END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.stream IS DISTINCT FROM OLD.stream OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.data->>'epoch' IS DISTINCT FROM OLD.data->>'epoch' OR NEW.data->>'mode' IS DISTINCT FROM OLD.data->>'mode'
    OR (NEW.data->>'after')::bigint < (OLD.data->>'after')::bigint
    OR (OLD.data->>'mode'='BACKFILL' AND NEW.data->>'through' IS DISTINCT FROM OLD.data->>'through') THEN
    RAISE EXCEPTION 'Projection checkpoint identity, epoch and cursor are immutable/monotonic';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS platform_history_jobs_guard ON platform_history_projection_jobs;
CREATE TRIGGER platform_history_jobs_guard BEFORE UPDATE OR DELETE ON platform_history_projection_jobs FOR EACH ROW EXECUTE FUNCTION platform_history_checkpoint_guard();
