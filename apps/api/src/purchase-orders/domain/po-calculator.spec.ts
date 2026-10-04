import { POCalculator } from './po-calculator';

describe('POCalculator (Arbitrary Precision Decimal Arithmetic)', () => {
  describe('calculateLine', () => {
    it('calculates standard line subtotal, tax amount, and line total correctly as exact strings', () => {
      const result = POCalculator.calculateLine('10', '150000.00', '0.10');
      expect(result.lineSubtotal).toBe('1500000.00');
      expect(result.taxAmount).toBe('150000.00');
      expect(result.lineTotal).toBe('1650000.00');
    });

    it('handles classic binary float edge case: 10.075 half-up rounds to 10.08 (native JS erroneously gives 10.07)', () => {
      // In IEEE-754: 10.075 is represented as 10.07499999999999928946...
      // Native Math.round(10.075 * 100) / 100 produces 10.07
      // Decimal.js with ROUND_HALF_UP guarantees exact 10.08
      const result = POCalculator.calculateLine('1', '10.075', '0');
      expect(result.lineSubtotal).toBe('10.08');
      expect(result.taxAmount).toBe('0.00');
      expect(result.lineTotal).toBe('10.08');
    });

    it('handles classic binary float edge case: 1.005 half-up rounds to 1.01 (native JS erroneously gives 1.00)', () => {
      // In IEEE-754: 1.005 is represented as 1.00499999999999989342...
      // Native Math.round(1.005 * 100) / 100 produces 1.00
      // Decimal.js with ROUND_HALF_UP guarantees exact 1.01
      const result = POCalculator.calculateLine('1', '1.005', '0');
      expect(result.lineSubtotal).toBe('1.01');
      expect(result.taxAmount).toBe('0.00');
      expect(result.lineTotal).toBe('1.01');
    });

    it('handles fractional quantities with 4-decimal unit price: NUMERIC(18,4)', () => {
      // 2.3333 * 15.5555 = 36.29564815 -> rounds to 36.30
      // 36.30 * 0.0825 (8.25%) = 2.99475 -> rounds to 2.99
      // 36.30 + 2.99 = 39.29
      const result = POCalculator.calculateLine('2.3333', '15.5555', '0.0825');
      expect(result.lineSubtotal).toBe('36.30');
      expect(result.taxAmount).toBe('2.99');
      expect(result.lineTotal).toBe('39.29');
    });

    it('handles 4-decimal tax fraction calculation: 35.00 * 0.0875 = 3.0625 -> 3.06', () => {
      const result = POCalculator.calculateLine('1', '35.00', '0.0875');
      expect(result.lineSubtotal).toBe('35.00');
      expect(result.taxAmount).toBe('3.06');
      expect(result.lineTotal).toBe('38.06');
    });

    it('handles zero tax rate correctly', () => {
      const result = POCalculator.calculateLine('5', '200.50', '0');
      expect(result.lineSubtotal).toBe('1002.50');
      expect(result.taxAmount).toBe('0.00');
      expect(result.lineTotal).toBe('1002.50');
    });

    it('throws when ordered quantity is zero or negative', () => {
      expect(() => POCalculator.calculateLine('0', '100', '0.1')).toThrow('strictly positive');
      expect(() => POCalculator.calculateLine('-1.5', '100', '0.1')).toThrow('strictly positive');
    });

    it('throws when unit price is negative', () => {
      expect(() => POCalculator.calculateLine('10', '-50.25', '0.1')).toThrow('Cannot be negative');
    });

    it('throws when tax rate is negative', () => {
      expect(() => POCalculator.calculateLine('10', '50', '-0.05')).toThrow('Cannot be negative');
    });

    it('throws on invalid non-numeric strings', () => {
      expect(() => POCalculator.calculateLine('abc', '50', '0.1')).toThrow('Not a valid decimal');
      expect(() => POCalculator.calculateLine('10', 'xyz', '0.1')).toThrow('Not a valid decimal');
    });
  });

  describe('calculateTotals', () => {
    it('calculates cumulative totals across multiple line items as exact decimal sum', () => {
      const lines = [
        POCalculator.calculateLine('3', '100.25', '0.10'), // 300.75, tax: 30.08, total: 330.83
        POCalculator.calculateLine('2', '49.50', '0.08'),  //  99.00, tax:  7.92, total: 106.92
      ];

      const totals = POCalculator.calculateTotals(lines);
      // subtotal = 300.75 + 99.00 = 399.75
      // taxAmount = 30.08 + 7.92 = 38.00
      // totalAmount = 399.75 + 38.00 = 437.75
      expect(totals.subtotal).toBe('399.75');
      expect(totals.taxAmount).toBe('38.00');
      expect(totals.totalAmount).toBe('437.75');
    });

    it('proves cumulative sum of rounded lines differs from rounding raw aggregate sum', () => {
      // Line 1: 1 * 1.004 -> rounded lineSubtotal: 1.00, tax 0: 0.00
      // Line 2: 1 * 1.004 -> rounded lineSubtotal: 1.00, tax 0: 0.00
      // Domain rule: PO subtotal = SUM(lineSubtotal) = 1.00 + 1.00 = 2.00
      // (Raw aggregate would be 1.004 + 1.004 = 2.008 -> 2.01)
      const lines = [
        POCalculator.calculateLine('1', '1.004', '0'),
        POCalculator.calculateLine('1', '1.004', '0'),
      ];

      const totals = POCalculator.calculateTotals(lines);
      expect(totals.subtotal).toBe('2.00');
      expect(totals.taxAmount).toBe('0.00');
      expect(totals.totalAmount).toBe('2.00');
    });

    it('returns 0.00 strings when lines array is empty', () => {
      const totals = POCalculator.calculateTotals([]);
      expect(totals.subtotal).toBe('0.00');
      expect(totals.taxAmount).toBe('0.00');
      expect(totals.totalAmount).toBe('0.00');
    });
  });
});
