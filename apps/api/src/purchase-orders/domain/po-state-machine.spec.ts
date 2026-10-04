import { POStateMachine, PurchaseOrderStatus } from './po-state-machine';

describe('POStateMachine', () => {
  describe('canTransition', () => {
    it('permits valid transitions from DRAFT', () => {
      expect(POStateMachine.canTransition(PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.ISSUED)).toBe(true);
      expect(POStateMachine.canTransition(PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.CANCELLED)).toBe(true);
      expect(POStateMachine.canTransition(PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.CLOSED)).toBe(false);
      expect(POStateMachine.canTransition(PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.PARTIALLY_RECEIVED)).toBe(false);
    });

    it('permits valid transitions from ISSUED', () => {
      expect(POStateMachine.canTransition(PurchaseOrderStatus.ISSUED, PurchaseOrderStatus.CANCELLED)).toBe(true);
      expect(POStateMachine.canTransition(PurchaseOrderStatus.ISSUED, PurchaseOrderStatus.PARTIALLY_RECEIVED)).toBe(true);
      expect(POStateMachine.canTransition(PurchaseOrderStatus.ISSUED, PurchaseOrderStatus.FULLY_RECEIVED)).toBe(true);
      expect(POStateMachine.canTransition(PurchaseOrderStatus.ISSUED, PurchaseOrderStatus.DRAFT)).toBe(false);
    });

    it('prohibits any transitions out of terminal states (CANCELLED, CLOSED)', () => {
      expect(POStateMachine.canTransition(PurchaseOrderStatus.CANCELLED, PurchaseOrderStatus.DRAFT)).toBe(false);
      expect(POStateMachine.canTransition(PurchaseOrderStatus.CANCELLED, PurchaseOrderStatus.ISSUED)).toBe(false);
      expect(POStateMachine.canTransition(PurchaseOrderStatus.CLOSED, PurchaseOrderStatus.CANCELLED)).toBe(false);
    });

    it('prohibits self-transitions', () => {
      expect(POStateMachine.canTransition(PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.DRAFT)).toBe(false);
      expect(POStateMachine.canTransition(PurchaseOrderStatus.ISSUED, PurchaseOrderStatus.ISSUED)).toBe(false);
    });
  });

  describe('assertCanIssue', () => {
    it('allows issuing when in DRAFT', () => {
      expect(() => POStateMachine.assertCanIssue(PurchaseOrderStatus.DRAFT)).not.toThrow();
    });

    it('throws when attempting to issue non-DRAFT order', () => {
      expect(() => POStateMachine.assertCanIssue(PurchaseOrderStatus.ISSUED)).toThrow('Only \'DRAFT\' orders can be issued');
      expect(() => POStateMachine.assertCanIssue(PurchaseOrderStatus.CANCELLED)).toThrow('Only \'DRAFT\' orders can be issued');
      expect(() => POStateMachine.assertCanIssue(PurchaseOrderStatus.CLOSED)).toThrow('Only \'DRAFT\' orders can be issued');
    });
  });

  describe('assertCanCancel', () => {
    it('allows cancellation from DRAFT or ISSUED', () => {
      expect(() => POStateMachine.assertCanCancel(PurchaseOrderStatus.DRAFT)).not.toThrow();
      expect(() => POStateMachine.assertCanCancel(PurchaseOrderStatus.ISSUED)).not.toThrow();
    });

    it('throws when attempting to cancel orders in other states', () => {
      expect(() => POStateMachine.assertCanCancel(PurchaseOrderStatus.CLOSED)).toThrow('Only \'DRAFT\' or \'ISSUED\' orders can be cancelled');
      expect(() => POStateMachine.assertCanCancel(PurchaseOrderStatus.CANCELLED)).toThrow('Only \'DRAFT\' or \'ISSUED\' orders can be cancelled');
    });
  });

  describe('assertCanModify', () => {
    it('allows modification when in DRAFT', () => {
      expect(() => POStateMachine.assertCanModify(PurchaseOrderStatus.DRAFT)).not.toThrow();
    });

    it('throws when attempting to modify non-DRAFT order', () => {
      expect(() => POStateMachine.assertCanModify(PurchaseOrderStatus.ISSUED)).toThrow('Content can only be updated while in \'DRAFT\'');
      expect(() => POStateMachine.assertCanModify(PurchaseOrderStatus.CANCELLED)).toThrow('Content can only be updated while in \'DRAFT\'');
    });
  });
});
