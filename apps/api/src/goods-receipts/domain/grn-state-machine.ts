export enum GrnStatus {
  DRAFT = 'DRAFT',
  RECEIVED = 'RECEIVED',
  CANCELLED = 'CANCELLED',
}

export class GRNStateMachine {
  private static readonly ALLOWED_TRANSITIONS: Record<GrnStatus, readonly GrnStatus[]> = {
    [GrnStatus.DRAFT]: [GrnStatus.RECEIVED, GrnStatus.CANCELLED],
    [GrnStatus.RECEIVED]: [GrnStatus.CANCELLED],
    [GrnStatus.CANCELLED]: [],
  };

  /**
   * Evaluates if a GRN transition between states is permissible.
   */
  static canTransition(from: GrnStatus, to: GrnStatus): boolean {
    if (from === to) return false;
    const validTargets = this.ALLOWED_TRANSITIONS[from];
    return validTargets ? validTargets.includes(to) : false;
  }

  /**
   * Throws an error if the transition is prohibited.
   */
  static assertCanTransition(from: GrnStatus, to: GrnStatus): void {
    if (!this.canTransition(from, to)) {
      throw new Error(`Invalid GRN status transition from '${from}' to '${to}'`);
    }
  }

  /**
   * Confirms if the status is a terminal state (cannot transition further).
   */
  static isTerminal(status: GrnStatus): boolean {
    return status === GrnStatus.CANCELLED;
  }

  /**
   * Confirms if GRN items can be edited or replaced. Only DRAFT items can be modified.
   */
  static canModifyItems(status: GrnStatus): boolean {
    return status === GrnStatus.DRAFT;
  }
}
