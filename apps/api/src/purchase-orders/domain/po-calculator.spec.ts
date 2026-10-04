import { POCalculator } from './po-calculator';

describe('POCalculator', () => {
  describe('calculateLine', () => {
    it('calculates line subtotal, tax amount, and line total correctly', () => {
      const result = POCalculator.calculateLine(10, 150000, 0.1);
      expect(result.lineSubtotal).toBe(1500000);
      expect(result.taxAmount).toBe(150000);
      expect(result.lineTotal).toBe(1650000);
    });

    it('handles decimal quantities and fractional unit prices with half-up rounding', () => {
      const result = POCalculator.calculateLine(3.3333, 10.5, 0.08);
      // 3.3333 * 10.5 = 34.99965 -> round to 35.00
      expect(result.lineSubtotal).toBe(35);
      // 35.00 * 0.08 = 2.80
      expect(result.taxAmount).toBe(2.8);
      // 35.00 + 2.80 = 37.80
      expect(result.lineTotal).toBe(37.8);
    });

    it('handles zero tax rate correctly', () => {
      const result = POCalculator.calculateLine(5, 200, 0);
      expect(result.lineSubtotal).toBe(1000);
      expect(result.taxAmount).toBe(0);
      expect(result.lineTotal).toBe(1000);
    });

    it('throws when ordered quantity is zero or negative', () => {
      expect(() => POCalculator.calculateLine(0, 100, 0.1)).toThrow('strictly positive');
      expect(() => POCalculator.calculateLine(-1, 100, 0.1)).toThrow('strictly positive');
    });

    it('throws when unit price is negative', () => {
      expect(() => POCalculator.calculateLine(10, -50, 0.1)).toThrow('Cannot be negative');
    });

    it('throws when tax rate is negative', () => {
      expect(() => POCalculator.calculateLine(10, 50, -0.05)).toThrow('Cannot be negative');
    });
  });

  describe('calculateTotals', () => {
    it('calculates cumulative totals across multiple line items', () => {
      const lines = [
        POCalculator.calculateLine(10, 100, 0.1), // sub: 1000, tax: 100, total: 1100
        POCalculator.calculateLine(5, 50, 0.08),  // sub: 250, tax: 20, total: 270
      ];

      const totals = POCalculator.calculateTotals(lines);
      expect(totals.subtotal).toBe(1250);
      expect(totals.taxAmount).toBe(120);
      expect(totals.totalAmount).toBe(1370);
    });

    it('returns zero totals when items array is empty', () => {
      const totals = POCalculator.calculateTotals([]);
      expect(totals.subtotal).toBe(0);
      expect(totals.taxAmount).toBe(0);
      expect(totals.totalAmount).toBe(0);
    });
  });
});
