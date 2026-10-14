-- Proposed isolated fixture schema; coordinate numbered migration/tenant FK with A in #43.
BEGIN;
CREATE TABLE IF NOT EXISTS platform_lineage_snapshots (
  tenant_id UUID NOT NULL,
  resource_key TEXT NOT NULL CHECK(resource_key ~ '^[a-f0-9]{64}$'),
  sha256 TEXT NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  data JSONB NOT NULL CHECK(jsonb_typeof(data)='object'),
  PRIMARY KEY(tenant_id,resource_key)
);
CREATE TABLE IF NOT EXISTS platform_lineage_links (
  sequence BIGSERIAL UNIQUE NOT NULL,
  tenant_id UUID NOT NULL,
  evidence_id UUID NOT NULL,
  edge_key TEXT NOT NULL CHECK(edge_key ~ '^[a-f0-9]{64}$'),
  sha256 TEXT NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  from_key TEXT NOT NULL,
  to_key TEXT NOT NULL,
  link JSONB NOT NULL CHECK(jsonb_typeof(link)='object' AND link->>'tenant_id'=tenant_id::text),
  PRIMARY KEY(tenant_id,evidence_id,edge_key),
  FOREIGN KEY(tenant_id,evidence_id) REFERENCES platform_evidence_records(tenant_id,id),
  FOREIGN KEY(tenant_id,from_key) REFERENCES platform_lineage_snapshots(tenant_id,resource_key),
  FOREIGN KEY(tenant_id,to_key) REFERENCES platform_lineage_snapshots(tenant_id,resource_key)
);
CREATE INDEX IF NOT EXISTS platform_lineage_source_sequence ON platform_lineage_links(tenant_id,evidence_id,sequence);
CREATE OR REPLACE FUNCTION platform_lineage_preserve_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Lineage history is append-only'; END; $$;
DROP TRIGGER IF EXISTS platform_lineage_snapshot_immutable ON platform_lineage_snapshots;
CREATE TRIGGER platform_lineage_snapshot_immutable BEFORE UPDATE OR DELETE ON platform_lineage_snapshots FOR EACH ROW EXECUTE FUNCTION platform_lineage_preserve_history();
DROP TRIGGER IF EXISTS platform_lineage_link_immutable ON platform_lineage_links;
CREATE TRIGGER platform_lineage_link_immutable BEFORE UPDATE OR DELETE ON platform_lineage_links FOR EACH ROW EXECUTE FUNCTION platform_lineage_preserve_history();
COMMIT;
