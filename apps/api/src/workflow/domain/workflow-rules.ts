import Decimal from 'decimal.js';
import { WorkflowError } from '../workflow-error';
export const PROCESS_KEY = 'invoiceExceptionWorkflow';
export const ROLE_ORDER = ['warehouse', 'buyer', 'accountant'] as const;
export const TASK_ROLES: Record<string, string> = { warehouseReview: 'warehouse', buyerReview: 'buyer',
  accountantReview: 'accountant', financeReview: 'finance_manager' };
export const DISCREPANCY_ROLES: Record<string, string> = {
  PRICE_MISMATCH: 'buyer', ITEM_DESCRIPTION_MISMATCH: 'buyer', UNRECOGNIZED_ITEM: 'buyer', AMBIGUOUS_ITEM: 'buyer',
  MISSING_GRN: 'warehouse', QUANTITY_MISMATCH: 'warehouse', TAX_MISMATCH: 'accountant', TOTAL_MISMATCH: 'accountant',
  SUPPLIER_MISMATCH: 'accountant', SELLER_TAX_CODE_MISSING: 'accountant', SELLER_TAX_CODE_MISMATCH: 'accountant', CURRENCY_MISMATCH: 'accountant',
};
export interface WorkflowPolicy { id: string; policyCode: string; autoReadyForPaymentMaxAmount: string | null; financeApprovalThreshold: string }
export function money(value: unknown): Decimal {
  if (typeof value !== 'string' || !/^\d{1,16}(\.\d{1,2})?$/.test(value)) {
    throw new WorkflowError('INVALID_WORKFLOW_EVIDENCE', 'Workflow amounts must be finite nonnegative NUMERIC(18,2) strings.');
  }
  return new Decimal(value);
}
export function requiredRoles(codes: string[]): string[] {
  if (!Array.isArray(codes) || !codes.length || codes.some(code => !Object.prototype.hasOwnProperty.call(DISCREPANCY_ROLES, code))) {
    throw new WorkflowError('UNSUPPORTED_DISCREPANCY', 'Every discrepancy must have an explicit workflow adapter.', 409);
  }
  return ROLE_ORDER.filter(role => codes.some(code => DISCREPANCY_ROLES[code] === role));
}
export function workflowRoute(invoiceStatus: string, matchStatus: string, total: string, policy: WorkflowPolicy, codes: string[]) {
  const amount = money(total), threshold = money(policy.financeApprovalThreshold);
  if (invoiceStatus === 'MATCHED' && matchStatus === 'PASSED' && codes.length === 0) {
    const stp = policy.autoReadyForPaymentMaxAmount === null || amount.lte(money(policy.autoReadyForPaymentMaxAmount));
    return { route: stp ? 'STP' : 'CLEAN_FINANCE', requiredRoles: [] as string[], requiresFinanceApproval: !stp };
  }
  if (invoiceStatus === 'EXCEPTION' && matchStatus === 'REVIEW_REQUIRED') {
    return { route: 'EXCEPTION_REVIEW', requiredRoles: requiredRoles(codes), requiresFinanceApproval: amount.gte(threshold) };
  }
  throw new WorkflowError('INVALID_INVOICE_STATE', 'Only MATCHED/PASSED or EXCEPTION/REVIEW_REQUIRED invoices may start workflow.', 409);
}
export function policySnapshot(policy: WorkflowPolicy) { return { ...policy, ruleVersion: 'WF-1.0', financeComparison: '>=' }; }
export function outcome(action: string) {
  if (action === 'REJECT') return { caseStatus: 'REJECTED', invoiceStatus: 'REJECTED', events: ['APPROVAL_CASE_REJECTED', 'INVOICE_REJECTED'] };
  if (action === 'REQUEST_CREDIT_NOTE') return { caseStatus: 'CREDIT_NOTE_REQUESTED', invoiceStatus: 'EXCEPTION', events: ['VENDOR_CREDIT_NOTE_REQUESTED'] };
  if (['APPROVE', 'APPROVE_WITH_ADJUSTMENT'].includes(action)) return { caseStatus: 'APPROVED', invoiceStatus: 'READY_FOR_PAYMENT',
    events: ['APPROVAL_CASE_APPROVED', 'INVOICE_APPROVED', 'INVOICE_READY_FOR_PAYMENT'] };
  throw new WorkflowError('INVALID_TASK_ACTION', 'Unsupported workflow action.', 400);
}

