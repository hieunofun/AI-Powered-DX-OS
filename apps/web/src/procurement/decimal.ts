/** Quantity arithmetic uses the API's four-place fixed scale, never IEEE-754 numbers. */
export function units(value: string): bigint {
  if (!/^\d+(\.\d{1,4})?$/.test(value)) throw new Error('Invalid quantity');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0'));
}

export function quantityDifference(ordered: string, accepted: string): string {
  const difference = units(ordered) - units(accepted);
  const absolute = difference < 0n ? -difference : difference;
  return `${difference < 0n ? '-' : ''}${absolute / 10000n}.${String(absolute % 10000n).padStart(4, '0')}`;
}

/** Display all significant decimal digits; money comes from server-computed totals. */
export function decimal(value: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return '—';
  const [whole, fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (trimmed ? `,${trimmed}` : '');
}

export function percentage(rate: string): string {
  const scaled = units(rate) * 100n;
  return `${decimal(`${scaled / 10000n}.${String(scaled % 10000n).padStart(4, '0')}`)}%`;
}

export function validDecimal(value: string, positive = false, integerDigits = 14): boolean {
  if (!/^\d+(\.\d{1,4})?$/.test(value)) return false;
  const integer = value.split('.')[0].replace(/^0+/, '') || '0';
  return integer.length <= integerDigits && (!positive || units(value) > 0n);
}
