/** Preserve punctuation and internal word boundaries; never use locale/fuzzy comparison. */
export function normalizeSku(value: string): string {
  return value.normalize('NFKC').trim().toUpperCase().replace(/\s+/gu, ' ');
}
export function normalizeDescription(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toUpperCase();
}
