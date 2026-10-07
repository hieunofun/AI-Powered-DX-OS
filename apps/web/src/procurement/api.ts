import type { Fulfillment, GoodsReceipt, GrnInput, PageResult, PoInput, PurchaseOrder, Supplier } from './types';

export class ApiError extends Error {
  constructor(public status: number, public details: string[]) {
    super(status === 401 ? 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Hãy đăng nhập lại.'
      : status === 403 ? 'Tài khoản không có quyền thực hiện thao tác này.'
      : status === 409 ? 'Hồ sơ đã thay đổi hoặc thao tác không còn hợp lệ. Tải lại hồ sơ để kiểm tra trước khi tiếp tục.'
      : status === 429 ? 'Có quá nhiều yêu cầu. Chờ một lúc rồi thử lại.'
      : status >= 500 ? 'Máy chủ chưa xử lý được yêu cầu. Hãy thử lại.'
      : 'Không thể hoàn thành yêu cầu. Kiểm tra thông tin bên dưới.');
  }
}

export function createApi(getToken: () => Promise<string | undefined>) {
  const base = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');
  async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    const token = await getToken();
    if (!token) throw new ApiError(401, []);
    let response: Response;
    try {
      response = await fetch(`${base}/${path}`, {
        method, signal,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error('Không kết nối được máy chủ. Kiểm tra kết nối và thử lại.');
    }
    if (!response.ok) {
      const data: unknown = await response.json().catch(() => null);
      const message = data && typeof data === 'object' && 'message' in data ? data.message : null;
      const details = typeof message === 'string' ? [message]
        : Array.isArray(message) ? message.filter((v): v is string => typeof v === 'string') : [];
      // Do not expose infrastructure error details to product users.
      throw new ApiError(response.status, response.status < 500 ? details : []);
    }
    return response.json() as Promise<T>;
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
  };
}
export type ProcurementApi = ReturnType<typeof createApi>;
