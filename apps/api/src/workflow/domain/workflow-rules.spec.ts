import { DISCREPANCY_ROLES, money, outcome, policySnapshot, requiredRoles, workflowRoute } from './workflow-rules';
const policy = { id: 'policy', policyCode: 'WORKFLOW_DEFAULT', financeApprovalThreshold: '100000000.00', autoReadyForPaymentMaxAmount: null };
describe('Workflow deterministic rules', () => {
  it.each(Object.entries(DISCREPANCY_ROLES))('%s routes to %s', (code, role) => expect(requiredRoles([code])).toEqual([role]));
  it('keeps all unique categories in warehouse/buyer/accountant order', () =>
    expect(requiredRoles(['TAX_MISMATCH','PRICE_MISMATCH','QUANTITY_MISMATCH','MISSING_GRN'])).toEqual(['warehouse','buyer','accountant']));
  it.each([{codes:[]}, {codes:['UNKNOWN']}, {codes:['toString']}])('fails closed for unsupported evidence %j', ({codes}) => expect(() => requiredRoles(codes)).toThrow());
  it('default clean STP ignores exception finance threshold', () =>
    expect(workflowRoute('MATCHED','PASSED','9999999999999999.99',policy,[])).toMatchObject({ route: 'STP' }));
  it.each(['99.99','100.00'])('STP includes configured cap boundary %s', total =>
    expect(workflowRoute('MATCHED','PASSED',total,{ ...policy, autoReadyForPaymentMaxAmount: '100.00' },[]).route).toBe('STP'));
  it('above configured cap requires clean finance', () =>
    expect(workflowRoute('MATCHED','PASSED','100.01',{ ...policy, autoReadyForPaymentMaxAmount: '100.00' },[])).toMatchObject({ route:'CLEAN_FINANCE', requiresFinanceApproval:true }));
  it.each([['99999999.99',false],['100000000.00',true],['100000000.01',true]])('exact finance boundary %s', (total, expected) =>
    expect(workflowRoute('EXCEPTION','REVIEW_REQUIRED',String(total),policy,['PRICE_MISMATCH']).requiresFinanceApproval).toBe(expected));
  it.each([['PARSED','PASSED'],['EXCEPTION','PASSED'],['MATCHED','REVIEW_REQUIRED'],['READY_FOR_PAYMENT','PASSED']])(
    'rejects inconsistent state %s/%s', (invoice, match) => expect(() => workflowRoute(invoice,match,'100',policy,[])).toThrow());
  it.each([NaN, Infinity, 'NaN','Infinity','-1','1e2','0.001','10000000000000000',100])('rejects invalid numeric evidence %j', value =>
    expect(() => money(value)).toThrow());
  it('snapshots policy values independently of subsequent changes', () => {
    const source = { ...policy }; const snapshot = policySnapshot(source); source.financeApprovalThreshold = '1';
    expect(snapshot.financeApprovalThreshold).toBe('100000000.00'); expect(snapshot.financeComparison).toBe('>=');
  });
  it.each(['APPROVE','APPROVE_WITH_ADJUSTMENT'])('%s preserves both invoice approval transitions as audit events', action =>
    expect(outcome(action)).toMatchObject({ invoiceStatus:'READY_FOR_PAYMENT',caseStatus:'APPROVED',events:expect.arrayContaining(['INVOICE_APPROVED','INVOICE_READY_FOR_PAYMENT']) }));
  it('credit-note request leaves invoice EXCEPTION', () => expect(outcome('REQUEST_CREDIT_NOTE')).toMatchObject({caseStatus:'CREDIT_NOTE_REQUESTED',invoiceStatus:'EXCEPTION'}));
  it('rejection never emits ready-for-payment', () => { expect(outcome('REJECT').invoiceStatus).toBe('REJECTED'); expect(outcome('REJECT').events).not.toContain('INVOICE_READY_FOR_PAYMENT'); });
  it('unsupported action is rejected', () => expect(() => outcome('PAY')).toThrow());
});

