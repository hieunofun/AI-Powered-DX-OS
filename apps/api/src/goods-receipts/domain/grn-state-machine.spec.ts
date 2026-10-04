import { GRNStateMachine, GrnStatus } from './grn-state-machine';

describe('GRNStateMachine', () => {
  describe('canTransition', () => {
    it('allows valid DRAFT -> RECEIVED transition', () => {
      expect(GRNStateMachine.canTransition(GrnStatus.DRAFT, GrnStatus.RECEIVED)).toBe(true);
    });

    it('allows valid DRAFT -> CANCELLED transition', () => {
      expect(GRNStateMachine.canTransition(GrnStatus.DRAFT, GrnStatus.CANCELLED)).toBe(true);
    });

    it('allows valid RECEIVED -> CANCELLED transition', () => {
      expect(GRNStateMachine.canTransition(GrnStatus.RECEIVED, GrnStatus.CANCELLED)).toBe(true);
    });

    it('prohibits RECEIVED -> DRAFT transition', () => {
      expect(GRNStateMachine.canTransition(GrnStatus.RECEIVED, GrnStatus.DRAFT)).toBe(false);
    });

    it('prohibits CANCELLED -> DRAFT transition (terminal)', () => {
      expect(GRNStateMachine.canTransition(GrnStatus.CANCELLED, GrnStatus.DRAFT)).toBe(false);
    });

    it('prohibits CANCELLED -> RECEIVED transition (terminal)', () => {
      expect(GRNStateMachine.canTransition(GrnStatus.CANCELLED, GrnStatus.RECEIVED)).toBe(false);
    });

    it('prohibits same state transitions', () => {
      expect(GRNStateMachine.canTransition(GrnStatus.DRAFT, GrnStatus.DRAFT)).toBe(false);
      expect(GRNStateMachine.canTransition(GrnStatus.RECEIVED, GrnStatus.RECEIVED)).toBe(false);
      expect(GRNStateMachine.canTransition(GrnStatus.CANCELLED, GrnStatus.CANCELLED)).toBe(false);
    });
  });

  describe('assertCanTransition', () => {
    it('does not throw on valid transition', () => {
      expect(() =>
        GRNStateMachine.assertCanTransition(GrnStatus.DRAFT, GrnStatus.RECEIVED),
      ).not.toThrow();
    });

    it('throws descriptive error on invalid transition', () => {
      expect(() =>
        GRNStateMachine.assertCanTransition(GrnStatus.RECEIVED, GrnStatus.DRAFT),
      ).toThrow("Invalid GRN status transition from 'RECEIVED' to 'DRAFT'");
    });
  });

  describe('isTerminal and canModifyItems', () => {
    it('identifies CANCELLED as terminal', () => {
      expect(GRNStateMachine.isTerminal(GrnStatus.CANCELLED)).toBe(true);
      expect(GRNStateMachine.isTerminal(GrnStatus.DRAFT)).toBe(false);
      expect(GRNStateMachine.isTerminal(GrnStatus.RECEIVED)).toBe(false);
    });

    it('allows item modifications only in DRAFT', () => {
      expect(GRNStateMachine.canModifyItems(GrnStatus.DRAFT)).toBe(true);
      expect(GRNStateMachine.canModifyItems(GrnStatus.RECEIVED)).toBe(false);
      expect(GRNStateMachine.canModifyItems(GrnStatus.CANCELLED)).toBe(false);
    });
  });
});
