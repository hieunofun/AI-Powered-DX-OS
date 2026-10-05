import { IngestionError } from './ingestion-error';

export function normalizeInvoiceNumber(value: string): string {
  const normalized = value.normalize('NFKC').trim().toUpperCase().replace(/[\s_-]/gu, '');
  if (!normalized || normalized.length > 100) {
    throw new IngestionError('INVALID_INVOICE_NUMBER', 'Invoice number must have a nonempty identity of at most 100 characters.');
  }
  return normalized;
}

export function normalizeTaxCode(value: string): string {
  return value.normalize('NFKC').trim().toUpperCase().replace(/[\s-]/gu, '');
}
