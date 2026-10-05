import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { CanonicalInvoiceData, InvoiceFile, InvoiceIngestion, PurchaseOrderBinding } from './interfaces/invoice.interface';
import { IngestionError } from './domain/ingestion-error';
import { normalizeInvoiceNumber, normalizeTaxCode } from './domain/normalization';
import { QueryInvoiceDto } from './dto/query-invoice.dto';

const FILE_COLUMNS = `id, ingestion_id AS "ingestionId", file_kind AS "fileKind",
  object_key AS "objectKey", original_filename AS "originalFilename", media_type AS "mediaType",
  size_bytes::text AS "sizeBytes", sha256, processing_status AS "processingStatus",
  parse_error_code AS "parseErrorCode", parse_error_message AS "parseErrorMessage", created_at AS "createdAt"`;
const INGESTION_COLUMNS = `id, purchase_order_id AS "purchaseOrderId", supplier_id AS "supplierId",
  invoice_id AS "invoiceId", status, error_code AS "errorCode", error_message AS "errorMessage",
  created_by_subject AS "createdBySubject", created_at AS "createdAt", updated_at AS "updatedAt"`;
const INVOICE_COLUMNS = `id, invoice_number AS "invoiceNumber", invoice_number_normalized AS "invoiceNumberNormalized",
  supplier_id AS "supplierId", purchase_order_id AS "purchaseOrderId", to_char(invoice_date, 'YYYY-MM-DD') AS "invoiceDate",
  currency, status, subtotal::text AS subtotal, tax_amount::text AS "taxAmount", total_amount::text AS "totalAmount",
  seller_tax_code AS "sellerTaxCode", buyer_tax_code AS "buyerTaxCode", external_file_id AS "externalFileId",
  source_type AS "sourceType", created_at AS "createdAt", updated_at AS "updatedAt"`;

@Injectable()
export class InvoicesRepository {
  constructor(private readonly db: DatabaseService) {}

  private async audit(client: PoolClient, type: string, id: string, event: string, subject: string, metadata: unknown) {
    await client.query(`INSERT INTO audit_records(entity_type, entity_id, event_type, actor_subject, metadata)
      VALUES ($1,$2,$3,$4,$5::jsonb)`, [type, id, event, subject, JSON.stringify(metadata)]);
  }
  private async binding(client: PoolClient, id: string): Promise<PurchaseOrderBinding> {
    const result = await client.query<PurchaseOrderBinding>(`SELECT p.id, p.status, p.supplier_id AS "supplierId",
      s.tax_code AS "taxCode", s.status AS "supplierStatus" FROM purchase_orders p
      JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = $1 FOR SHARE OF p, s`, [id]);
    const binding = result.rows[0];
    if (!binding) throw new IngestionError('PURCHASE_ORDER_NOT_FOUND', 'Purchase order and supplier must exist.', 404);
    if (!['ISSUED', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED'].includes(binding.status)) {
      throw new IngestionError('INVALID_PURCHASE_ORDER_STATE', 'Purchase order must be issued or received.', 422);
    }
    return binding;
  }

  async start(id: string, poId: string, files: InvoiceFile[], subject: string): Promise<PurchaseOrderBinding> {
    return this.db.transaction(async client => {
      const binding = await this.binding(client, poId);
      await client.query(`INSERT INTO invoice_ingestions(id, purchase_order_id, supplier_id, created_by_subject)
        VALUES ($1,$2,$3,$4)`, [id, poId, binding.supplierId, subject]);
      // Persist keys before external I/O: a crash can never leave an unknown object.
      for (const file of files) {
        await client.query(`INSERT INTO invoice_files(id, ingestion_id, file_kind, object_key, original_filename,
          media_type, size_bytes, sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [file.id, id, file.fileKind, file.objectKey, file.originalFilename, file.mediaType, file.sizeBytes, file.sha256]);
      }
      await this.audit(client, 'INVOICE_INGESTION', id, 'INVOICE_INGESTION_STARTED', subject,
        { purchaseOrderId: poId, supplierId: binding.supplierId, fileIds: files.map(f => f.id) });
      return binding;
    });
  }
  async fileStored(file: InvoiceFile, subject: string): Promise<void> {
    await this.db.transaction(async client => {
      await client.query(`UPDATE invoice_files SET processing_status = 'STORED'
        WHERE id = $1 AND processing_status = 'PENDING_UPLOAD'`, [file.id]);
      await this.audit(client, 'INVOICE_INGESTION', file.ingestionId, 'INVOICE_FILE_STORED', subject,
        { fileId: file.id, sha256: file.sha256, sizeBytes: file.sizeBytes });
    });
  }
  async stored(id: string): Promise<void> {
    await this.db.query(`UPDATE invoice_ingestions SET status = 'STORED' WHERE id = $1 AND status = 'PENDING_UPLOAD'`, [id]);
  }
  async ocrRequired(id: string, subject: string): Promise<void> {
    await this.db.transaction(async client => {
      await client.query(`UPDATE invoice_ingestions SET status='OCR_REQUIRED', error_code='NOT_CONFIGURED',
        error_message='OCR provider is not configured.' WHERE id=$1 AND status='STORED'`, [id]);
      await client.query(`UPDATE invoice_files SET processing_status='OCR_REQUIRED' WHERE ingestion_id=$1`, [id]);
      await this.audit(client, 'INVOICE_INGESTION', id, 'INVOICE_OCR_REQUIRED', subject, { reason: 'NOT_CONFIGURED' });
    });
  }
  async fail(id: string, error: IngestionError, subject: string): Promise<void> {
    const message = (error.getResponse() as { message: string }).message;
    await this.db.transaction(async client => {
      await client.query(`UPDATE invoice_ingestions SET status='FAILED', error_code=$2, error_message=$3
        WHERE id=$1 AND invoice_id IS NULL`, [id, error.errorCode, message]);
      await client.query(`UPDATE invoice_files SET processing_status='FAILED', parse_error_code=$2, parse_error_message=$3
        WHERE ingestion_id=$1 AND processing_status != 'PARSED'`, [id, error.errorCode, message]);
      await this.audit(client, 'INVOICE_INGESTION', id, 'INVOICE_INGESTION_FAILED', subject, { errorCode: error.errorCode });
    });
  }
  async persist(id: string, poId: string, supplierId: string, data: CanonicalInvoiceData,
    normalized: string, files: InvoiceFile[], subject: string): Promise<string> {
    try {
      return await this.db.transaction(async client => {
        const binding = await this.binding(client, poId);
        if (binding.supplierId !== supplierId || !normalizeTaxCode(binding.taxCode) ||
            normalizeTaxCode(binding.taxCode) !== normalizeTaxCode(data.sellerTaxCode)) {
          throw new IngestionError('SELLER_TAX_CODE_MISMATCH', 'XML seller tax code does not match the PO supplier.');
        }
        // Legacy rows retain NULL identities: compare them without rewriting historic data.
        const existing = await client.query<{ invoice_number: string }>(`SELECT invoice_number FROM invoices
          WHERE supplier_id=$1 AND (invoice_number_normalized=$2 OR invoice_number_normalized IS NULL)`, [supplierId, normalized]);
        if (existing.rows.some(row => {
          try { return normalizeInvoiceNumber(row.invoice_number) === normalized; } catch { return false; }
        })) throw new IngestionError('DUPLICATE_INVOICE', 'An invoice with this supplier and normalized number already exists.', 409);
        const xml = files.find(f => f.fileKind === 'XML');
        const inserted = await client.query<{ id: string }>(`INSERT INTO invoices(invoice_number, invoice_number_normalized,
          supplier_id, purchase_order_id, invoice_date, currency, status, subtotal, tax_amount, total_amount,
          seller_tax_code, buyer_tax_code, external_file_id, source_type)
          VALUES ($1,$2,$3,$4,$5,$6,'PARSED',$7,$8,$9,$10,$11,$12,'XML_UPLOAD') RETURNING id`,
        [data.invoiceNumber, normalized, supplierId, poId, data.invoiceDate, data.currency, data.subtotal,
          data.taxAmount, data.totalAmount, data.sellerTaxCode, data.buyerTaxCode, xml.objectKey]);
        const invoiceId = inserted.rows[0].id;
        for (const [index, line] of data.items.entries()) {
          await client.query(`INSERT INTO invoice_items(invoice_id, line_number, po_item_id, sku, description,
            quantity, unit_price, tax_rate, line_subtotal, tax_amount, line_total)
            VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10)`, [invoiceId, index + 1, line.sku || null,
            line.description, line.quantity, line.unitPrice, line.taxRate, line.lineSubtotal, line.taxAmount, line.lineTotal]);
        }
        await client.query(`UPDATE invoice_ingestions SET status='PARSED', invoice_id=$2 WHERE id=$1`, [id, invoiceId]);
        await client.query(`UPDATE invoice_files SET processing_status=CASE WHEN file_kind='XML' THEN 'PARSED' ELSE 'STORED' END
          WHERE ingestion_id=$1`, [id]);
        await this.audit(client, 'INVOICE', invoiceId, 'INVOICE_PARSED', subject, {
          purchaseOrderId: poId, supplierId, ingestionId: id, invoiceNumber: data.invoiceNumber,
          invoiceNumberNormalized: normalized, sourceType: 'XML_UPLOAD',
          files: files.map(f => ({ id: f.id, sha256: f.sha256 })), lineCount: data.items.length,
          subtotal: data.subtotal, taxAmount: data.taxAmount, totalAmount: data.totalAmount,
        });
        return invoiceId;
      });
    } catch (error) {
      if (error.code === '23505' && ['uq_invoice_supplier_normalized', 'uq_supplier_invoice'].includes(error.constraint)) {
        throw new IngestionError('DUPLICATE_INVOICE', 'An invoice with this supplier and normalized number already exists.', 409);
      }
      throw error;
    }
  }

  async ingestion(id: string): Promise<InvoiceIngestion> {
    const result = await this.db.query<InvoiceIngestion>(`SELECT ${INGESTION_COLUMNS} FROM invoice_ingestions WHERE id=$1`, [id]);
    if (!result.rows[0]) throw new IngestionError('INGESTION_NOT_FOUND', 'Invoice ingestion not found.', 404);
    result.rows[0].files = (await this.db.query<InvoiceFile>(`SELECT ${FILE_COLUMNS} FROM invoice_files WHERE ingestion_id=$1 ORDER BY created_at, id`, [id])).rows;
    return result.rows[0];
  }
  async invoice(id: string) {
    const result = await this.db.query(`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE id=$1`, [id]);
    if (!result.rows[0]) throw new IngestionError('INVOICE_NOT_FOUND', 'Invoice not found.', 404);
    result.rows[0].items = (await this.db.query(`SELECT id, invoice_id AS "invoiceId", line_number AS "lineNumber",
      po_item_id AS "poItemId", sku, description, quantity::text AS quantity, unit_price::text AS "unitPrice",
      tax_rate::text AS "taxRate", line_subtotal::text AS "lineSubtotal", tax_amount::text AS "taxAmount",
      line_total::text AS "lineTotal" FROM invoice_items WHERE invoice_id=$1 ORDER BY line_number`, [id])).rows;
    return result.rows[0];
  }
  async files(id: string) {
    await this.invoice(id);
    return (await this.db.query<InvoiceFile>(`SELECT ${FILE_COLUMNS} FROM invoice_files WHERE ingestion_id IN
      (SELECT id FROM invoice_ingestions WHERE invoice_id=$1) ORDER BY created_at, id`, [id])).rows;
  }
  async list(query: QueryInvoiceDto) {
    const params: unknown[] = [], clauses: string[] = [];
    for (const [field, value] of [['status', query.status], ['supplier_id', query.supplierId],
      ['purchase_order_id', query.purchaseOrderId], ['invoice_number', query.invoiceNumber]]) {
      if (value !== undefined) { params.push(value); clauses.push(`${field}=$${params.length}`); }
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const count = await this.db.query<{ total: string }>(`SELECT count(*)::text AS total FROM invoices ${where}`, params);
    params.push(query.limit, (query.page - 1) * query.limit);
    const result = await this.db.query(`SELECT ${INVOICE_COLUMNS} FROM invoices ${where}
      ORDER BY created_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { data: result.rows, page: query.page, limit: query.limit, total: Number(count.rows[0].total) };
  }
}
