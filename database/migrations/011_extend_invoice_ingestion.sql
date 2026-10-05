-- Issue #7: additive migration. Legacy invoice normalized identities remain NULL;
-- audited backfill must resolve collisions before populating legacy rows.
BEGIN;

ALTER TABLE invoices
    ADD COLUMN seller_tax_code VARCHAR(50),
    ADD COLUMN buyer_tax_code VARCHAR(50),
    ADD COLUMN invoice_number_normalized VARCHAR(100);
ALTER TABLE invoices ADD CONSTRAINT chk_invoice_number_normalized
    CHECK (invoice_number_normalized IS NULL OR length(trim(invoice_number_normalized)) > 0);
CREATE UNIQUE INDEX uq_invoice_supplier_normalized
    ON invoices (supplier_id, invoice_number_normalized)
    WHERE invoice_number_normalized IS NOT NULL;

CREATE TABLE invoice_ingestions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    invoice_id UUID UNIQUE REFERENCES invoices(id) ON DELETE RESTRICT,
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING_UPLOAD',
    error_code VARCHAR(100),
    error_message TEXT,
    created_by_subject VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_invoice_ingestion_status CHECK (status IN
        ('PENDING_UPLOAD', 'STORED', 'PARSED', 'OCR_REQUIRED', 'FAILED')),
    CONSTRAINT chk_invoice_ingestion_parsed CHECK
        ((status = 'PARSED') = (invoice_id IS NOT NULL))
);
CREATE INDEX idx_invoice_ingestions_po ON invoice_ingestions(purchase_order_id);
CREATE INDEX idx_invoice_ingestions_supplier ON invoice_ingestions(supplier_id);
CREATE INDEX idx_invoice_ingestions_status_created ON invoice_ingestions(status, created_at);
CREATE TRIGGER trg_invoice_ingestions_updated_at BEFORE UPDATE ON invoice_ingestions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE invoice_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ingestion_id UUID NOT NULL REFERENCES invoice_ingestions(id) ON DELETE RESTRICT,
    file_kind VARCHAR(10) NOT NULL,
    object_key VARCHAR(512) NOT NULL UNIQUE,
    original_filename VARCHAR(255) NOT NULL,
    media_type VARCHAR(100) NOT NULL,
    size_bytes BIGINT NOT NULL,
    sha256 CHAR(64) NOT NULL,
    processing_status VARCHAR(30) NOT NULL DEFAULT 'PENDING_UPLOAD',
    parse_error_code VARCHAR(100),
    parse_error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_invoice_file_kind UNIQUE (ingestion_id, file_kind),
    CONSTRAINT chk_invoice_file_kind CHECK (file_kind IN ('XML', 'PDF')),
    CONSTRAINT chk_invoice_file_status CHECK (processing_status IN
        ('PENDING_UPLOAD', 'STORED', 'PARSED', 'OCR_REQUIRED', 'FAILED')),
    CONSTRAINT chk_invoice_file_size CHECK (size_bytes > 0),
    CONSTRAINT chk_invoice_file_sha256 CHECK (sha256 ~ '^[0-9a-fA-F]{64}$')
);
CREATE INDEX idx_invoice_files_ingestion ON invoice_files(ingestion_id);
COMMIT;
