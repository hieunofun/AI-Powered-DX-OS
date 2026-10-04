import Decimal from 'decimal.js';
import { FulfillmentCalculator } from './fulfillment-calculator';
import { PurchaseOrderStatus } from '../../purchase-orders/domain/po-state-machine';

describe('FulfillmentCalculator', () => {
  describe('validateLineQuantities', () => {
    it('validates a correct line item on DRAFT with partial classification', () => {
      expect(() =>
        FulfillmentCalculator.validateLineQuantities(
          {
            receivedQuantity: '10.0000',
            acceptedQuantity: '6.0000',
            rejectedQuantity: '2.0000',
            damageNote: '2 units defective packaging',
          },
          false,
        ),
      ).not.toThrow();
    });

    it('rejects strictly non-positive receivedQuantity', () => {
      expect(() =>
        FulfillmentCalculator.validateLineQuantities({
          receivedQuantity: '0.0000',
          acceptedQuantity: '0.0000',
          rejectedQuantity: '0.0000',
        }),
      ).toThrow('must be strictly positive');

      expect(() =>
        FulfillmentCalculator.validateLineQuantities({
          receivedQuantity: '-5.0000',
          acceptedQuantity: '0.0000',
          rejectedQuantity: '0.0000',
        }),
      ).toThrow('must be strictly positive');
    });

    it('rejects negative acceptedQuantity or rejectedQuantity', () => {
      expect(() =>
        FulfillmentCalculator.validateLineQuantities({
          receivedQuantity: '10.0000',
          acceptedQuantity: '-1.0000',
          rejectedQuantity: '0.0000',
        }),
      ).toThrow('cannot be negative');

      expect(() =>
        FulfillmentCalculator.validateLineQuantities({
          receivedQuantity: '10.0000',
          acceptedQuantity: '0.0000',
          rejectedQuantity: '-2.0000',
        }),
      ).toThrow('cannot be negative');
    });

    it('requires damageNote when rejectedQuantity > 0', () => {
      expect(() =>
        FulfillmentCalculator.validateLineQuantities({
          receivedQuantity: '10.0000',
          acceptedQuantity: '8.0000',
          rejectedQuantity: '2.0000',
          damageNote: '',
        }),
      ).toThrow('damageNote is mandatory when rejectedQuantity');

      expect(() =>
        FulfillmentCalculator.validateLineQuantities({
          receivedQuantity: '10.0000',
          acceptedQuantity: '8.0000',
          rejectedQuantity: '2.0000',
          damageNote: '   ',
        }),
      ).toThrow('damageNote is mandatory when rejectedQuantity');
    });

    it('does not require damageNote when rejectedQuantity is 0', () => {
      expect(() =>
        FulfillmentCalculator.validateLineQuantities({
          receivedQuantity: '10.0000',
          acceptedQuantity: '10.0000',
          rejectedQuantity: '0.0000',
          damageNote: undefined,
        }),
      ).not.toThrow();
    });

    it('rejects accepted + rejected > received on DRAFT', () => {
      expect(() =>
        FulfillmentCalculator.validateLineQuantities(
          {
            receivedQuantity: '10.0000',
            acceptedQuantity: '8.0000',
            rejectedQuantity: '3.0000',
            damageNote: 'Damaged',
          },
          false,
        ),
      ).toThrow('cannot exceed receivedQuantity');
    });

    it('rejects unclassified quantity upon final inspection (isFinalizing = true)', () => {
      expect(() =>
        FulfillmentCalculator.validateLineQuantities(
          {
            receivedQuantity: '10.0000',
            acceptedQuantity: '6.0000',
            rejectedQuantity: '2.0000',
            damageNote: 'Damaged',
          },
          true,
        ),
      ).toThrow('must exactly equal receivedQuantity');
    });

    it('accepts exact full classification upon final inspection', () => {
      expect(() =>
        FulfillmentCalculator.validateLineQuantities(
          {
            receivedQuantity: '10.0000',
            acceptedQuantity: '7.5000',
            rejectedQuantity: '2.5000',
            damageNote: 'Damaged seal',
          },
          true,
        ),
      ).not.toThrow();
    });
  });

  describe('checkOverDelivery', () => {
    const poItems = [
      { id: 'item-1', orderedQuantity: '100.0000' },
      { id: 'item-2', orderedQuantity: '50.0000' },
    ];

    it('permits receipt within 0.00% tolerance', () => {
      const prevAccepted = new Map<string, Decimal>([
        ['item-1', new Decimal('80.0000')],
        ['item-2', new Decimal('30.0000')],
      ]);

      const currentLines = [
        { purchaseOrderItemId: 'item-1', acceptedQuantity: '20.0000' },
        { purchaseOrderItemId: 'item-2', acceptedQuantity: '20.0000' },
      ];

      const result = FulfillmentCalculator.checkOverDelivery(
        poItems,
        prevAccepted,
        currentLines,
        '0.00',
      );

      expect(result.isOverDelivered).toBe(false);
    });

    it('rejects receipt exceeding 0.00% tolerance by even 0.0001', () => {
      const prevAccepted = new Map<string, Decimal>([
        ['item-1', new Decimal('90.0000')],
      ]);

      const currentLines = [
        { purchaseOrderItemId: 'item-1', acceptedQuantity: '10.0001' },
      ];

      const result = FulfillmentCalculator.checkOverDelivery(
        poItems,
        prevAccepted,
        currentLines,
        '0.00',
      );

      expect(result.isOverDelivered).toBe(true);
      expect(result.poItemId).toBe('item-1');
      expect(result.orderedQuantity).toBe('100.0000');
      expect(result.previousAccepted).toBe('90.0000');
      expect(result.proposedAccepted).toBe('100.0001');
      expect(result.allowedAccepted).toBe('100.0000');
    });

    it('permits receipt within 10.00% tolerance (allowed 110)', () => {
      const prevAccepted = new Map<string, Decimal>([
        ['item-1', new Decimal('90.0000')],
      ]);

      const currentLines = [
        { purchaseOrderItemId: 'item-1', acceptedQuantity: '20.0000' }, // Total 110.0000
      ];

      const result = FulfillmentCalculator.checkOverDelivery(
        poItems,
        prevAccepted,
        currentLines,
        '10.00',
      );

      expect(result.isOverDelivered).toBe(false);
    });

    it('rejects receipt exceeding 10.00% tolerance (total 110.0001)', () => {
      const prevAccepted = new Map<string, Decimal>([
        ['item-1', new Decimal('90.0000')],
      ]);

      const currentLines = [
        { purchaseOrderItemId: 'item-1', acceptedQuantity: '20.0001' },
      ];

      const result = FulfillmentCalculator.checkOverDelivery(
        poItems,
        prevAccepted,
        currentLines,
        '10.00',
      );

      expect(result.isOverDelivered).toBe(true);
      expect(result.proposedAccepted).toBe('110.0001');
      expect(result.allowedAccepted).toBe('110.0000');
    });

    it('correctly aggregates multiple lots of the same PO item in current GRN', () => {
      const prevAccepted = new Map<string, Decimal>([
        ['item-1', new Decimal('90.0000')],
      ]);

      // Two different lots of item-1 arriving together
      const currentLines = [
        { purchaseOrderItemId: 'item-1', acceptedQuantity: '6.0000' }, // lot A
        { purchaseOrderItemId: 'item-1', acceptedQuantity: '5.0000' }, // lot B -> total 11
      ];

      const result = FulfillmentCalculator.checkOverDelivery(
        poItems,
        prevAccepted,
        currentLines,
        '0.00',
      );

      expect(result.isOverDelivered).toBe(true);
      expect(result.currentAccepted).toBe('11.0000');
      expect(result.proposedAccepted).toBe('101.0000');
    });
  });

  describe('calculatePoStatus', () => {
    const poItems = [
      { id: 'item-1', orderedQuantity: '100.0000' },
      { id: 'item-2', orderedQuantity: '50.0000' },
    ];

    it('returns ISSUED when cumulative accepted is zero across all lines', () => {
      const cumulative = new Map<string, Decimal>([
        ['item-1', new Decimal('0.0000')],
        ['item-2', new Decimal('0.0000')],
      ]);

      expect(FulfillmentCalculator.calculatePoStatus(poItems, cumulative)).toBe(
        PurchaseOrderStatus.ISSUED,
      );
    });

    it('returns PARTIALLY_RECEIVED when one item is partially received', () => {
      const cumulative = new Map<string, Decimal>([
        ['item-1', new Decimal('60.0000')],
        ['item-2', new Decimal('0.0000')],
      ]);

      expect(FulfillmentCalculator.calculatePoStatus(poItems, cumulative)).toBe(
        PurchaseOrderStatus.PARTIALLY_RECEIVED,
      );
    });

    it('returns PARTIALLY_RECEIVED when item 1 is full but item 2 is not', () => {
      const cumulative = new Map<string, Decimal>([
        ['item-1', new Decimal('100.0000')],
        ['item-2', new Decimal('49.9999')],
      ]);

      expect(FulfillmentCalculator.calculatePoStatus(poItems, cumulative)).toBe(
        PurchaseOrderStatus.PARTIALLY_RECEIVED,
      );
    });

    it('returns FULLY_RECEIVED when every PO line is fulfilled', () => {
      const cumulative = new Map<string, Decimal>([
        ['item-1', new Decimal('100.0000')],
        ['item-2', new Decimal('50.0000')],
      ]);

      expect(FulfillmentCalculator.calculatePoStatus(poItems, cumulative)).toBe(
        PurchaseOrderStatus.FULLY_RECEIVED,
      );
    });

    it('returns FULLY_RECEIVED when items exceed ordered quantity due to tolerance', () => {
      const cumulative = new Map<string, Decimal>([
        ['item-1', new Decimal('105.0000')],
        ['item-2', new Decimal('52.0000')],
      ]);

      expect(FulfillmentCalculator.calculatePoStatus(poItems, cumulative)).toBe(
        PurchaseOrderStatus.FULLY_RECEIVED,
      );
    });

    it('correctly handles cancellation reversal back to PARTIALLY_RECEIVED and ISSUED', () => {
      // 1. Initial full state
      const full = new Map<string, Decimal>([
        ['item-1', new Decimal('100.0000')],
        ['item-2', new Decimal('50.0000')],
      ]);
      expect(FulfillmentCalculator.calculatePoStatus(poItems, full)).toBe(
        PurchaseOrderStatus.FULLY_RECEIVED,
      );

      // 2. After cancelling GRN with 40 units of item-1 -> 60 accepted
      const partial = new Map<string, Decimal>([
        ['item-1', new Decimal('60.0000')],
        ['item-2', new Decimal('50.0000')],
      ]);
      expect(FulfillmentCalculator.calculatePoStatus(poItems, partial)).toBe(
        PurchaseOrderStatus.PARTIALLY_RECEIVED,
      );

      // 3. After cancelling remaining receipts -> 0 accepted
      const empty = new Map<string, Decimal>([
        ['item-1', new Decimal('0.0000')],
        ['item-2', new Decimal('0.0000')],
      ]);
      expect(FulfillmentCalculator.calculatePoStatus(poItems, empty)).toBe(
        PurchaseOrderStatus.ISSUED,
      );
    });
  });
});
