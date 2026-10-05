/** The declaration order is also the public, stable discrepancy priority. */
export const DISCREPANCY_CODES = [
  'SUPPLIER_MISMATCH', 'SELLER_TAX_CODE_MISSING', 'SELLER_TAX_CODE_MISMATCH',
  'CURRENCY_MISMATCH', 'UNRECOGNIZED_ITEM', 'AMBIGUOUS_ITEM',
  'ITEM_DESCRIPTION_MISMATCH', 'MISSING_GRN', 'QUANTITY_MISMATCH',
  'PRICE_MISMATCH', 'TAX_MISMATCH', 'TOTAL_MISMATCH',
] as const;
export type DiscrepancyCode = typeof DISCREPANCY_CODES[number];
export function orderedCodes(codes: readonly DiscrepancyCode[]): DiscrepancyCode[] {
  const set = new Set(codes);
  return DISCREPANCY_CODES.filter(code => set.has(code));
}
