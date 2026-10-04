import Decimal from 'decimal.js';

// Configure Decimal globally for standard accounting/business half-up rounding
Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

export interface CalculatedLineItem {
  lineSubtotal: string;
  taxAmount: string;
  lineTotal: string;
}

export interface CalculatedOrderTotals {
  subtotal: string;
  taxAmount: string;
  totalAmount: string;
}

/**
 * Arbitrary-precision financial calculator for Purchase Order line items and aggregate totals.
 * Implements strict decimal arithmetic via Decimal.js conforming to PostgreSQL NUMERIC constraints.
 * Eliminates all binary floating-point representation anomalies.
 */
export class POCalculator {
  /**
   * Rounds a Decimal or numeric string to fixed decimal places using ROUND_HALF_UP.
   */
  static round(value: Decimal.Value, decimalPlaces = 2): string {
    return new Decimal(value).toFixed(decimalPlaces, Decimal.ROUND_HALF_UP);
  }

  /**
   * Calculates financial totals for an individual line item.
   *
   * Formulas:
   *   lineSubtotal = ROUND(orderedQuantity * unitPrice, 2)
   *   taxAmount    = ROUND(lineSubtotal * taxRate, 2)
   *   lineTotal    = lineSubtotal + taxAmount
   *
   * @param orderedQuantity NUMERIC(18,4) strictly positive
   * @param unitPrice       NUMERIC(18,4) non-negative
   * @param taxRate         NUMERIC(7,4)  non-negative decimal fraction (e.g. 0.08 = 8%)
   */
  static calculateLine(
    orderedQuantity: Decimal.Value,
    unitPrice: Decimal.Value,
    taxRate: Decimal.Value = 0,
  ): CalculatedLineItem {
    let qty: Decimal;
    let price: Decimal;
    let tax: Decimal;

    try {
      qty = new Decimal(orderedQuantity);
    } catch {
      throw new Error(`Invalid orderedQuantity '${orderedQuantity}': Not a valid decimal number`);
    }

    try {
      price = new Decimal(unitPrice);
    } catch {
      throw new Error(`Invalid unitPrice '${unitPrice}': Not a valid decimal number`);
    }

    try {
      tax = new Decimal(taxRate);
    } catch {
      throw new Error(`Invalid taxRate '${taxRate}': Not a valid decimal number`);
    }

    if (qty.lte(0)) {
      throw new Error(`Invalid orderedQuantity: ${qty.toString()}. Must be strictly positive.`);
    }
    if (price.lt(0)) {
      throw new Error(`Invalid unitPrice: ${price.toString()}. Cannot be negative.`);
    }
    if (tax.lt(0)) {
      throw new Error(`Invalid taxRate: ${tax.toString()}. Cannot be negative.`);
    }

    // lineSubtotal = ROUND(orderedQuantity * unitPrice, 2)
    const rawSubtotal = qty.times(price);
    const lineSubtotalDec = new Decimal(rawSubtotal.toFixed(2, Decimal.ROUND_HALF_UP));

    // taxAmount = ROUND(lineSubtotal * taxRate, 2)
    const rawTax = lineSubtotalDec.times(tax);
    const taxAmountDec = new Decimal(rawTax.toFixed(2, Decimal.ROUND_HALF_UP));

    // lineTotal = lineSubtotal + taxAmount
    const lineTotalDec = lineSubtotalDec.plus(taxAmountDec);

    return {
      lineSubtotal: lineSubtotalDec.toFixed(2),
      taxAmount: taxAmountDec.toFixed(2),
      lineTotal: lineTotalDec.toFixed(2),
    };
  }

  /**
   * Calculates cumulative financial totals across all line items of a Purchase Order.
   *
   * Formulas:
   *   PO subtotal    = SUM(lineSubtotal)
   *   PO taxAmount   = SUM(line taxAmount)
   *   PO totalAmount = subtotal + taxAmount
   */
  static calculateTotals(
    lines: Array<{ lineSubtotal: Decimal.Value; taxAmount: Decimal.Value }>,
  ): CalculatedOrderTotals {
    if (lines.length === 0) {
      return {
        subtotal: '0.00',
        taxAmount: '0.00',
        totalAmount: '0.00',
      };
    }

    let subtotalDec = new Decimal(0);
    let taxAmountDec = new Decimal(0);

    for (const line of lines) {
      subtotalDec = subtotalDec.plus(new Decimal(line.lineSubtotal));
      taxAmountDec = taxAmountDec.plus(new Decimal(line.taxAmount));
    }

    const totalAmountDec = subtotalDec.plus(taxAmountDec);

    return {
      subtotal: subtotalDec.toFixed(2),
      taxAmount: taxAmountDec.toFixed(2),
      totalAmount: totalAmountDec.toFixed(2),
    };
  }
}
