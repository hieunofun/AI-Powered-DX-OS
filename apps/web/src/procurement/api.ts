import type { Fulfillment, GoodsReceipt, GrnInput, PageResult, PoInput, PurchaseOrder, Supplier } from './types';
import type { ApprovalCase, ApprovalTask, AuditDetail, IngestResult, Ingestion, Invoice, InvoiceFile, InvoicePage, MatchResult, Verification, VerificationStatus, WorkflowResult } from '../reconciliation/types';

export class ApiError extends Error {
  constructor(public status: number, public details: string[], public code?: string, public ingestionId?: string) {
    super(code?.startsWith('WORKFLOW_') && (status >= 500 || code === 'WORKFLOW_RECONCILIATION_REQUIRED') ? 'Chưa xác nhận được trạng thái luồng xử lý. Tải lại hồ sơ và nhờ quản trị viên kiểm tra thao tác đang chờ trước khi gửi lại quyết định.'
      : status === 401 ? 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Hãy đăng nhập lại.'
      : status === 403 ? 'Tài khoản không có quyền thực hiện thao tác này.'
      : status === 409 ? 'Hồ sơ đã thay đổi hoặc thao tác không còn hợp lệ. Tải lại hồ sơ để kiểm tra trước khi tiếp tục.'
      : status === 429 ? 'Có quá nhiều yêu cầu. Chờ một lúc rồi thử lại.'
      : status >= 500 ? 'Máy chủ chưa xử lý được yêu cầu. Hãy thử lại.'
      : 'Không thể hoàn thành yêu cầu. Kiểm tra thông tin bên dưới.');
  }
}

export function createApi(getToken: () => Promise<string | undefined>) {
  const base = (import.meta.env?.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
  async function send(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<Response> {
    const token = await getToken();
    if (!token) throw new ApiError(401, []);
    let response: Response;
    try {
      response = await fetch(`${base}/${path}`, {
        method, signal,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined || body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error('Không kết nối được máy chủ. Kiểm tra kết nối và thử lại.');
    }
    return response;
  }
  function failure(response: Response, data: unknown): never {
      const message = data && typeof data === 'object' && 'message' in data ? data.message : null;
      const details = typeof message === 'string' ? [message]
        : Array.isArray(message) ? message.filter((v): v is string => typeof v === 'string') : [];
      // Do not expose infrastructure error details to product users.
      const code = data && typeof data === 'object' && 'errorCode' in data && typeof data.errorCode === 'string' ? data.errorCode : undefined;
      const ingestionId = data && typeof data === 'object' && 'ingestionId' in data && typeof data.ingestionId === 'string' ? data.ingestionId : undefined;
      throw new ApiError(response.status, response.status < 500 ? details : [], code, ingestionId);
  }
  async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await send(path, method, body, signal);
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) failure(response, data);
    if (data === null) throw new Error('Máy chủ trả về dữ liệu không hợp lệ. Tải lại hồ sơ trước khi tiếp tục.');
    return data as T;
  }
  async function verify(id: string): Promise<Verification> {
    const response = await send(`audit/invoices/${id}/verify`);
    const data = await response.json().catch(() => null);
    if (!response.ok && !(response.status === 503 && data?.verificationStatus === 'UNAVAILABLE' && data?.invoiceId === id)) failure(response, data);
    const checks = ['sourceSnapshotMatchesPackage', 'packageHashMatches', 'merkleRootMatches', 'immudbEntryMatches', 'immudbCryptographicProofValid'];
    if (data?.invoiceId !== id || !['VERIFIED', 'TAMPERED', 'LEDGER_MISMATCH', 'UNAVAILABLE'].includes(data?.verificationStatus) || typeof data?.verifiedAt !== 'string' || checks.some(key => typeof data[key] !== 'boolean') ||
      (data.verificationStatus === 'VERIFIED' && checks.some(key => data[key] !== true))) throw new Error('Kết quả kiểm chứng không đầy đủ hoặc mâu thuẫn. Hồ sơ chưa được xác nhận hợp lệ.');
    return data as Verification;
  }
  async function report(id: string, kind: 'json' | 'pdf') {
    const response = await send(`audit/invoices/${id}/report.${kind}`);
    const type = response.headers.get('content-type') || '';
    const status = response.headers.get('x-audit-verification-status');
    const knownStatus = ['VERIFIED', 'TAMPERED', 'LEDGER_MISMATCH', 'UNAVAILABLE'].includes(status || '');
    if ((!response.ok && !(response.status === 503 && status === 'UNAVAILABLE')) || !knownStatus || !type.includes(kind === 'pdf' ? 'application/pdf' : 'application/json')) {
      failure(response, await response.json().catch(() => null));
    }
    const blob = await response.blob();
    if (kind === 'json') {
      const report = JSON.parse(await blob.text());
      if (report.invoiceId !== id || report.verificationStatus !== status) throw new Error('Báo cáo không khớp hóa đơn hoặc kết quả kiểm chứng.');
    } else if (!(await blob.slice(0, 5).text()).startsWith('%PDF-')) throw new Error('Máy chủ chưa trả về báo cáo PDF hợp lệ.');
    return { blob, status: status as VerificationStatus };
  }
  const query = (values: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams();
    Object.entries(values).forEach(([key, value]) => { if (value !== undefined && value !== '') params.set(key, String(value)); });
    return params.toString();
  };
  return {
    orders: (values: Record<string, string | number | undefined>, signal?: AbortSignal) => request<PageResult<PurchaseOrder>>(`purchase-orders?${query(values)}`, 'GET', undefined, signal),
    order: (id: string, signal?: AbortSignal) => request<PurchaseOrder>(`purchase-orders/${id}`, 'GET', undefined, signal),
    fulfillment: (id: string, signal?: AbortSignal) => request<Fulfillment[]>(`purchase-orders/${id}/fulfillment`, 'GET', undefined, signal),
    suppliers: (values: Record<string, string | number | undefined>, signal?: AbortSignal) => request<PageResult<Supplier>>(`purchase-orders/suppliers?${query(values)}`, 'GET', undefined, signal),
    createOrder: (body: PoInput) => request<PurchaseOrder>('purchase-orders', 'POST', body),
    updateOrder: (id: string, body: PoInput, version: number) => request<PurchaseOrder>(`purchase-orders/${id}`, 'PATCH', { ...body, expectedDeliveryDate: body.expectedDeliveryDate || null, expectedVersion: version }),
    issueOrder: (id: string, version: number) => request<PurchaseOrder>(`purchase-orders/${id}/issue`, 'POST', { expectedVersion: version }),
    cancelOrder: (id: string, version: number, reason: string) => request<PurchaseOrder>(`purchase-orders/${id}/cancel`, 'POST', { expectedVersion: version, reason }),
    receipts: (values: Record<string, string | number | undefined>, signal?: AbortSignal) => request<PageResult<GoodsReceipt>>(`goods-receipts?${query(values)}`, 'GET', undefined, signal),
    receipt: (id: string, signal?: AbortSignal) => request<GoodsReceipt>(`goods-receipts/${id}`, 'GET', undefined, signal),
    createReceipt: (body: GrnInput) => request<GoodsReceipt>('goods-receipts', 'POST', body),
    updateReceipt: (id: string, body: GrnInput) => {
      const draft = { receivedAt: body.receivedAt, referenceNote: body.referenceNote, items: body.items };
      return request<GoodsReceipt>(`goods-receipts/${id}`, 'PATCH', draft);
    },
    receive: (id: string) => request<{ grn: GoodsReceipt; poStatus: string; poVersion: number }>(`goods-receipts/${id}/receive`, 'POST'),
    cancelReceipt: (id: string, reason: string) => request<{ grn: GoodsReceipt }>(`goods-receipts/${id}/cancel`, 'POST', { reason }),
    invoices: (values: Record<string, string | number | undefined>, signal?: AbortSignal) => request<InvoicePage>(`invoices?${query(values)}`, 'GET', undefined, signal),
    invoice: (id: string, signal?: AbortSignal) => request<Invoice>(`invoices/${id}`, 'GET', undefined, signal),
    invoiceFiles: (id: string, signal?: AbortSignal) => request<InvoiceFile[]>(`invoices/${id}/files`, 'GET', undefined, signal),
    ingest: (body: FormData) => request<IngestResult>('invoices/ingest', 'POST', body),
    ingestion: (id: string, signal?: AbortSignal) => request<Ingestion>(`invoice-ingestions/${id}`, 'GET', undefined, signal),
    match: (id: string) => request<MatchResult>(`invoices/${id}/match`, 'POST'),
    matchResult: (id: string, signal?: AbortSignal) => request<MatchResult>(`match-results/${id}`, 'GET', undefined, signal),
    invoiceMatch: (id: string, signal?: AbortSignal) => request<MatchResult>(`invoices/${id}/match-result`, 'GET', undefined, signal),
    startWorkflow: (id: string) => request<WorkflowResult>(`invoices/${id}/workflow/start`, 'POST'),
    invoiceCase: (id: string, signal?: AbortSignal) => request<ApprovalCase>(`invoices/${id}/workflow`, 'GET', undefined, signal),
    approvalCase: (id: string, signal?: AbortSignal) => request<ApprovalCase>(`approval-cases/${id}`, 'GET', undefined, signal),
    caseTasks: (id: string, signal?: AbortSignal) => request<ApprovalTask[]>(`approval-cases/${id}/tasks`, 'GET', undefined, signal),
    myTasks: (signal?: AbortSignal) => request<ApprovalTask[]>('my-approval-tasks', 'GET', undefined, signal),
    claimTask: (id: string) => request<unknown>(`approval-tasks/${id}/claim`, 'POST'),
    completeTask: (id: string, action: string, reason?: string) => request<WorkflowResult>(`approval-tasks/${id}/complete`, 'POST', { action, ...(reason ? { reason } : {}) }),
    audit: (id: string, signal?: AbortSignal) => request<AuditDetail>(`audit/invoices/${id}`, 'GET', undefined, signal),
    sealAudit: (id: string) => request<unknown>(`audit/invoices/${id}/seal`, 'POST'),
    verify, report,
  };
}
export type ProcurementApi = ReturnType<typeof createApi>;
