-- ==============================================================================
-- Migration: 007_create_approval_and_audit.sql
-- Description: Create approval_cases and audit_records tables
-- ==============================================================================

CREATE TABLE IF NOT EXISTS approval_cases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
    match_result_id UUID REFERENCES match_results(id) ON DELETE RESTRICT,
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    workflow_instance_id VARCHAR(100),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMPTZ,
    resolution_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_approval_status CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'))
);

CREATE TRIGGER trg_approval_cases_updated_at
BEFORE UPDATE ON approval_cases
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Consistency Check: approval_cases match_result_id must belong to the same invoice
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_approval_case_document_consistency()
RETURNS TRIGGER AS $$
DECLARE
    v_match_inv_id UUID;
BEGIN
    IF NEW.match_result_id IS NOT NULL THEN
        SELECT invoice_id INTO v_match_inv_id
        FROM match_results
        WHERE id = NEW.match_result_id;

        IF v_match_inv_id IS DISTINCT FROM NEW.invoice_id THEN
            RAISE EXCEPTION 'Cross-document integrity violation: approval_cases match_result_id (%) belongs to invoice %, not %',
                NEW.match_result_id, v_match_inv_id, NEW.invoice_id
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_approval_case_document_consistency
BEFORE INSERT OR UPDATE OF invoice_id, match_result_id
ON approval_cases
FOR EACH ROW
EXECUTE FUNCTION check_approval_case_document_consistency();

CREATE TABLE IF NOT EXISTS audit_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type VARCHAR(50) NOT NULL,
    entity_id UUID NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    actor_subject VARCHAR(100),
    payload_hash VARCHAR(128),
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
