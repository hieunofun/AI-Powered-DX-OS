import Decimal from 'decimal.js';
import { PurchaseOrderStatus } from '../../purchase-orders/domain/po-state-machine';

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

export interface GrnLineValidationInput {
  receivedQuantity: string;
  acceptedQuantity?: string;
  rejectedQuantity?: string;
  damageNote?: string | null;
}

export interface PoItemFulfillmentInput {
  id: string;
  orderedQuantity: string;
}

export interface OverDeliveryCheckResult {
  isOverDelivered: boolean;
  poItemId?: string;
  orderedQuantity?: string;
  previousAccepted?: string;
  currentAccepted?: string;
  proposedAccepted?: string;
  allowedAccepted?: string;
  tolerancePercent?: string;
}

export class FulfillmentCalculator {
  /**
   * Validates line quantity conservation rules.
   *
   * Invariants:
   * 1. receivedQuantity > 0
   * 2. acceptedQuantity >= 0
   * 3. rejectedQuantity >= 0
   * 4. If rejectedQuantity > 0, damageNote must be provided and non-empty
   * 5. If isFinalizing = false (DRAFT): acceptedQuantity + rejectedQuantity <= receivedQuantity
   * 6. If isFinalizing = true (RECEIVE): acceptedQuantity + rejectedQuantity === receivedQuantity (strictly fully classified)
   */
  static validateLineQuantities(
    line: GrnLineValidationInput,
    isFinalizing = false,
  ): void {
    const received = new Decimal(line.receivedQuantity);
    const accepted = new Decimal(line.acceptedQuantity ?? '0');
    const rejected = new Decimal(line.rejectedQuantity ?? '0');

    if (received.lte(0)) {
      throw new Error(`receivedQuantity (${line.receivedQuantity}) must be strictly positive`);
    }

    if (accepted.lt(0)) {
      throw new Error(`acceptedQuantity (${line.acceptedQuantity}) cannot be negative`);
    }

    if (rejected.lt(0)) {
      throw new Error(`rejectedQuantity (${line.rejectedQuantity}) cannot be negative`);
    }

    if (rejected.gt(0)) {
      if (!line.damageNote || !line.damageNote.trim()) {
        throw new Error(
          `damageNote is mandatory when rejectedQuantity (${line.rejectedQuantity}) is greater than 0`,
        );
      }
    }

    const classifiedTotal = accepted.plus(rejected);

    if (isFinalizing) {
      if (!classifiedTotal.equals(received)) {
        throw new Error(
          `On final inspection, acceptedQuantity (${accepted.toFixed(4)}) + rejectedQuantity (${rejected.toFixed(4)}) ` +
            `must exactly equal receivedQuantity (${received.toFixed(4)}). Unclassified quantity is not permitted upon receipt.`,
        );
      }
    } else {
      if (classifiedTotal.gt(received)) {
        throw new Error(
          `acceptedQuantity (${accepted.toFixed(4)}) + rejectedQuantity (${rejected.toFixed(4)}) ` +
            `cannot exceed receivedQuantity (${received.toFixed(4)})`,
        );
      }
    }
  }

  /**
   * Evaluates proposed accepted quantities against PO ordered amounts and active over-delivery tolerance.
   *
   * Formula:
   *   allowedAccepted = orderedQuantity * (1 + tolerancePercent / 100)
   *   proposedAccepted = previousAccepted + currentGrnAccepted
   *
   * Rejects if proposedAccepted > allowedAccepted.
   */
  static checkOverDelivery(
    poItems: PoItemFulfillmentInput[],
    previousAcceptedMap: Map<string, Decimal>,
    currentGrnLines: Array<{ purchaseOrderItemId: string; acceptedQuantity: string }>,
    tolerancePercentStr: string,
  ): OverDeliveryCheckResult {
    const tolerance = new Decimal(tolerancePercentStr);
    const toleranceFactor = new Decimal(1).plus(tolerance.dividedBy(100));

    // Aggregate proposed accepted quantities by PO item ID (a single PO item may appear across multiple lots)
    const currentAcceptedByPoItem = new Map<string, Decimal>();
    for (const line of currentGrnLines) {
      const existing = currentAcceptedByPoItem.get(line.purchaseOrderItemId) ?? new Decimal(0);
      currentAcceptedByPoItem.set(
        line.purchaseOrderItemId,
        existing.plus(new Decimal(line.acceptedQuantity)),
      );
    }

    for (const poItem of poItems) {
      const ordered = new Decimal(poItem.orderedQuantity);
      const prevAccepted = previousAcceptedMap.get(poItem.id) ?? new Decimal(0);
      const currAccepted = currentAcceptedByPoItem.get(poItem.id) ?? new Decimal(0);
      const proposedAccepted = prevAccepted.plus(currAccepted);
      const allowedAccepted = ordered.times(toleranceFactor);

      if (proposedAccepted.gt(allowedAccepted)) {
        return {
          isOverDelivered: true,
          poItemId: poItem.id,
          orderedQuantity: ordered.toFixed(4),
          previousAccepted: prevAccepted.toFixed(4),
          currentAccepted: currAccepted.toFixed(4),
          proposedAccepted: proposedAccepted.toFixed(4),
          allowedAccepted: allowedAccepted.toFixed(4),
          tolerancePercent: tolerance.toFixed(2),
        };
      }
    }

    return { isOverDelivered: false };
  }

  /**
   * Derives PO status from cumulative accepted items across all finalized (RECEIVED) GRNs.
   *
   * Invariants:
   * - If every PO line has cumulativeAccepted >= orderedQuantity -> FULLY_RECEIVED
   * - Else if at least one PO line has cumulativeAccepted > 0 -> PARTIALLY_RECEIVED
   * - Else -> ISSUED
   */
  static calculatePoStatus(
    poItems: PoItemFulfillmentInput[],
    cumulativeAcceptedMap: Map<string, Decimal>,
  ): PurchaseOrderStatus {
    if (poItems.length === 0) {
      return PurchaseOrderStatus.ISSUED;
    }

    let allFulfilled = true;
    let anyAccepted = false;

    for (const poItem of poItems) {
      const ordered = new Decimal(poItem.orderedQuantity);
      const accepted = cumulativeAcceptedMap.get(poItem.id) ?? new Decimal(0);

      if (accepted.lt(ordered)) {
        allFulfilled = false;
      }
      if (accepted.gt(0)) {
        anyAccepted = true;
      }
    }

    if (allFulfilled) {
      return PurchaseOrderStatus.FULLY_RECEIVED;
    }
    if (anyAccepted) {
      return PurchaseOrderStatus.PARTIALLY_RECEIVED;
    }
    return PurchaseOrderStatus.ISSUED;
  }
}
