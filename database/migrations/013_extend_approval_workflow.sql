-- Issue #9: additive workflow persistence. Existing migrations and financial evidence remain unchanged.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT invoice_id FROM approval_cases GROUP BY invoice_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Migration 013 requires one approval case per invoice; review historical duplicates first';
  END IF;
END $$;
ALTER TABLE approval_cases
  DROP CONSTRAINT chk_approval_status,
  ADD CONSTRAINT chk_approval_status CHECK(status IN ('STARTING','PENDING','APPROVED','REJECTED','CANCELLED','FAILED','CREDIT_NOTE_REQUESTED')),
  ADD COLUMN case_type VARCHAR(50) NOT NULL DEFAULT 'EXCEPTION_REVIEW',
  ADD COLUMN assigned_role VARCHAR(50),
  ADD COLUMN current_stage VARCHAR(50),
  ADD COLUMN decision VARCHAR(50),
  ADD COLUMN decision_reason TEXT,
  ADD COLUMN requested_by_subject VARCHAR(100),
  ADD COLUMN resolved_by_subject VARCHAR(100),
  ADD COLUMN match_snapshot JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN workflow_definition_key VARCHAR(100),
  ADD COLUMN workflow_definition_version VARCHAR(50),
  ADD CONSTRAINT uq_approval_case_invoice UNIQUE(invoice_id),
  ADD CONSTRAINT chk_approval_case_type CHECK(case_type IN ('EXCEPTION_REVIEW','CLEAN_FINANCE')),
  ADD CONSTRAINT chk_approval_case_role CHECK(assigned_role IN ('warehouse','buyer','accountant','finance_manager')),
  ADD CONSTRAINT chk_approval_case_stage CHECK(current_stage IN ('STARTING','DOMAIN_REVIEW','FINANCE_REVIEW','RESOLVED','FAILED')),
  ADD CONSTRAINT chk_approval_case_decision CHECK(decision IN ('APPROVE','APPROVE_WITH_ADJUSTMENT','REJECT','REQUEST_CREDIT_NOTE')),
  ADD CONSTRAINT chk_approval_case_snapshot CHECK(jsonb_typeof(match_snapshot)='object');
CREATE TABLE approval_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_case_id UUID NOT NULL REFERENCES approval_cases(id) ON DELETE RESTRICT,
  flowable_task_id VARCHAR(100) NOT NULL UNIQUE,
  task_key VARCHAR(100) NOT NULL,
  task_name VARCHAR(255) NOT NULL,
  assigned_role VARCHAR(50) NOT NULL CHECK(assigned_role IN ('warehouse','buyer','accountant','finance_manager')),
  assignee_subject VARCHAR(100),
  status VARCHAR(30) NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLAIMED','COMPLETED','CANCELLED')),
  action VARCHAR(50),
  action_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CONSTRAINT chk_approval_task_state CHECK(
    (status='OPEN' AND assignee_subject IS NULL AND claimed_at IS NULL AND action IS NULL AND completed_at IS NULL) OR
    (status='CLAIMED' AND assignee_subject IS NOT NULL AND claimed_at IS NOT NULL AND action IS NULL AND completed_at IS NULL) OR
    (status='COMPLETED' AND action IS NOT NULL AND action IN ('APPROVE','APPROVE_WITH_ADJUSTMENT','REJECT','REQUEST_CREDIT_NOTE') AND completed_at IS NOT NULL) OR
    (status='CANCELLED' AND action IS NULL AND completed_at IS NOT NULL)),
  CONSTRAINT chk_approval_task_reason CHECK(action NOT IN ('REJECT','REQUEST_CREDIT_NOTE','APPROVE_WITH_ADJUSTMENT') OR length(btrim(COALESCE(action_reason,'')))>0),
  CONSTRAINT uq_approval_task_case UNIQUE(id,approval_case_id)
);
CREATE TABLE approval_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_case_id UUID NOT NULL REFERENCES approval_cases(id) ON DELETE RESTRICT,
  approval_task_id UUID NOT NULL UNIQUE REFERENCES approval_tasks(id) ON DELETE RESTRICT,
  action VARCHAR(50) NOT NULL CHECK(action IN ('APPROVE','APPROVE_WITH_ADJUSTMENT','REJECT','REQUEST_CREDIT_NOTE')),
  reason TEXT,
  actor_subject VARCHAR(100) NOT NULL,
  actor_roles TEXT[] NOT NULL,
  previous_case_status VARCHAR(30) NOT NULL,
  new_case_status VARCHAR(30) NOT NULL,
  previous_invoice_status VARCHAR(30) NOT NULL,
  new_invoice_status VARCHAR(30) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_approval_decision_reason CHECK(action='APPROVE' OR length(btrim(COALESCE(reason,'')))>0),
  CONSTRAINT fk_approval_decision_task_case FOREIGN KEY(approval_task_id,approval_case_id) REFERENCES approval_tasks(id,approval_case_id) ON DELETE RESTRICT
);
CREATE TABLE workflow_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_code VARCHAR(50) NOT NULL UNIQUE,
  auto_ready_for_payment_max_amount NUMERIC(18,2),
  finance_approval_threshold NUMERIC(18,2) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_workflow_stp_max CHECK(auto_ready_for_payment_max_amount IS NULL OR (auto_ready_for_payment_max_amount >= 0 AND auto_ready_for_payment_max_amount < 'Infinity'::numeric)),
  CONSTRAINT chk_workflow_finance_threshold CHECK(finance_approval_threshold >= 0 AND finance_approval_threshold < 'Infinity'::numeric)
);
CREATE UNIQUE INDEX uq_workflow_policy_active ON workflow_policies(is_active) WHERE is_active;
INSERT INTO workflow_policies(policy_code,auto_ready_for_payment_max_amount,finance_approval_threshold)
  VALUES('WORKFLOW_DEFAULT',NULL,100000000.00);
CREATE TRIGGER trg_workflow_policies_updated_at BEFORE UPDATE ON workflow_policies FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Durable external-command intent; a committed command is reconciled before any other case action.
CREATE TABLE workflow_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_case_id UUID NOT NULL REFERENCES approval_cases(id) ON DELETE RESTRICT,
  approval_task_id UUID REFERENCES approval_tasks(id) ON DELETE RESTRICT,
  operation VARCHAR(20) NOT NULL CHECK(operation IN ('START','CLAIM','COMPLETE')),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPLIED','FAILED')),
  payload JSONB NOT NULL CHECK(jsonb_typeof(payload)='object'),
  actor_subject VARCHAR(100) NOT NULL,
  actor_roles TEXT[] NOT NULL,
  error_code VARCHAR(100),
  retry_safe BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_workflow_operation_task CHECK((operation='START' AND approval_task_id IS NULL) OR (operation IN ('CLAIM','COMPLETE') AND approval_task_id IS NOT NULL)),
  CONSTRAINT fk_workflow_operation_task_case FOREIGN KEY(approval_task_id,approval_case_id) REFERENCES approval_tasks(id,approval_case_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX uq_workflow_unapplied_case ON workflow_operations(approval_case_id) WHERE status IN ('PENDING','FAILED');
CREATE INDEX idx_approval_case_status ON approval_cases(status,requested_at);
CREATE INDEX idx_approval_tasks_role ON approval_tasks(assigned_role,status,created_at);
CREATE INDEX idx_approval_tasks_case ON approval_tasks(approval_case_id);
CREATE INDEX idx_approval_decisions_case ON approval_decisions(approval_case_id,created_at);
CREATE INDEX idx_workflow_operations_case ON workflow_operations(approval_case_id,created_at);
-- Protect snapshot/decision evidence from accidental application rewrites.
CREATE FUNCTION preserve_workflow_match_snapshot() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.match_snapshot IS DISTINCT FROM OLD.match_snapshot THEN
    RAISE EXCEPTION 'Approval case matching/policy snapshot is immutable' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_preserve_workflow_match_snapshot BEFORE UPDATE OF match_snapshot ON approval_cases
  FOR EACH ROW EXECUTE FUNCTION preserve_workflow_match_snapshot();
CREATE FUNCTION preserve_approval_decision() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'Approval decisions are append-only' USING ERRCODE='check_violation'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_preserve_approval_decisions BEFORE UPDATE OR DELETE ON approval_decisions
  FOR EACH ROW EXECUTE FUNCTION preserve_approval_decision();
COMMIT;

