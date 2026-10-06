-- Issue #10. PostgreSQL guards are not the independent immutable authority.
BEGIN;
CREATE TABLE audit_finalizations (
  invoice_id UUID PRIMARY KEY REFERENCES invoices(id) ON DELETE RESTRICT,
  match_result_id UUID NOT NULL REFERENCES match_results(id) ON DELETE RESTRICT,
  approval_case_id UUID REFERENCES approval_cases(id) ON DELETE RESTRICT,
  final_business_state VARCHAR(50) NOT NULL CHECK(final_business_state IN ('READY_FOR_PAYMENT','REJECTED','CREDIT_NOTE_REQUESTED')),
  finalized_at TIMESTAMPTZ NOT NULL,
  source_snapshot JSONB NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),
  actor_subject VARCHAR(100) NOT NULL,
  capture_mode VARCHAR(20) NOT NULL CHECK(capture_mode IN ('FINALIZATION','BACKFILL')),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','BUILT','FAILED')),
  last_error_code VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_audit_finalizations_pending ON audit_finalizations(status,created_at);
CREATE TABLE audit_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL UNIQUE REFERENCES invoices(id) ON DELETE RESTRICT,
  match_result_id UUID NOT NULL REFERENCES match_results(id) ON DELETE RESTRICT,
  approval_case_id UUID REFERENCES approval_cases(id) ON DELETE RESTRICT,
  package_version VARCHAR(30) NOT NULL,
  canonicalization_version VARCHAR(30) NOT NULL,
  package_json JSONB NOT NULL CHECK(jsonb_typeof(package_json)='object'),
  package_sha256 CHAR(64) NOT NULL CHECK(package_sha256 ~ '^[0-9a-f]{64}$'),
  merkle_root CHAR(64) NOT NULL CHECK(merkle_root ~ '^[0-9a-f]{64}$'),
  leaf_count INTEGER NOT NULL CHECK(leaf_count > 0),
  final_business_state VARCHAR(50) NOT NULL CHECK(final_business_state IN ('READY_FOR_PAYMENT','REJECTED','CREDIT_NOTE_REQUESTED')),
  built_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_audit_package_invoice_pair UNIQUE(id,invoice_id)
);
CREATE TABLE audit_seals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_package_id UUID NOT NULL UNIQUE REFERENCES audit_packages(id) ON DELETE RESTRICT,
  invoice_id UUID NOT NULL UNIQUE REFERENCES invoices(id) ON DELETE RESTRICT,
  seal_key VARCHAR(150) NOT NULL UNIQUE,
  package_sha256 CHAR(64) NOT NULL CHECK(package_sha256 ~ '^[0-9a-f]{64}$'),
  merkle_root CHAR(64) NOT NULL CHECK(merkle_root ~ '^[0-9a-f]{64}$'),
  immudb_tx_id BIGINT CHECK(immudb_tx_id > 0),
  immudb_tx_hash VARCHAR(128) CHECK(immudb_tx_hash ~ '^[0-9a-f]{64}$'),
  immudb_state_tx_id BIGINT CHECK(immudb_state_tx_id > 0),
  immudb_state_hash VARCHAR(128) CHECK(immudb_state_hash ~ '^[0-9a-f]{64}$'),
  receipt JSONB,
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SEALED','FAILED')),
  sealed_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  last_verification_status VARCHAR(30) NOT NULL DEFAULT 'NOT_VERIFIED'
    CHECK(last_verification_status IN ('VERIFIED','TAMPERED','LEDGER_MISMATCH','UNAVAILABLE','NOT_VERIFIED')),
  last_error_code VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_seal_package_invoice FOREIGN KEY(audit_package_id,invoice_id) REFERENCES audit_packages(id,invoice_id) ON DELETE RESTRICT,
  CONSTRAINT chk_audit_sealed_receipt CHECK(status <> 'SEALED' OR
    (immudb_tx_id IS NOT NULL AND immudb_tx_hash IS NOT NULL AND immudb_state_tx_id IS NOT NULL
     AND immudb_state_hash IS NOT NULL AND sealed_at IS NOT NULL AND receipt IS NOT NULL))
);
CREATE INDEX idx_audit_seals_status ON audit_seals(status,created_at);
CREATE TABLE audit_seal_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_package_id UUID NOT NULL REFERENCES audit_packages(id) ON DELETE RESTRICT,
  operation VARCHAR(20) NOT NULL CHECK(operation IN ('SEAL','VERIFY')),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPLIED','FAILED')),
  actor_subject VARCHAR(100) NOT NULL,
  error_code VARCHAR(100),
  retry_safe BOOLEAN NOT NULL DEFAULT false,
  dispatched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX uq_audit_unapplied_seal ON audit_seal_operations(audit_package_id)
  WHERE operation='SEAL' AND status IN ('PENDING','FAILED');
CREATE INDEX idx_audit_operations_package ON audit_seal_operations(audit_package_id,created_at);
CREATE FUNCTION preserve_audit_package() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'Historical audit package evidence cannot be changed' USING ERRCODE='check_violation'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_preserve_audit_package BEFORE UPDATE OR DELETE ON audit_packages
  FOR EACH ROW EXECUTE FUNCTION preserve_audit_package();
CREATE FUNCTION preserve_audit_finalization() RETURNS TRIGGER AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','last_error_code','updated_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','last_error_code','updated_at']) THEN
    RAISE EXCEPTION 'Finalization evidence cannot be changed' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_preserve_audit_finalization BEFORE UPDATE ON audit_finalizations
  FOR EACH ROW EXECUTE FUNCTION preserve_audit_finalization();
CREATE FUNCTION check_audit_package_links() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM match_results WHERE id=NEW.match_result_id AND invoice_id=NEW.invoice_id)
    OR (NEW.approval_case_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM approval_cases
      WHERE id=NEW.approval_case_id AND invoice_id=NEW.invoice_id AND match_result_id=NEW.match_result_id)) THEN
    RAISE EXCEPTION 'Audit evidence document links disagree' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_package_links BEFORE INSERT ON audit_packages FOR EACH ROW EXECUTE FUNCTION check_audit_package_links();
CREATE TRIGGER trg_audit_finalization_links BEFORE INSERT ON audit_finalizations FOR EACH ROW EXECUTE FUNCTION check_audit_package_links();
COMMIT;
