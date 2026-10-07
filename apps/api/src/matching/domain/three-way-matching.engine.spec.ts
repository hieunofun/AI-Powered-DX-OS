import { evaluateMatching } from './three-way-matching.engine';
import { fixture, line } from '../../../test/fixtures/matching';
import { normalizeDescription, normalizeSku } from './normalization';
import { ItemResolver } from './item-resolver';
import { orderedCodes, DISCREPANCY_CODES } from './discrepancy-codes';
import { snapshotPolicy } from './matching-policy';
import { PreviousQuantity } from '../interfaces/matching.interface';

describe('Pure deterministic 3WM-1.1 evaluator', () => {
  const received = (quantity: string) => [{ purchaseOrderItemId: 'po-item-1', status: 'RECEIVED', acceptedQuantity: quantity }];
  const previous = (quantity: string, extra: Partial<PreviousQuantity> = {}) => ({
    purchaseOrderItemId: 'po-item-1', invoiceId: 'previous', invoiceStatus: 'MATCHED', resultStatus: 'PASSED', quantity, ...extra,
  });
  it('perfect match; exact strings, no semantic confidence and complete snapshot', () => {
    const result = evaluateMatching(fixture());
    expect(result).toMatchObject({ status: 'PASSED', invoiceStatus: 'MATCHED', overallConfidence: null, discrepancyCodes: [],
      quantityVariance: '0.0000', priceVariance: '0.0000', taxVariance: '0.00', totalVariance: '0.00',
      ruleVersion: '3WM-1.1', policySnapshot: { policyCode: 'MATCH_DEFAULT', quantityTolerancePercent: '0.00',
        priceTolerancePercent: '1.00', taxTolerancePercent: '0.00', totalTolerancePercent: '0.00', ruleVersion: '3WM-1.1' } });
    expect(result.items[0]).toMatchObject({ status: 'MATCHED', purchaseOrderItemId: 'po-item-1',
      matchedReceivedQuantity: '100.0000', semanticConfidence: null, reasonCode: null });
  });
  it('partial accepted receipt and partial invoice pass without comparing full PO total', () => {
    expect(evaluateMatching(fixture({ receipts: received('60'), invoiceItems: [line({ quantity: '60' })] })).status).toBe('PASSED');
  });
  it('over accepted receipt is a business quantity discrepancy', () => {
    const result = evaluateMatching(fixture({ receipts: received('60'), invoiceItems: [line({ quantity: '70' })] }));
    expect(result).toMatchObject({ status: 'REVIEW_REQUIRED', invoiceStatus: 'EXCEPTION', quantityVariance: '10.0000' });
    expect(result.items[0]).toMatchObject({ status: 'MISMATCHED', discrepancyCodes: ['QUANTITY_MISMATCH'],
      details: { orderedQuantity: '100.0000', cumulativeAcceptedReceived: '60', previousValidInvoicedQuantity: '0',
        poAllowed: '100', receivedAvailable: '60', poAvailable: '100', availableToInvoice: '60',
        invoiceAggregateQuantity: '70', allocatedReceivedQuantity: '60.0000', uncoveredQuantity: '10.0000' } });
  });
  it('only accepted RECEIVED quantities aggregate; DRAFT/CANCELLED are excluded', () => {
    const receipts = [{ ...received('30')[0] }, { ...received('30')[0] },
      { ...received('500')[0], status: 'DRAFT' }, { ...received('500')[0], status: 'CANCELLED' }];
    const result = evaluateMatching(fixture({ receipts, invoiceItems: [line({ quantity: '60' })] }));
    expect(result.status).toBe('PASSED');
    expect(result.items[0].details.cumulativeAcceptedReceived).toBe('60');
  });
  it.each([{ receipts: [] }, { receipts: received('0') }])('missing/zero accepted GRN blocks with both codes', ({ receipts }) => {
    expect(evaluateMatching(fixture({ receipts })).items[0].discrepancyCodes).toEqual(['MISSING_GRN', 'QUANTITY_MISMATCH']);
  });
  it.each([['38', 'PASSED'], ['40', 'REVIEW_REQUIRED']])('DOMAIN_RULES: accepted 98 minus prior 60, next %s', (quantity, status) => {
    const result = evaluateMatching(fixture({ receipts: received('98'), previousInvoices: [previous('60')],
      invoiceItems: [line({ quantity })] }));
    expect(result.status).toBe(status);
    expect(result.items[0].details.availableToInvoice).toBe('38');
  });
  it.each(['MATCHED', 'APPROVED', 'READY_FOR_PAYMENT'])('counts previous PASSED/%s', invoiceStatus => {
    expect(evaluateMatching(fixture({ previousInvoices: [previous('80', { invoiceStatus })],
      invoiceItems: [line({ quantity: '20' })] })).status).toBe('PASSED');
  });
  it.each(['PARSED', 'PENDING_MATCH', 'REJECTED', 'CANCELLED', 'RECEIVED'])('excludes previous %s', invoiceStatus => {
    expect(evaluateMatching(fixture({ previousInvoices: [previous('100', { invoiceStatus })] })).status).toBe('PASSED');
  });
  it('excludes current invoice and released claims; aggregates active consumption', () => {
    const result = evaluateMatching(fixture({ previousInvoices: [previous('100', { invoiceId: 'invoice-1' }),
      previous('100', { resultStatus: 'REVIEW_REQUIRED', invoiceStatus: 'REJECTED' }), previous('30'), previous('50', { invoiceId: 'previous-2' })],
      invoiceItems: [line({ quantity: '20' })] }));
    expect(result.status).toBe('PASSED');
    expect(result.items[0].details.previousValidInvoicedQuantity).toBe('80');
  });
  it.each(['APPROVED', 'READY_FOR_PAYMENT'])('approved exception reserves received quantity despite original REVIEW_REQUIRED/%s', invoiceStatus => {
    const result = evaluateMatching(fixture({ previousInvoices: [previous('100', { resultStatus: 'REVIEW_REQUIRED', invoiceStatus })] }));
    expect(result.status).toBe('REVIEW_REQUIRED');
    expect(result.items[0].discrepancyCodes).toContain('QUANTITY_MISMATCH');
    expect(result.items[0].details).toMatchObject({ previousValidInvoicedQuantity: '100', availableToInvoice: '0' });
  });
  it('pending exception claims reserve only the effective allocation supplied by the repository', () => {
    const result = evaluateMatching(fixture({ previousInvoices: [previous('40', { resultStatus: 'REVIEW_REQUIRED', invoiceStatus: 'EXCEPTION' })],
      invoiceItems: [line({ quantity: '61' })] }));
    expect(result.status).toBe('REVIEW_REQUIRED');
    expect(result.items[0].details).toMatchObject({ previousValidInvoicedQuantity: '40', availableToInvoice: '60' });
  });
  it('clamps negative remaining availability to zero', () => {
    const result = evaluateMatching(fixture({ previousInvoices: [previous('120')] }));
    expect(result.items[0].details).toMatchObject({ receivedAvailable: '-20', poAvailable: '-20', availableToInvoice: '0' });
  });
  it('split lines aggregate and allocate by line number; all lines explain the group failure', () => {
    const result = evaluateMatching(fixture({ invoiceItems: [line({ id: 'second', lineNumber: 2, quantity: '50' }),
      line({ quantity: '60' })] }));
    expect(result.items.map(item => item.invoiceItemId)).toEqual(['line-1', 'second']);
    expect(result.items.map(item => item.matchedReceivedQuantity)).toEqual(['60.0000', '40.0000']);
    expect(result.items.every(item => item.discrepancyCodes.includes('QUANTITY_MISMATCH'))).toBe(true);
    expect(result.quantityVariance).toBe('10.0000');
  });
  it('quantity tolerance permits only physically accepted over-PO stock', () => {
    const input = fixture({ receipts: received('105'), invoiceItems: [line({ quantity: '105' })] });
    const policy = { ...input.policy, quantityTolerancePercent: '5.00' };
    expect(evaluateMatching({ ...input, policy }).status).toBe('PASSED');
    expect(evaluateMatching({ ...input, policy, receipts: received('100') }).discrepancyCodes).toContain('QUANTITY_MISMATCH');
    expect(evaluateMatching({ ...input, receipts: received('105') }).discrepancyCodes).toContain('QUANTITY_MISMATCH');
  });
  it('never rounds fractional PO tolerance into invented received stock', () => {
    const input = fixture({ receipts: received('0.0002'), invoiceItems: [
      line({ quantity: '0.0001', unitPrice: '0' }), line({ id: 'second', lineNumber: 2, quantity: '0.0001', unitPrice: '0' })] });
    const result = evaluateMatching({ ...input, poItems: [{ ...input.poItems[0], orderedQuantity: '0.0001', unitPrice: '0' }],
      policy: { ...input.policy, quantityTolerancePercent: '1.00' } });
    expect(result.items[0].details.availableToInvoice).toBe('0.000101');
    expect(result.items.map(item => item.matchedReceivedQuantity)).toEqual(['0.0001', '0.0000']);
  });
  it.each([['100.50', 'PASSED'], ['101', 'PASSED'], ['101.0001', 'REVIEW_REQUIRED'],
    ['99', 'PASSED'], ['98.9999', 'REVIEW_REQUIRED']])('absolute price tolerance inclusive boundary %s', (unitPrice, status) => {
    expect(evaluateMatching(fixture({ invoiceItems: [line({ unitPrice })] })).status).toBe(status);
  });
  it('zero PO price and zero invoice price pass without division by zero', () => {
    const input = fixture({ invoiceItems: [line({ unitPrice: '0' })] });
    const result = evaluateMatching({ ...input, poItems: [{ ...input.poItems[0], unitPrice: '0' }] });
    expect(result.status).toBe('PASSED'); expect(result.items[0].details.price).toMatchObject({ variancePercent: '0' });
  });
  it('positive invoice price over zero PO price flags mismatch and undefined relative percentage', () => {
    const input = fixture();
    const result = evaluateMatching({ ...input, poItems: [{ ...input.poItems[0], unitPrice: '0' }] });
    expect(result.discrepancyCodes).toContain('PRICE_MISMATCH');
    expect(result.items[0].details.price).toMatchObject({ variancePercent: null, percentDenominator: '0' });
  });
  it('tax rate difference uses percentage points, persists signed exact difference', () => {
    const input = fixture({ invoiceItems: [line({ taxRate: '0.0800' })] });
    const failed = evaluateMatching(input);
    expect(failed.discrepancyCodes).toEqual(['TAX_MISMATCH']);
    expect(failed.items[0]).toMatchObject({ taxRateVariance: '-0.0200', details: { tax: { variancePercentagePoints: '2' } } });
    expect(evaluateMatching({ ...input, policy: { ...input.policy, taxTolerancePercent: '2.00' } }).status).toBe('PASSED');
  });
  it.each(['supplier', 'tax', 'missing-tax', 'blank-tax', 'currency'])('document %s discrepancy propagates to every line', kind => {
    const input = fixture({ invoiceItems: [line({ quantity: '50' }), line({ id: 'second', lineNumber: 2, quantity: '50' })] });
    const invoice = { ...input.invoice };
    if (kind === 'supplier') invoice.supplierId = 'other';
    if (kind === 'tax') invoice.sellerTaxCode = 'wrong';
    if (kind === 'missing-tax') invoice.sellerTaxCode = null;
    if (kind === 'blank-tax') invoice.sellerTaxCode = ' ';
    if (kind === 'currency') invoice.currency = 'USD';
    const result = evaluateMatching({ ...input, invoice });
    expect(result.status).toBe('REVIEW_REQUIRED');
    expect(result.items.every(item => item.status === 'MISMATCHED' && item.discrepancyCodes.length > 0)).toBe(true);
  });
  it('reuses Issue #7 NFKC tax code normalizer', () => {
    const input = fixture();
    expect(evaluateMatching({ ...input, invoice: { ...input.invoice, sellerTaxCode: ' ０１０１２３４５６７-００１ ' } }).status).toBe('PASSED');
  });
  it('exact SKU, normalized description fallback and explicit reference resolve', () => {
    for (const overrides of [{ sku: ' ｓｋｕ-１ ' }, { sku: null, description: '  hp   85a ' },
      { poItemId: 'po-item-1' }]) expect(evaluateMatching(fixture({ invoiceItems: [line(overrides)] })).status).toBe('PASSED');
  });
  it.each(['unknown', ''])('bad present SKU %s never hides behind a matching description', sku => {
    const result = evaluateMatching(fixture({ invoiceItems: [line({ sku })] }));
    expect(result.items[0]).toMatchObject({ purchaseOrderItemId: null, status: 'EXCEPTION',
      reasonCode: 'UNRECOGNIZED_ITEM', matchedReceivedQuantity: '0.0000' });
  });
  it('unknown description has no fuzzy/stemming/translation fallback', () => {
    expect(evaluateMatching(fixture({ invoiceItems: [line({ sku: null, description: 'HP 85B' })] })).discrepancyCodes).toContain('UNRECOGNIZED_ITEM');
  });
  it.each([true, false])('duplicate exact %s candidates are ambiguous', sku => {
    const input = fixture({ invoiceItems: [line({ sku: sku ? 'SKU-1' : null })] });
    const result = evaluateMatching({ ...input, poItems: [...input.poItems, { ...input.poItems[0], id: 'duplicate' }] });
    expect(result.items[0].status).toBe('EXCEPTION');
    expect(result.discrepancyCodes).toEqual(['AMBIGUOUS_ITEM']);
  });
  it.each([null, 'po-item-1'])('description mismatch remains mapped by SKU/reference %s', poItemId => {
    const result = evaluateMatching(fixture({ invoiceItems: [line({ description: 'different', poItemId })] }));
    expect(result.items[0]).toMatchObject({ purchaseOrderItemId: 'po-item-1', status: 'MISMATCHED',
      discrepancyCodes: ['ITEM_DESCRIPTION_MISMATCH'] });
  });
  it('rejects foreign PO items and invalid existing references as technical integrity errors', () => {
    const input = fixture();
    expect(() => new ItemResolver([{ ...input.poItems[0], purchaseOrderId: 'foreign' }], input.po.id)).toThrow('ownership');
    expect(() => evaluateMatching(fixture({ invoiceItems: [line({ poItemId: 'foreign' })] }))).toThrow('ownership');
  });
  it('missing/blank PO SKUs do not resolve a present SKU; description remains exact', () => {
    const input = fixture();
    for (const sku of [null, ' ']) {
      expect(evaluateMatching({ ...input, poItems: [{ ...input.poItems[0], sku }] }).status).toBe('REVIEW_REQUIRED');
      expect(evaluateMatching({ ...input, poItems: [{ ...input.poItems[0], sku }], invoiceItems: [line({ sku: null })] }).status).toBe('PASSED');
    }
  });
  it.each(['subtotal', 'taxAmount', 'totalAmount'])('legacy header %s mismatch blocks all affected lines', key => {
    const input = fixture();
    const result = evaluateMatching({ ...input, invoice: { ...input.invoice, [key]: '999' } });
    expect(result.discrepancyCodes).toContain('TOTAL_MISMATCH');
    expect(result.items[0].discrepancyCodes).toContain('TOTAL_MISMATCH');
  });
  it('configured total tolerance applies to header and own line checks, inclusive', () => {
    const input = fixture({ invoiceItems: [line({ unitPrice: '1', quantity: '100', taxRate: '0' })] });
    const poItems = [{ ...input.poItems[0], unitPrice: '1', taxRate: '0' }];
    const policy = { ...input.policy, totalTolerancePercent: '1.00' };
    expect(evaluateMatching({ ...input, poItems, policy, invoice: { ...input.invoice, subtotal: '101', totalAmount: '101' } }).status).toBe('PASSED');
    expect(evaluateMatching({ ...input, poItems, policy, invoice: { ...input.invoice, subtotal: '101.01', totalAmount: '101.01' } }).discrepancyCodes).toContain('TOTAL_MISMATCH');
  });
  it('zero expected header total requires exact zero even at 100% tolerance', () => {
    const input = fixture({ invoiceItems: [line({ unitPrice: '0' })] });
    const result = evaluateMatching({ ...input, poItems: [{ ...input.poItems[0], unitPrice: '0' }],
      policy: { ...input.policy, totalTolerancePercent: '100' }, invoice: { ...input.invoice, totalAmount: '1' } });
    expect(result.discrepancyCodes).toContain('TOTAL_MISMATCH');
  });
  it('legacy line corruption is detected even when header repeats the corrupt line sums', () => {
    const result = evaluateMatching(fixture({ invoiceItems: [line({ lineSubtotal: '1', taxAmount: '2', lineTotal: '3' })] }));
    expect(result.items[0].discrepancyCodes).toContain('TOTAL_MISMATCH');
  });
  it('rejects empty structured invoices', () => expect(() => evaluateMatching(fixture({ invoiceItems: [] }))).toThrow('structured lines'));
  it.each(['NaN', 'Infinity', '-1', 1])('rejects unsafe trusted numeric input %j', value => {
    const input = fixture();
    expect(() => evaluateMatching({ ...input, receipts: [{ ...input.receipts[0], acceptedQuantity: value as string }] })).toThrow('finite');
  });
  it('normalizes NFKC, whitespace/case but preserves meaningful punctuation and words', () => {
    expect(normalizeSku(' ａｂ-１２ / x  ')).toBe('AB-12 / X');
    expect(normalizeDescription('  Mực   in\tHP 85A  ')).toBe('MỰC IN HP 85A');
    expect(normalizeSku('AB-1')).not.toBe(normalizeSku('AB1'));
  });
  it('discrepancy order is central, unique and independent of discovery order', () => {
    expect(orderedCodes([...DISCREPANCY_CODES].reverse().concat('PRICE_MISMATCH'))).toEqual(DISCREPANCY_CODES);
  });
  it('policy snapshot is independent of later updates', () => {
    const policy = { ...fixture().policy };
    const snapshot = snapshotPolicy(policy);
    policy.priceTolerancePercent = '2';
    expect(snapshot.priceTolerancePercent).toBe('1.00');
  });
  it('same input always produces identical output without mutating input', () => {
    const input = fixture({ invoiceItems: [line({ id: 'second', lineNumber: 2, quantity: '50' }), line({ quantity: '60' })] });
    const before = JSON.stringify(input);
    const a = evaluateMatching(input), b = evaluateMatching(input);
    expect(a).toEqual(b); expect(JSON.stringify(input)).toBe(before);
  });
});
