import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from './api';

export const statusNames: Record<string, string> = {
  DRAFT: 'Bản nháp', ISSUED: 'Đã phát hành', PARTIALLY_RECEIVED: 'Nhận một phần',
  FULLY_RECEIVED: 'Đã nhận đủ', CLOSED: 'Đã đóng', CANCELLED: 'Đã hủy', RECEIVED: 'Đã xác nhận',
  PARSED: 'Đã bóc tách', PENDING_MATCH: 'Đang đối soát', MATCHED: 'Đã khớp', EXCEPTION: 'Cần xử lý sai lệch',
  APPROVED: 'Đã phê duyệt', READY_FOR_PAYMENT: 'Sẵn sàng thanh toán', REJECTED: 'Đã từ chối',
  PASSED: 'Đạt chính sách', REVIEW_REQUIRED: 'Cần kiểm tra', MISMATCHED: 'Có sai lệch',
  PENDING_UPLOAD: 'Chờ lưu tệp', STORED: 'Đã lưu tệp', OCR_REQUIRED: 'Chờ OCR', FAILED: 'Thất bại',
  STARTING: 'Đang khởi tạo', PENDING: 'Chờ xử lý', OPEN: 'Chưa nhận', CLAIMED: 'Đã nhận nhiệm vụ',
  COMPLETED: 'Đã hoàn thành', CREDIT_NOTE_REQUESTED: 'Đã yêu cầu điều chỉnh', SEALED: 'Đã niêm phong',
};
export function Status({ value }: { value: string }) {
  return <span className={`status status-${value.toLowerCase()}`}>{statusNames[value] || value}</span>;
}
export function ErrorNotice({ error, retry }: { error: unknown; retry?: () => void }) {
  const { login } = useAuth();
  return <div className="notice notice-error" role="alert">
    <strong>{error instanceof Error ? error.message : 'Có lỗi khi xử lý yêu cầu.'}</strong>
    {error instanceof ApiError && error.details.length > 0 && <ul>{error.details.map((detail, i) => <li key={i}>{detail}</li>)}</ul>}
    <div className="actions">
      {error instanceof ApiError && error.status === 401 && <button onClick={() => void login()}>Đăng nhập lại</button>}
      {retry && <button onClick={retry}>Thử lại</button>}
    </div>
  </div>;
}
export function Loading() { return <p className="empty" role="status">Đang tải hồ sơ…</p>; }
export function DateText({ value }: { value?: string | null }) {
  if (!value) return <>—</>;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return <>{match ? `${match[3]}/${match[2]}/${match[1]}` : value}</>;
}
export function Pagination({ page, total, limit, onPage }: { page: number; total: number; limit: number; onPage: (page: number) => void }) {
  return <div className="pagination">
    <span>{total} hồ sơ · Trang {page}/{Math.max(1, Math.ceil(total / limit))}</span>
    <div className="actions"><button disabled={page <= 1} onClick={() => onPage(page - 1)}>Trước</button>
      <button disabled={page * limit >= total} onClick={() => onPage(page + 1)}>Sau</button></div>
  </div>;
}

export interface FieldError { id: string; message: string }
export function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: string; children: ReactNode }) {
  return <div className="field"><label htmlFor={id}>{label}</label>{children}
    {hint && <small id={`${id}-hint`}>{hint}</small>}
    {error && <small className="field-error" id={`${id}-error`}>{error}</small>}
  </div>;
}
export function ErrorSummary({ errors }: { errors: FieldError[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (errors.length) ref.current?.focus(); }, [errors]);
  if (!errors.length) return null;
  return <div className="notice notice-error" role="alert" tabIndex={-1} ref={ref}>
    <strong>Kiểm tra lại thông tin</strong><ul>{errors.map(error => <li key={error.id}>
      <a href={`#${error.id}`} onClick={event => { event.preventDefault(); document.getElementById(error.id)?.focus(); }}>{error.message}</a>
    </li>)}</ul>
  </div>;
}
export function inputAccessibility(id: string, errors: FieldError[]) {
  const error = errors.find(item => item.id === id);
  return { 'aria-invalid': !!error, 'aria-describedby': error ? `${id}-error` : undefined };
}

/** Warn before discarding a draft through reload, closing or a workspace link. */
export function useDraftGuard(value: unknown, busy: boolean) {
  const initial = useRef(JSON.stringify(value));
  const dirty = JSON.stringify(value) !== initial.current;
  useEffect(() => {
    if (!dirty || busy) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const beforeLink = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest('a') : null;
      if (target?.getAttribute('href')?.startsWith('#/') && !window.confirm('Có thay đổi chưa lưu. Rời màn hình và bỏ các thay đổi này?')) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', beforeLink, true);
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', beforeLink, true); };
  }, [dirty, busy]);
}

export function ConfirmAction({ title, explanation, reasonRequired = false, onConfirm, onClose }: {
  title: string; explanation: string; reasonRequired?: boolean;
  onConfirm: (reason: string) => Promise<void>; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const node = dialog.current;
    const trigger = returnFocus.current;
    node?.showModal();
    return () => {
      node?.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);
  return <dialog ref={dialog} className="confirm-dialog" aria-labelledby="confirm-title"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={async event => {
      event.preventDefault(); if (busy) return; setBusy(true); setError(null);
      try { await onConfirm(reason.trim()); onClose(); } catch (failure) { setError(failure); }
      finally { setBusy(false); }
    }}>
      <h2 id="confirm-title">{title}</h2><p>{explanation}</p>
      {reasonRequired && <Field id="cancel-reason" label="Lý do hủy"><textarea id="cancel-reason" required value={reason} onChange={e => setReason(e.target.value)} disabled={busy} /></Field>}
      {!!error && <ErrorNotice error={error} />}
      <div className="actions"><button type="button" onClick={onClose} disabled={busy}>Quay lại</button>
        <button className={reasonRequired ? 'danger' : 'primary'} disabled={busy || (reasonRequired && !reason.trim())}>
          {busy ? 'Đang xử lý…' : 'Xác nhận'}</button></div>
    </form>
  </dialog>;
}

/** Cancel obsolete reads, including role changes and rapid navigation. */
export function useResource<T>(loader: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true });
    loader(controller.signal).then(data => {
      if (!controller.signal.aborted) setState({ data, loading: false });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ error, loading: false });
    });
    return () => controller.abort();
  }, [loader, revision]);
  return { ...state, reload: () => setRevision(value => value + 1) };
}
