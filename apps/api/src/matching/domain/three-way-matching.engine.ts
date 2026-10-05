import { MatchingInput, InvoiceLine } from '../interfaces/matching.interface';
import { normalizeTaxCode } from '../../invoices/domain/normalization';
import { DiscrepancyCode, orderedCodes } from './discrepancy-codes';
import { ItemResolver } from './item-resolver';
import { D, acceptedQuantities, consumedQuantities } from './quantities';
import { RULE_VERSION, snapshotPolicy } from './matching-policy';

function comparison(actual: string, expected: string, tolerance: string) {
  const a = new D(actual), e = new D(expected), numerator = a.minus(e).abs().times(100);
  return {
    withinTolerance: e.isZero() ? a.isZero() : numerator.lte(e.times(tolerance)),
    signedVariance: a.minus(e).toString(),
    variancePercent: e.isZero() ? (a.isZero() ? '0' : null) : numerator.div(e).toString(),
    // Rational components preserve exact evidence for non-terminating percentages.
    percentNumerator: numerator.toString(), percentDenominator: e.toString(),
  };
}

export function evaluateMatching(input: MatchingInput) {
  if (!input.invoiceItems.length) throw new Error('Invoice requires structured lines');
  // PostgreSQL NUMERIC can represent NaN in legacy/manual rows; never let it bypass comparisons.
  const numericValues = [input.invoice.subtotal, input.invoice.taxAmount, input.invoice.totalAmount,
    input.policy.quantityTolerancePercent, input.policy.priceTolerancePercent,
    input.policy.taxTolerancePercent, input.policy.totalTolerancePercent,
    ...input.invoiceItems.flatMap(line => [line.quantity, line.unitPrice, line.taxRate, line.lineSubtotal, line.taxAmount, line.lineTotal]),
    ...input.poItems.flatMap(line => [line.orderedQuantity, line.unitPrice, line.taxRate]),
    ...input.receipts.map(row => row.acceptedQuantity), ...input.previousInvoices.map(row => row.quantity)];
  for (const value of numericValues) {
    if (typeof value !== 'string' || !new D(value).isFinite() || new D(value).lt(0)) {
      throw new Error('Matching requires finite nonnegative decimal strings');
    }
  }
  const { invoice, po, policy } = input;
  const documentCodes: DiscrepancyCode[] = [];
  const sameSupplier = invoice.supplierId === po.supplierId;
  if (!sameSupplier) documentCodes.push('SUPPLIER_MISMATCH');
  const invoiceTax = normalizeTaxCode(invoice.sellerTaxCode ?? '');
  const sameTax = invoiceTax !== '' && invoiceTax === normalizeTaxCode(input.supplierTaxCode);
  if (!invoiceTax) documentCodes.push('SELLER_TAX_CODE_MISSING');
  else if (!sameTax) documentCodes.push('SELLER_TAX_CODE_MISMATCH');
  const currencyMatch = invoice.currency === po.currency;
  if (!currencyMatch) documentCodes.push('CURRENCY_MISMATCH');

  const subtotal = input.invoiceItems.reduce((sum, line) => sum.plus(line.lineSubtotal), new D(0));
  const tax = input.invoiceItems.reduce((sum, line) => sum.plus(line.taxAmount), new D(0));
  const total = input.invoiceItems.reduce((sum, line) => sum.plus(line.lineTotal), new D(0));
  const totalChecks = {
    subtotal: comparison(invoice.subtotal, subtotal.toString(), policy.totalTolerancePercent),
    taxAmount: comparison(invoice.taxAmount, tax.toString(), policy.totalTolerancePercent),
    totalAmount: comparison(invoice.totalAmount, total.toString(), policy.totalTolerancePercent),
    headerConservation: comparison(invoice.totalAmount, new D(invoice.subtotal).plus(invoice.taxAmount).toString(), policy.totalTolerancePercent),
  };
  if (Object.values(totalChecks).some(check => !check.withinTolerance)) documentCodes.push('TOTAL_MISMATCH');

  const resolver = new ItemResolver(input.poItems, po.id);
  const received = acceptedQuantities(input.receipts);
  const consumed = consumedQuantities(input.previousInvoices, invoice.id);
  const sorted = [...input.invoiceItems].sort((a, b) => a.lineNumber - b.lineNumber);
  const resolutions = sorted.map(line => resolver.resolve(line));
  const groups = new Map<string, { aggregate: InstanceType<typeof D>; remaining: InstanceType<typeof D>;
    details: Record<string, string>; missing: boolean; excess: boolean }>();
  for (const [index, line] of sorted.entries()) {
    const item = resolutions[index].item;
    if (!item) continue;
    if (!groups.has(item.id)) {
      const accepted = new D(received.get(item.id) ?? 0), previous = new D(consumed.get(item.id) ?? 0);
      const poAllowed = new D(item.orderedQuantity).times(new D(1).plus(new D(policy.quantityTolerancePercent).div(100)));
      const receivedAvailable = accepted.minus(previous), poAvailable = poAllowed.minus(previous);
      const available = D.max(0, D.min(receivedAvailable, poAvailable));
      groups.set(item.id, { aggregate: new D(0), remaining: available,
        missing: accepted.isZero(), excess: false, details: {
          orderedQuantity: item.orderedQuantity, cumulativeAcceptedReceived: accepted.toString(),
          previousValidInvoicedQuantity: previous.toString(), quantityTolerancePercent: policy.quantityTolerancePercent,
          poAllowed: poAllowed.toString(), receivedAvailable: receivedAvailable.toString(),
          poAvailable: poAvailable.toString(), availableToInvoice: available.toString(),
        } });
    }
    const group = groups.get(item.id);
    group.aggregate = group.aggregate.plus(line.quantity);
  }
  for (const group of groups.values()) {
    group.excess = group.aggregate.gt(group.remaining);
    group.details.invoiceAggregateQuantity = group.aggregate.toString();
  }
  const items = sorted.map((line: InvoiceLine, index) => {
    const resolution = resolutions[index], item = resolution.item;
    const codes = [...documentCodes, ...resolution.codes];
    let allocated = new D(0), unitVariance = new D(0), taxRateVariance = new D(0), lineTotalVariance = new D(0);
    let expectedTaxVariance = new D(0);
    const details: Record<string, unknown> = { resolutionMethod: resolution.method, invoiceLineNumber: line.lineNumber,
      invoiceSku: line.sku, invoiceDescription: line.description, invoiceQuantity: line.quantity,
      documentRules: { invoiceSupplierId: invoice.supplierId, poSupplierId: po.supplierId,
        sellerTaxCodeNormalized: invoiceTax, supplierTaxCodeNormalized: normalizeTaxCode(input.supplierTaxCode),
        invoiceCurrency: invoice.currency, poCurrency: po.currency }, totalChecks };
    if (item) {
      const group = groups.get(item.id);
      details.poSku = item.sku;
      details.poDescription = item.description;
      // Downward quantization prevents NUMERIC(18,4) persistence rounding a tiny tolerance into stock.
      allocated = D.min(group.remaining, line.quantity).toDecimalPlaces(4, D.ROUND_DOWN);
      group.remaining = group.remaining.minus(allocated);
      Object.assign(details, group.details);
      if (group.missing) codes.push('MISSING_GRN');
      if (group.excess) codes.push('QUANTITY_MISMATCH');
      unitVariance = new D(line.unitPrice).minus(item.unitPrice);
      const priceCheck = comparison(line.unitPrice, item.unitPrice, policy.priceTolerancePercent);
      details.price = { invoiceUnitPrice: line.unitPrice, poUnitPrice: item.unitPrice, ...priceCheck };
      if (!priceCheck.withinTolerance) codes.push('PRICE_MISMATCH');
      taxRateVariance = new D(line.taxRate).minus(item.taxRate);
      const taxPoints = taxRateVariance.abs().times(100);
      details.tax = { invoiceTaxRate: line.taxRate, poTaxRate: item.taxRate,
        variancePercentagePoints: taxPoints.toString(), tolerancePercentagePoints: policy.taxTolerancePercent };
      if (taxPoints.gt(policy.taxTolerancePercent)) codes.push('TAX_MISMATCH');
      const expectedSubtotal = new D(line.quantity).times(item.unitPrice).toDecimalPlaces(2);
      const expectedTax = expectedSubtotal.times(item.taxRate).toDecimalPlaces(2);
      lineTotalVariance = new D(line.lineTotal).minus(expectedSubtotal.plus(expectedTax));
      expectedTaxVariance = new D(line.taxAmount).minus(expectedTax);
      details.expectedPoTermsSubtotal = expectedSubtotal.toFixed(2);
      details.expectedPoTermsTax = expectedTax.toFixed(2);
      details.expectedPoTermsTotal = expectedSubtotal.plus(expectedTax).toFixed(2);
    }
    // Protect legacy line amounts as well as the invoice's structured header sums.
    const ownSubtotal = new D(line.quantity).times(line.unitPrice).toDecimalPlaces(2);
    const ownTax = ownSubtotal.times(line.taxRate).toDecimalPlaces(2);
    const lineChecks = {
      subtotal: comparison(line.lineSubtotal, ownSubtotal.toString(), policy.totalTolerancePercent),
      taxAmount: comparison(line.taxAmount, ownTax.toString(), policy.totalTolerancePercent),
      totalAmount: comparison(line.lineTotal, ownSubtotal.plus(ownTax).toString(), policy.totalTolerancePercent),
    };
    details.lineChecks = lineChecks;
    if (Object.values(lineChecks).some(check => !check.withinTolerance)) codes.push('TOTAL_MISMATCH');
    const uncovered = new D(line.quantity).minus(allocated);
    details.allocatedReceivedQuantity = allocated.toFixed(4);
    details.uncoveredQuantity = uncovered.toFixed(4);
    const discrepancyCodes = orderedCodes(codes);
    return {
      invoiceItemId: line.id, purchaseOrderItemId: item?.id ?? null,
      matchedReceivedQuantity: allocated.toFixed(4), quantityVariance: uncovered.toFixed(4),
      unitPriceVariance: unitVariance.toFixed(4), taxRateVariance: taxRateVariance.toFixed(4),
      lineTotalVariance: lineTotalVariance.toFixed(2), semanticConfidence: null,
      status: !item ? 'EXCEPTION' : discrepancyCodes.length ? 'MISMATCHED' : 'MATCHED',
      reasonCode: discrepancyCodes[0] ?? null, discrepancyCodes, details,
      expectedTaxVariance: expectedTaxVariance.toFixed(2),
    };
  });
  const discrepancyCodes = orderedCodes([...documentCodes, ...items.flatMap(line => line.discrepancyCodes)]);
  const passed = discrepancyCodes.length === 0;
  return {
    status: passed ? 'PASSED' : 'REVIEW_REQUIRED', invoiceStatus: passed ? 'MATCHED' : 'EXCEPTION',
    overallConfidence: null, supplierMatch: sameSupplier && sameTax, currencyMatch,
    quantityVariance: items.reduce((sum, line) => sum.plus(line.quantityVariance), new D(0)).toFixed(4),
    priceVariance: items.reduce((sum, line) => sum.plus(new D(line.unitPriceVariance).abs()), new D(0)).toFixed(4),
    taxVariance: items.reduce((sum, line) => sum.plus(line.expectedTaxVariance), new D(0)).toFixed(2),
    totalVariance: new D(invoice.totalAmount).minus(total).toFixed(2),
    ruleVersion: RULE_VERSION, policySnapshot: snapshotPolicy(policy), discrepancyCodes,
    items: items.map(({ expectedTaxVariance: _variance, ...line }) => line),
  };
}
export type MatchingEvaluation = ReturnType<typeof evaluateMatching>;
