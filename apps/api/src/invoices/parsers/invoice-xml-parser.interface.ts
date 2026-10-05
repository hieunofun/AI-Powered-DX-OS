import { CanonicalInvoiceData } from '../interfaces/invoice.interface';

export interface InvoiceXmlParser {
  readonly profile: string;
  supports(document: Record<string, unknown>): boolean;
  parse(document: Record<string, unknown>): CanonicalInvoiceData;
}
