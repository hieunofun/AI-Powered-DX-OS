import { InvoiceLine, PoLine } from '../interfaces/matching.interface';
import { DiscrepancyCode } from './discrepancy-codes';
import { normalizeDescription, normalizeSku } from './normalization';

export class ItemResolver {
  private readonly ids = new Map<string, PoLine>();
  private readonly skus = new Map<string, PoLine[]>();
  private readonly descriptions = new Map<string, PoLine[]>();
  constructor(items: readonly PoLine[], private readonly poId: string) {
    for (const item of items) {
      if (item.purchaseOrderId !== poId) throw new Error('Invalid PO item ownership');
      this.ids.set(item.id, item);
      if (item.sku !== null) this.add(this.skus, normalizeSku(item.sku), item);
      this.add(this.descriptions, normalizeDescription(item.description), item);
    }
  }
  private add(index: Map<string, PoLine[]>, key: string, item: PoLine) {
    const matches = index.get(key) ?? [];
    matches.push(item);
    index.set(key, matches);
  }
  resolve(line: InvoiceLine): { item: PoLine | null; codes: DiscrepancyCode[]; method: string } {
    if (line.poItemId !== null) {
      const item = this.ids.get(line.poItemId);
      if (!item) throw new Error('Invalid existing invoice PO item ownership');
      return { item, codes: [], method: 'EXISTING_REFERENCE' };
    }
    const hasSku = line.sku !== null && normalizeSku(line.sku) !== '';
    const matches = hasSku ? this.skus.get(normalizeSku(line.sku)) : this.descriptions.get(normalizeDescription(line.description));
    if (!matches?.length) return { item: null, codes: ['UNRECOGNIZED_ITEM'], method: hasSku ? 'SKU' : 'DESCRIPTION' };
    if (matches.length > 1) return { item: null, codes: ['AMBIGUOUS_ITEM'], method: hasSku ? 'SKU' : 'DESCRIPTION' };
    const item = matches[0];
    const codes: DiscrepancyCode[] = hasSku && normalizeDescription(line.description) !== normalizeDescription(item.description)
      ? ['ITEM_DESCRIPTION_MISMATCH'] : [];
    return { item, codes, method: hasSku ? 'SKU' : 'DESCRIPTION' };
  }
}
