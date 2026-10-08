import type { PageResult } from '../procurement/types';

export interface InvoiceLine {
  id: string; lineNumber: number; poItemId: string | null; sku: string | null; description: string;
  quantity: string; unitPrice: string; taxRate: string; lineSubtotal: string; taxAmount: string; lineTotal: string;
}
export interface Invoice {
  id: string; invoiceNumber: string; purchaseOrderId: string; supplierId: string; invoiceDate: string;
  currency: string; status: string; sellerTaxCode: string; buyerTaxCode: string;
  subtotal: string; taxAmount: string; totalAmount: string; items?: InvoiceLine[];
}
export interface InvoiceFile {
  id: string; fileKind: string; originalFilename: string; sizeBytes: string; sha256: string;
  processingStatus: string; parseErrorCode?: string;
}
export interface Ingestion {
  id: string; purchaseOrderId: string; invoiceId: string | null; status: string; errorCode?: string; files?: InvoiceFile[];
}
export interface IngestResult { ingestionId: string; invoiceId: string | null; status: string; reason?: string; files: InvoiceFile[] }
export interface MatchLine {
  id: string; invoiceItemId: string; purchaseOrderItemId: string | null; lineNumber: number;
  status: string; discrepancyCodes: string[]; matchedReceivedQuantity: string; quantityVariance: string;
  unitPriceVariance: string; taxRateVariance: string; lineTotalVariance: string;
  details: {
    invoiceDescription?: string; invoiceSku?: string; invoiceQuantity?: string;
    poDescription?: string; poSku?: string; orderedQuantity?: string; cumulativeAcceptedReceived?: string;
    previousValidInvoicedQuantity?: string; availableToInvoice?: string;
    price?: { invoiceUnitPrice: string; poUnitPrice: string };
    tax?: { invoiceTaxRate: string; poTaxRate: string };
  };
}
export interface MatchResult {
  id: string; invoiceId: string; purchaseOrderId: string; status: string; invoiceStatus: string;
  discrepancyCodes: string[]; ruleVersion: string; completedAt: string;
  policySnapshot: { policyCode: string; quantityTolerancePercent: string; priceTolerancePercent: string;
    taxTolerancePercent: string; totalTolerancePercent: string };
  items: MatchLine[];
}
export interface ApprovalTask {
  id: string; approvalCaseId: string; taskName: string; taskKey: string; assignedRole: string;
  assigneeSubject: string | null; status: string; action: string | null; actionReason: string | null;
}
export interface Decision { id: string; action: string; reason: string | null; actorSubject: string; createdAt: string }
export interface ApprovalCase {
  id: string; invoiceId: string; matchResultId: string; caseType: string; status: string; invoiceStatus: string;
  currentStage: string; assignedRole: string | null; decision: string | null; decisionReason: string | null;
  matchSnapshot: { requiredRoles: string[]; requiresFinanceApproval: boolean;
    workflowPolicySnapshot: { autoReadyForPaymentMaxAmount: string | null; financeApprovalThreshold: string } };
  decisions?: Decision[];
}
export interface WorkflowResult { route?: string; invoiceStatus?: string; approvalCaseId?: string }
export type VerificationStatus = 'VERIFIED' | 'TAMPERED' | 'LEDGER_MISMATCH' | 'UNAVAILABLE';
export interface Verification {
  invoiceId: string; verificationStatus: VerificationStatus; verifiedAt: string; sealedRoot: string; currentRoot: string | null;
  sourceSnapshotMatchesPackage: boolean; packageHashMatches: boolean; merkleRootMatches: boolean;
  immudbEntryMatches: boolean; immudbCryptographicProofValid: boolean; immudbTxId: string | null;
}
export interface AuditDetail { pkg: { merkle_root: string; package_sha256: string; final_business_state: string; leaf_count: number };
  seal: { status: string; last_verification_status: string | null; immudb_tx_id: string | null } }
export type InvoicePage = PageResult<Invoice>;
