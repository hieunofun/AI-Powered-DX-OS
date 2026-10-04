/**
 * Financial calculation helper for Purchase Order line items and aggregate totals.
 * Ensures numerical stability and exact rounding conforming to PostgreSQL NUMERIC(18,2).
 */

export interface CalculatedLineItem {
  lineSubtotal: number;
  taxAmount: number;
  lineTotal: number;
}

export interface CalculatedOrderTotals {
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
}

export class POCalculator {
  /**
   * Rounds a number to a specified number of decimal places using half-up rounding.
   * Mitigates standard IEEE 754 binary floating-point representation anomalies.
   */
  static round(value: number, decimals = 2): number {
    const factor = Math.pow(10, decimals);
    return Math.round((value + Number.EPSILON) * factor) / factor;
  }

  /**
   * Calculates financial totals for an individual line item.
   *
   * Formula:
   *   lineSubtotal = round(orderedQuantity * unitPrice, 2)
   *   taxAmount    = round(lineSubtotal * taxRate, 2)
   *   lineTotal    = round(lineSubtotal + taxAmount, 2)
   */
  static calculateLine(
    orderedQuantity: number,
    unitPrice: number,
    taxRate: number,
  ): CalculatedLineItem {
    if (orderedQuantity <= 0) {
      throw new Error(`Invalid orderedQuantity: ${orderedQuantity}. Must be strictly positive.`);
    }
    if (unitPrice < 0) {
      throw new Error(`Invalid unitPrice: ${unitPrice}. Cannot be negative.`);
    }
    if (taxRate < 0) {
      throw new Error(`Invalid taxRate: ${taxRate}. Cannot be negative.`);
    }

    const rawSubtotal = orderedQuantity * unitPrice;
    const lineSubtotal = this.round(rawSubtotal, 2);

    const rawTax = lineSubtotal * taxRate;
    const taxAmount = this.round(rawTax, 2);

    const lineTotal = this.round(lineSubtotal + taxAmount, 2);

    return {
      lineSubtotal,
      taxAmount,
      lineTotal,
    };
  }

  /**
   * Calculates cumulative financial totals across all line items of a Purchase Order.
   */
  static calculateTotals(
    lines: { lineSubtotal: number; taxAmount: number; lineTotal: number }[],
  ): CalculatedOrderTotals {
    if (!lines || lines.length === 0) {
      return { subtotal: 0, taxAmount: 0, totalAmount: 0 };
    }

    let subtotalAcc = 0;
    let taxAcc = 0;
    let totalAcc = 0;

    for (const line of lines) {
      subtotalAcc += line.lineSubtotal;
      taxAcc += line.taxAmount;
      totalAcc += line.lineTotal;
    }

    return {
      subtotal: this.round(subtotalAcc, 2),
      taxAmount: this.round(taxAcc, 2),
      totalAmount: this.round(totalAcc, 2),
    };
  }
}
