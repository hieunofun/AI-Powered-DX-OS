import { expect, test } from '@playwright/test';
import { decimal, percentage, quantityDifference, units, validDecimal } from '../src/procurement/decimal';

test('preserves financial digits beyond Number.MAX_SAFE_INTEGER in display', () => {
  expect(decimal('99999999999999.9999')).toBe('99.999.999.999.999,9999');
  expect(decimal('1234.0100')).toBe('1.234,01');
  expect(decimal('0.0000')).toBe('0');
});
test('subtracts fractional receipts exactly and exposes over-delivery', () => {
  expect(quantityDifference('0.3', '0.1')).toBe('0.2000');
  expect(quantityDifference('10', '10.0001')).toBe('-0.0001');
  expect(quantityDifference('99999999999999.9999', '0.0001')).toBe('99999999999999.9998');
  expect(units('0.1') + units('0.2')).toBe(units('0.3'));
});
test('validates precision and positivity without numeric coercion', () => {
  for (const invalid of ['', '-1', '+1', '1e3', '1,5', ' 1', '1.00001', '100000000000000']) expect(validDecimal(invalid)).toBe(false);
  expect(validDecimal('0', true)).toBe(false);
  expect(validDecimal('000.0001', true)).toBe(true);
  expect(validDecimal('99999999999999.9999', true)).toBe(true);
  expect(validDecimal('1000', false, 3)).toBe(false);
  expect(() => units('1e3')).toThrow();
});
test('formats fractional tax rates exactly', () => {
  expect(percentage('0.1000')).toBe('10%');
  expect(percentage('0.0855')).toBe('8,55%');
});
