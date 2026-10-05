#!/usr/bin/env bash
# Acceptance evidence requires the REAL disposable Docker stack, never production.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
GATEWAY_URL="${GATEWAY_URL:-http://localhost:9080}"
KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8080}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-smartprocure-postgres}"
API_CONTAINER="${API_CONTAINER:-smartprocure-api}"
POSTGRES_USER="${POSTGRES_USER:-smartprocure_user}"
POSTGRES_DB="${POSTGRES_DB:-smartprocure_db}"
work=$(mktemp -d)
rollback_trigger=0
sql() { docker exec "$POSTGRES_CONTAINER" psql -X -q -t -A -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"; }
cleanup() {
  if [[ "$rollback_trigger" == 1 ]]; then
    sql 'DROP TRIGGER IF EXISTS trg_invoice_test_rollback ON invoice_items; DROP FUNCTION IF EXISTS invoice_test_rollback();' >/dev/null || true
  fi
  rm -rf -- "$work"
}
trap cleanup EXIT
assert_eq() { [[ "$1" == "$2" ]] || { echo "FAIL $3: expected $2, got $1"; exit 1; }; }
token() {
  curl --fail --silent --show-error --max-time 20 -X POST "$KEYCLOAK_URL/realms/${KEYCLOAK_REALM:-smartprocure}/protocol/openid-connect/token" \
    --data-urlencode "client_id=${CI_CLIENT_ID:-smartprocure-ci}" --data-urlencode 'grant_type=password' \
    --data-urlencode "username=$1" --data-urlencode "password=${DEMO_PASSWORD:-DemoPassword123!}" | jq -er '.access_token'
}
echo 'Waiting for real MinIO health endpoint...'
ready=0
for ((attempt=0; attempt<60; attempt++)); do
  if curl --fail --silent --max-time 2 "http://localhost:${MINIO_PORT:-9000}/minio/health/live" >/dev/null; then ready=1; break; fi
  sleep 2
done
assert_eq "$ready" 1 'MinIO bounded readiness'
ACCOUNTANT_TOKEN=$(token accountant.demo)
BUYER_TOKEN=$(token buyer.demo)
WAREHOUSE_TOKEN=$(token warehouse.demo)
ADMIN_TOKEN=$(token admin.demo)
run_id="$(date +%s)-$RANDOM"
supplier_id=$(sql "INSERT INTO suppliers(supplier_code,tax_code,name) VALUES ('INV-TEST-$run_id','0101234567001-$run_id','Invoice Integration Supplier') RETURNING id;")
payload=$(jq -nc --arg supplier "$supplier_id" '{supplierId:$supplier,currency:"VND",orderDate:"2026-10-05",items:[{description:"Invoice test goods",orderedQuantity:"100.0000",unitPrice:"100.1234",taxRate:"0.0800"}]}')
code=$(curl -sS --max-time 30 -o "$work/po.json" -w '%{http_code}' "$GATEWAY_URL/api/purchase-orders" -H "Authorization: Bearer $BUYER_TOKEN" -H 'Content-Type: application/json' -d "$payload")
assert_eq "$code" 201 'Create PO via gateway'
po_id=$(jq -er '.id' "$work/po.json")
version=$(jq -er '.version' "$work/po.json")
code=$(curl -sS --max-time 30 -o "$work/issued.json" -w '%{http_code}' -X POST "$GATEWAY_URL/api/purchase-orders/$po_id/issue" -H "Authorization: Bearer $BUYER_TOKEN" -H 'Content-Type: application/json' -d "{\"expectedVersion\":$version}")
assert_eq "$code" 200 'Issue PO via gateway'
for source in infra/invoice/fixtures/*.xml; do
  sed "s/0101234567-001/0101234567001-$run_id/g" "$source" > "$work/$(basename "$source")"
done
ingest() {
  local output="$1"; shift
  curl -sS --max-time 60 -o "$output" -w '%{http_code}' "$GATEWAY_URL/api/invoices/ingest" \
    -H "Authorization: Bearer $ACCOUNTANT_TOKEN" -F "purchaseOrderId=$po_id" "$@"
}
integrity() {
  local id="$1" hashes="$2"
  docker exec -i -e "INGESTION_ID=$id" -e "EXPECTED_HASHES=$hashes" "$API_CONTAINER" node < infra/invoice/verify-minio.cjs
}
hashes() { jq -nc --arg xml "$(sha256sum "$1" | cut -d ' ' -f1)" '{XML:$xml}'; }
baseline=$(sql 'SELECT count(*) FROM invoices;')
echo 'Testing XML success, exact PostgreSQL persistence and real MinIO integrity...'
code=$(ingest "$work/xml.json" -F "xml=@$work/valid-vn-einvoice.xml;type=application/xml;filename=../../invoice.wrong")
assert_eq "$code" 201 'XML ingestion'
invoice_id=$(jq -er '.invoiceId' "$work/xml.json")
ingestion_id=$(jq -er '.ingestionId' "$work/xml.json")
assert_eq "$(sql "SELECT status || '|' || invoice_id FROM invoice_ingestions WHERE id='$ingestion_id';")" "PARSED|$invoice_id" 'Ingestion link and state'
assert_eq "$(sql "SELECT status || '|' || purchase_order_id || '|' || supplier_id || '|' || invoice_number || '|' || invoice_number_normalized || '|' || currency || '|' || subtotal || '|' || tax_amount || '|' || total_amount || '|' || buyer_tax_code || '|' || source_type FROM invoices WHERE id='$invoice_id';")" "PARSED|$po_id|$supplier_id|INV-001|INV001|VND|201.26|16.12|217.38|0312345678|XML_UPLOAD" 'Header financial strings and binding'
assert_eq "$(sql "SELECT seller_tax_code FROM invoices WHERE id='$invoice_id';")" "0101234567001-$run_id" 'Seller tax code preserved'
assert_eq "$(sql "SELECT external_file_id=(SELECT object_key FROM invoice_files WHERE ingestion_id='$ingestion_id' AND file_kind='XML') FROM invoices WHERE id='$invoice_id';")" t 'Primary XML object key'
assert_eq "$(sql "SELECT string_agg(quantity || '|' || unit_price || '|' || tax_rate || '|' || line_subtotal || '|' || tax_amount || '|' || line_total, ';' ORDER BY line_number) FROM invoice_items WHERE invoice_id='$invoice_id';")" '1.2500|0.8040|0.1000|1.01|0.10|1.11;2.0000|100.1234|0.0800|200.25|16.02|216.27' 'Exact line precision and rounding'
assert_eq "$(sql "SELECT count(*) FROM invoice_items WHERE invoice_id='$invoice_id' AND po_item_id IS NOT NULL;")" 0 'No premature PO line matching'
assert_eq "$(sql "SELECT count(*) FROM audit_records WHERE entity_type='INVOICE' AND entity_id='$invoice_id' AND event_type='INVOICE_PARSED' AND actor_subject IS NOT NULL;")" 1 'Transactional parsed audit'
integrity "$ingestion_id" "$(hashes "$work/valid-vn-einvoice.xml")"

echo 'Testing normalized duplicate and PDF-only fallback...'
code=$(ingest "$work/dup.json" -F "xml=@$work/duplicate-number-variant.xml;type=application/xml")
assert_eq "$code" 409 'Canonical invoice duplicate'
assert_eq "$(jq -r '.errorCode' "$work/dup.json")" DUPLICATE_INVOICE 'Duplicate public code'
code=$(ingest "$work/pdf.json" -F 'pdf=@infra/invoice/fixtures/sample.pdf;type=application/pdf')
assert_eq "$code" 202 'PDF fallback'
pdf_id=$(jq -er '.ingestionId' "$work/pdf.json")
assert_eq "$(sql "SELECT status || '|' || (invoice_id IS NULL)::text FROM invoice_ingestions WHERE id='$pdf_id';")" 'OCR_REQUIRED|true' 'PDF does not fabricate invoice'
assert_eq "$(sql "SELECT processing_status FROM invoice_files WHERE ingestion_id='$pdf_id';")" OCR_REQUIRED 'PDF file fallback state'
assert_eq "$(sql "SELECT count(*) FROM audit_records WHERE entity_id='$pdf_id' AND event_type='INVOICE_OCR_REQUIRED';")" 1 'OCR audit'
integrity "$pdf_id" "$(jq -nc --arg pdf "$(sha256sum infra/invoice/fixtures/sample.pdf | cut -d ' ' -f1)" '{PDF:$pdf}')"

echo 'Testing XML + PDF and concurrent duplicate identity...'
sed 's/INV-001/INV-002/' "$work/valid-vn-einvoice.xml" > "$work/combined.xml"
code=$(ingest "$work/combined.json" -F "xml=@$work/combined.xml;type=application/xml" -F 'pdf=@infra/invoice/fixtures/sample.pdf;type=application/pdf')
assert_eq "$code" 201 'Combined files'
combined_id=$(jq -er '.ingestionId' "$work/combined.json")
assert_eq "$(sql "SELECT string_agg(file_kind || ':' || processing_status, ',' ORDER BY file_kind) FROM invoice_files WHERE ingestion_id='$combined_id';")" 'PDF:STORED,XML:PARSED' 'Combined file states'
integrity "$combined_id" "$(jq -nc --arg xml "$(sha256sum "$work/combined.xml" | cut -d ' ' -f1)" --arg pdf "$(sha256sum infra/invoice/fixtures/sample.pdf | cut -d ' ' -f1)" '{XML:$xml,PDF:$pdf}')"
sed 's/INV-001/INV-003/' "$work/valid-vn-einvoice.xml" > "$work/concurrent.xml"
ingest "$work/concurrent-a.json" -F "xml=@$work/concurrent.xml;type=application/xml" > "$work/code-a" &
pid_a=$!
ingest "$work/concurrent-b.json" -F "xml=@$work/concurrent.xml;type=application/xml" > "$work/code-b" &
pid_b=$!
wait "$pid_a"; wait "$pid_b"
codes=$(printf '%s\n%s\n' "$(cat "$work/code-a")" "$(cat "$work/code-b")" | sort | tr '\n' ' ')
assert_eq "$codes" '201 409 ' 'Concurrent uploads yield one success and one conflict'
assert_eq "$(sql "SELECT count(*) FROM invoices WHERE supplier_id='$supplier_id' AND invoice_number_normalized='INV003';")" 1 'Unique concurrency authority'
echo 'PASS concurrency: one PARSED invoice, one 409 conflict.'

echo 'Testing traceable XML failures, unsafe files and RBAC...'
for pair in 'malformed.xml:MALFORMED_XML' 'unsupported-format.xml:UNSUPPORTED_XML_FORMAT' 'xxe.xml:UNSAFE_XML' 'seller-mismatch.xml:SELLER_TAX_CODE_MISMATCH'; do
  filename=${pair%%:*}; expected=${pair#*:}
  before=$(sql 'SELECT count(*) FROM invoices;')
  code=$(ingest "$work/error.json" -F "xml=@$work/$filename;type=application/xml")
  assert_eq "$code" 422 "$filename response"
  assert_eq "$(jq -r '.errorCode' "$work/error.json")" "$expected" "$filename error code"
  failed_id=$(jq -er '.ingestionId' "$work/error.json")
  assert_eq "$(sql "SELECT status || '|' || error_code || '|' || (invoice_id IS NULL)::text FROM invoice_ingestions WHERE id='$failed_id';")" "FAILED|$expected|true" 'Traceable parse failure'
  assert_eq "$(sql 'SELECT count(*) FROM invoices;')" "$before" 'No partial invoice'
  integrity "$failed_id" "$(hashes "$work/$filename")"
done
printf 'not pdf' > "$work/forged.pdf"
assert_eq "$(ingest "$work/forged.json" -F "pdf=@$work/forged.pdf;type=application/pdf")" 415 'Forged PDF signature'
printf '<xml>\0</xml>' > "$work/binary.xml"
assert_eq "$(ingest "$work/binary.json" -F "xml=@$work/binary.xml;type=application/xml")" 415 'Binary XML'
head -c 5242881 /dev/zero > "$work/oversized.xml"
assert_eq "$(ingest "$work/large-xml.json" -F "xml=@$work/oversized.xml;type=application/xml")" 413 'Oversized XML'
head -c 20971521 /dev/zero > "$work/oversized.pdf"
assert_eq "$(ingest "$work/large-pdf.json" -F "pdf=@$work/oversized.pdf;type=application/pdf")" 413 'Oversized PDF'
code=$(curl -sS --max-time 30 -o "$work/warehouse.json" -w '%{http_code}' "$GATEWAY_URL/api/invoices/ingest" -H "Authorization: Bearer $WAREHOUSE_TOKEN" -F "purchaseOrderId=$po_id" -F "xml=@$work/valid-vn-einvoice.xml;type=application/xml")
assert_eq "$code" 403 'Warehouse upload denied'
code=$(curl -sS --max-time 30 -o "$work/admin.json" -w '%{http_code}' "$GATEWAY_URL/api/invoices/ingest" -H "Authorization: Bearer $ADMIN_TOKEN" -F "purchaseOrderId=$po_id" -F 'pdf=@infra/invoice/fixtures/sample.pdf;type=application/pdf')
assert_eq "$code" 202 'Admin upload allowed'
for path in "invoices?page=1&limit=20&supplierId=$supplier_id" "invoices/$invoice_id" "invoices/$invoice_id/files" "invoice-ingestions/$ingestion_id"; do
  code=$(curl -sS --max-time 30 -o "$work/read.json" -w '%{http_code}' "$GATEWAY_URL/api/$path" -H "Authorization: Bearer $ACCOUNTANT_TOKEN")
  assert_eq "$code" 200 "Authenticated read $path"
done

echo 'Testing structured transaction rollback after header and first line...'
# Test-only trigger scoped to this supplier and line 2. Always removed by EXIT trap.
sql "CREATE FUNCTION invoice_test_rollback() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN
  IF NEW.line_number=2 AND EXISTS (SELECT 1 FROM invoices WHERE id=NEW.invoice_id AND supplier_id='$supplier_id') THEN
    RAISE EXCEPTION 'controlled invoice rollback'; END IF; RETURN NEW; END \$\$;
  CREATE TRIGGER trg_invoice_test_rollback BEFORE INSERT ON invoice_items FOR EACH ROW EXECUTE FUNCTION invoice_test_rollback();" >/dev/null
rollback_trigger=1
sed 's/INV-001/INV-ROLLBACK/' "$work/valid-vn-einvoice.xml" > "$work/rollback.xml"
code=$(ingest "$work/rollback.json" -F "xml=@$work/rollback.xml;type=application/xml")
assert_eq "$code" 503 'Controlled DB failure'
rollback_id=$(jq -er '.ingestionId' "$work/rollback.json")
assert_eq "$(sql "SELECT count(*) FROM invoices WHERE supplier_id='$supplier_id' AND invoice_number='INV-ROLLBACK';")" 0 'Header rollback'
assert_eq "$(sql 'SELECT count(*) FROM invoice_items i LEFT JOIN invoices inv ON inv.id=i.invoice_id WHERE inv.id IS NULL;')" 0 'No orphan lines'
assert_eq "$(sql "SELECT count(*) FROM audit_records WHERE event_type='INVOICE_PARSED' AND metadata->>'ingestionId'='$rollback_id';")" 0 'No false parsed audit'
assert_eq "$(sql "SELECT status || '|' || error_code FROM invoice_ingestions WHERE id='$rollback_id';")" 'FAILED|PERSISTENCE_FAILED' 'Rollback trace retained'
integrity "$rollback_id" "$(hashes "$work/rollback.xml")"
assert_eq "$(sql 'SELECT count(*) FROM invoices;')" "$((baseline + 3))" 'Only three structured invoices persisted'

echo 'Testing verified external Matbao/MIFI PBan 2.0.0 layout through the real gateway...'
# A separate test supplier keeps the external profile's 14-character MST bound.
provider_tax=$(printf '000%010d' "$(( $(date +%s) + RANDOM ))")
provider_supplier=$(sql "INSERT INTO suppliers(supplier_code,tax_code,name) VALUES ('PROVIDER-TEST-$run_id','$provider_tax','Fictional Provider Test Supplier') RETURNING id;")
payload=$(jq -nc --arg supplier "$provider_supplier" '{supplierId:$supplier,currency:"VND",orderDate:"2022-02-14",items:[{description:"External XML test goods",orderedQuantity:"100.0000",unitPrice:"100.1234",taxRate:"0.0800"}]}')
code=$(curl -sS --max-time 30 -o "$work/provider-po.json" -w '%{http_code}' "$GATEWAY_URL/api/purchase-orders" -H "Authorization: Bearer $BUYER_TOKEN" -H 'Content-Type: application/json' -d "$payload")
assert_eq "$code" 201 'Create external-profile PO'
po_id=$(jq -er '.id' "$work/provider-po.json")
version=$(jq -er '.version' "$work/provider-po.json")
code=$(curl -sS --max-time 30 -o "$work/provider-issued.json" -w '%{http_code}' -X POST "$GATEWAY_URL/api/purchase-orders/$po_id/issue" -H "Authorization: Bearer $BUYER_TOKEN" -H 'Content-Type: application/json' -d "{\"expectedVersion\":$version}")
assert_eq "$code" 200 'Issue external-profile PO'
sed "s/0000000000-001/$provider_tax/g" infra/invoice/fixtures/valid-vietnam-provider-einvoice.xml > "$work/provider.xml"
code=$(ingest "$work/provider.json" -F "xml=@$work/provider.xml;type=application/xml;filename=SmartProcureInvoice-v1.xml")
assert_eq "$code" 201 'Verified external XML ingestion'
provider_invoice=$(jq -er '.invoiceId' "$work/provider.json")
provider_ingestion=$(jq -er '.ingestionId' "$work/provider.json")
assert_eq "$(sql "SELECT status || '|' || invoice_id FROM invoice_ingestions WHERE id='$provider_ingestion';")" "PARSED|$provider_invoice" 'External ingestion link/state'
assert_eq "$(sql "SELECT status || '|' || purchase_order_id || '|' || supplier_id || '|' || seller_tax_code || '|' || buyer_tax_code || '|' || invoice_number || '|' || invoice_number_normalized || '|' || invoice_date || '|' || currency || '|' || subtotal || '|' || tax_amount || '|' || total_amount || '|' || source_type FROM invoices WHERE id='$provider_invoice';")" "PARSED|$po_id|$provider_supplier|$provider_tax|0000000001|73|73|2022-02-14|VND|201.26|16.12|217.38|XML_UPLOAD" 'External canonical header and binding'
assert_eq "$(sql "SELECT count(*) FROM invoice_items WHERE invoice_id='$provider_invoice';")" 2 'External two invoice items'
assert_eq "$(sql "SELECT string_agg(quantity || '|' || unit_price || '|' || tax_rate || '|' || line_subtotal || '|' || tax_amount || '|' || line_total, ';' ORDER BY line_number) FROM invoice_items WHERE invoice_id='$provider_invoice';")" '1.2500|0.8040|0.1000|1.01|0.10|1.11;2.0000|100.1234|0.0800|200.25|16.02|216.27' 'External exact line strings'
assert_eq "$(sql "SELECT count(*) FROM invoice_items WHERE invoice_id='$provider_invoice' AND po_item_id IS NOT NULL;")" 0 'External lines remain unresolved'
assert_eq "$(sql "SELECT processing_status FROM invoice_files WHERE ingestion_id='$provider_ingestion';")" PARSED 'External file state'
assert_eq "$(sql "SELECT external_file_id=(SELECT object_key FROM invoice_files WHERE ingestion_id='$provider_ingestion') FROM invoices WHERE id='$provider_invoice';")" t 'External primary XML object key'
assert_eq "$(sql "SELECT count(*) FROM audit_records WHERE entity_type='INVOICE' AND entity_id='$provider_invoice' AND event_type='INVOICE_PARSED' AND actor_subject IS NOT NULL;")" 1 'External parsed audit'
integrity "$provider_ingestion" "$(hashes "$work/provider.xml")"

echo 'Testing external-profile seller mismatch, discount, precision and XXE regressions...'
sed "s/$provider_tax/9999999999/g" "$work/provider.xml" > "$work/provider-mismatch.xml"
sed 's/<STCKhau>0.0000/<STCKhau>1.0000/' "$work/provider.xml" > "$work/provider-discount.xml"
sed 's/<TgTCThue>201.2600/<TgTCThue>201.2601/' "$work/provider.xml" > "$work/provider-precision.xml"
sed 's@<HDon>@<!DOCTYPE HDon [<!ENTITY leak SYSTEM "file:///etc/passwd">]><HDon>@' "$work/provider.xml" > "$work/provider-xxe.xml"
for pair in 'provider-mismatch.xml:SELLER_TAX_CODE_MISMATCH' 'provider-discount.xml:UNSUPPORTED_INVOICE_FEATURE' 'provider-precision.xml:DECIMAL_PRECISION_EXCEEDED' 'provider-xxe.xml:UNSAFE_XML'; do
  filename=${pair%%:*}; expected=${pair#*:}
  code=$(ingest "$work/provider-error.json" -F "xml=@$work/$filename;type=application/xml")
  assert_eq "$code" 422 "$filename response"
  assert_eq "$(jq -r '.errorCode' "$work/provider-error.json")" "$expected" "$filename code"
  failed_id=$(jq -er '.ingestionId' "$work/provider-error.json")
  assert_eq "$(sql "SELECT status || '|' || error_code || '|' || (invoice_id IS NULL)::text FROM invoice_ingestions WHERE id='$failed_id';")" "FAILED|$expected|true" 'External failed ingestion trace'
  integrity "$failed_id" "$(hashes "$work/$filename")"
done
assert_eq "$(sql 'SELECT count(*) FROM invoices;')" "$((baseline + 4))" 'Only four structured invoices, including verified external layout'
echo 'PASS verified external XML profile: exact PostgreSQL entities, NULL po_item_id, SHA-256 readback and private MinIO.'

echo 'PASS real invoice ingestion: PostgreSQL, MinIO, Keycloak and APISIX; rollback and concurrency verified.'
