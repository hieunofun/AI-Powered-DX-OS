export enum PurchaseOrderStatus {
  DRAFT = 'DRAFT',
  ISSUED = 'ISSUED',
  PARTIALLY_RECEIVED = 'PARTIALLY_RECEIVED',
  FULLY_RECEIVED = 'FULLY_RECEIVED',
  CLOSED = 'CLOSED',
  CANCELLED = 'CANCELLED',
}

export class POStateMachine {
  /**
   * Returns whether a direct state transition requested by the PO module is permissible.
   *
   * Issue #5 directly manages:
   *   - DRAFT -> ISSUED
   *   - DRAFT -> CANCELLED
   *   - ISSUED -> CANCELLED
   *
   * Downstream states (PARTIALLY_RECEIVED, FULLY_RECEIVED) are managed by Goods Receipt (Issue #6).
   * CLOSED is managed when downstream matching and payment obligations are completed.
   */
  static canTransition(from: PurchaseOrderStatus, to: PurchaseOrderStatus): boolean {
    if (from === to) {
      return false;
    }

    // Terminal states cannot transition further
    if (from === PurchaseOrderStatus.CANCELLED || from === PurchaseOrderStatus.CLOSED) {
      return false;
    }

    switch (from) {
      case PurchaseOrderStatus.DRAFT:
        return to === PurchaseOrderStatus.ISSUED || to === PurchaseOrderStatus.CANCELLED;

      case PurchaseOrderStatus.ISSUED:
        return (
          to === PurchaseOrderStatus.CANCELLED ||
          to === PurchaseOrderStatus.PARTIALLY_RECEIVED ||
          to === PurchaseOrderStatus.FULLY_RECEIVED
        );

      case PurchaseOrderStatus.PARTIALLY_RECEIVED:
        return to === PurchaseOrderStatus.FULLY_RECEIVED || to === PurchaseOrderStatus.CLOSED;

      case PurchaseOrderStatus.FULLY_RECEIVED:
        return to === PurchaseOrderStatus.CLOSED;

      default:
        return false;
    }
  }

  /**
   * Asserts whether a status transition is permitted within Issue #5 service actions.
   */
  static assertCanIssue(currentStatus: PurchaseOrderStatus): void {
    if (currentStatus !== PurchaseOrderStatus.DRAFT) {
      throw new Error(
        `Cannot issue Purchase Order in '${currentStatus}' status. Only 'DRAFT' orders can be issued.`,
      );
    }
  }

  /**
   * Asserts whether a Purchase Order can be cancelled.
   */
  static assertCanCancel(currentStatus: PurchaseOrderStatus): void {
    if (
      currentStatus !== PurchaseOrderStatus.DRAFT &&
      currentStatus !== PurchaseOrderStatus.ISSUED
    ) {
      throw new Error(
        `Cannot cancel Purchase Order in '${currentStatus}' status. Only 'DRAFT' or 'ISSUED' orders can be cancelled.`,
      );
    }
  }

  /**
   * Asserts whether line items and core business attributes can be modified.
   */
  static assertCanModify(currentStatus: PurchaseOrderStatus): void {
    if (currentStatus !== PurchaseOrderStatus.DRAFT) {
      throw new Error(
        `Cannot modify Purchase Order in '${currentStatus}' status. Content can only be updated while in 'DRAFT'.`,
      );
    }
  }
}
