import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useAuth } from './auth/AuthContext';
import { createApi } from './procurement/api';
import { OrderDetail, OrderEditor, OrderList } from './procurement/Orders';
import { ReceiptDetail, ReceiptEditor, ReceiptList } from './procurement/Receipts';
import './App.css';

const Diagnostics = lazy(() => import('./Diagnostics'));
const InvoiceList = lazy(() => import('./reconciliation/Invoices').then(module => ({ default: module.InvoiceList })));
const InvoiceUpload = lazy(() => import('./reconciliation/Invoices').then(module => ({ default: module.InvoiceUpload })));
const InvoiceDetail = lazy(() => import('./reconciliation/Invoices').then(module => ({ default: module.InvoiceDetail })));
const IngestionDetail = lazy(() => import('./reconciliation/Invoices').then(module => ({ default: module.IngestionDetail })));
const TaskList = lazy(() => import('./reconciliation/Approvals').then(module => ({ default: module.TaskList })));
const ApprovalDetail = lazy(() => import('./reconciliation/Approvals').then(module => ({ default: module.ApprovalDetail })));
const AuditWorkspace = lazy(() => import('./reconciliation/Audit').then(module => ({ default: module.AuditWorkspace })));
const roleNames: Record<string, string> = { buyer: 'Mua hàng', warehouse: 'Kho', accountant: 'Kế toán', finance_manager: 'Tài chính', admin: 'Quản trị viên' };

function Icon({ kind }: { kind: 'order' | 'receipt' | 'invoice' | 'task' | 'audit' | 'settings' }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'order' ? <path d="M8 4H5v17h14V4h-3M9 2h6v4H9zM8 11h8M8 15h5" />
      : kind === 'receipt' ? <path d="M3 7l9-5 9 5-9 5-9-5zm0 0v10l9 5 9-5V7M12 12v10M7 5l10 5" />
        : kind === 'invoice' ? <path d="M5 3h14v18l-3-2-4 2-4-2-3 2V3zM8 8h8M8 12h5" />
          : kind === 'task' ? <path d="M9 5h11M9 12h11M9 19h11M2 5l2 2 3-4M2 12l2 2 3-4M2 19l2 2 3-4" />
            : kind === 'audit' ? <path d="M12 2l8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4zM8 12l3 3 5-6" />
        : <><circle cx="12" cy="12" r="3" /><path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3z" /></>}
  </svg>;
}

export default function App() {
  const { isAuthenticated, isLoading, user, roles, hasAnyRole, login, logout, getToken } = useAuth();
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/orders');
  const [authError, setAuthError] = useState('');
  useEffect(() => {
    const update = () => setRoute(window.location.hash.slice(1) || '/orders');
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  // Keycloak cleans its callback with replaceState, which does not emit hashchange.
  useEffect(() => {
    if (!isLoading) setRoute(window.location.hash.slice(1) || '/orders');
  }, [isLoading]);
  const api = useMemo(() => createApi(getToken), [getToken]);
  const url = new URL(route.startsWith('/') ? route : '/orders', window.location.origin);
  const parts = url.pathname.split('/').filter(Boolean);
  const section = parts[0];
  const canRead = hasAnyRole(['buyer', 'warehouse', 'accountant', 'finance_manager', 'admin']);
  const canInvoice = hasAnyRole(['buyer', 'accountant', 'finance_manager', 'admin']);
  const canAudit = hasAnyRole(['accountant', 'finance_manager', 'admin']);
  const authAction = async (action: () => Promise<void>) => {
    try { setAuthError(''); await action(); } catch { setAuthError('Không kết nối được dịch vụ đăng nhập. Hãy thử lại.'); }
  };
  if (isLoading) return <main className="auth-page"><p role="status">Đang kiểm tra phiên đăng nhập…</p></main>;
  if (!isAuthenticated) return <main className="auth-page"><div className="auth-card">
    <div className="brand-mark" aria-hidden="true">S</div><p className="eyebrow">SMARTPROCURE PAY</p>
    <h1>Hồ sơ mua sắm,<br />trong một nơi.</h1><p>Tạo đơn đặt hàng, kiểm nhận từng lần giao và theo dõi hồ sơ theo đúng vai trò của bạn.</p>
    <button className="primary" onClick={() => void authAction(login)}>Đăng nhập để làm việc →</button>
    {authError && <p className="notice notice-error" role="alert">{authError}</p>}
    <div className="auth-steps"><span>01 · Đặt hàng</span><span>02 · Kiểm nhận</span><span>03 · Đối soát</span></div>
  </div><p className="auth-caption">SmartProcure-Pay · OLP PMNM 2026</p></main>;
  let content;
  if (!canRead) content = <p className="notice">Tài khoản chưa được cấp quyền truy cập hồ sơ mua sắm. Liên hệ quản trị viên để được phân vai trò.</p>;
  else if (section === 'orders' && parts[1] === 'new') content = <OrderEditor api={api} />;
  else if (section === 'orders' && parts[1] && parts[2] === 'edit') content = <OrderEditor api={api} id={parts[1]} />;
  else if (section === 'orders' && parts[1]) content = <OrderDetail api={api} id={parts[1]} />;
  else if (section === 'orders') content = <OrderList api={api} />;
  else if (section === 'receipts' && parts[1] === 'new') content = <ReceiptEditor api={api} poId={url.searchParams.get('po') || undefined} />;
  else if (section === 'receipts' && parts[1] && parts[2] === 'edit') content = <ReceiptEditor api={api} id={parts[1]} />;
  else if (section === 'receipts' && parts[1]) content = <ReceiptDetail api={api} id={parts[1]} />;
  else if (section === 'receipts') content = <ReceiptList api={api} poId={url.searchParams.get('po') || undefined} />;
  else if (section === 'invoices' && canInvoice && parts[1] === 'new') content = <InvoiceUpload api={api} poId={url.searchParams.get('po') || undefined} />;
  else if (section === 'invoices' && canInvoice && parts[1]) content = <InvoiceDetail api={api} id={parts[1]} />;
  else if (section === 'invoices' && canInvoice) content = <InvoiceList api={api} poId={url.searchParams.get('po') || undefined} />;
  else if (section === 'ingestions' && canInvoice && parts[1]) content = <IngestionDetail api={api} id={parts[1]} />;
  else if (section === 'tasks') content = <TaskList api={api} />;
  else if (section === 'approvals' && parts[1]) content = <ApprovalDetail api={api} id={parts[1]} />;
  else if (section === 'audit' && canAudit && parts[1]) content = <AuditWorkspace api={api} id={parts[1]} />;
  else if (section === 'audit' && canAudit) content = <InvoiceList api={api} audit />;
  else if (section === 'diagnostics' && roles.includes('admin')) content = <Suspense fallback={<p role="status">Đang tải…</p>}><div className="diagnostics"><Diagnostics /></div></Suspense>;
  else content = <p className="notice">Không tìm thấy màn hình hoặc bạn chưa có quyền truy cập. <a href="#/orders">Về đơn đặt hàng</a></p>;
  return <div className="app-shell">
    <a className="skip-link" href="#workspace" onClick={e => { e.preventDefault(); document.getElementById('workspace')?.focus(); }}>Đến nội dung chính</a>
    <aside className="sidebar"><a className="brand" href="#/orders"><span className="brand-mark">S</span><span>SmartProcure<small>PAY WORKSPACE</small></span></a>
      <p className="nav-label">KHÔNG GIAN LÀM VIỆC</p><nav aria-label="Điều hướng chính">
        <a className={section === 'orders' ? 'active' : ''} aria-current={section === 'orders' ? 'page' : undefined} href="#/orders"><Icon kind="order" />Đơn đặt hàng</a>
        <a className={section === 'receipts' ? 'active' : ''} aria-current={section === 'receipts' ? 'page' : undefined} href="#/receipts"><Icon kind="receipt" />Phiếu nhận hàng</a>
        {canInvoice && <a className={['invoices', 'ingestions'].includes(section) ? 'active' : ''} aria-current={['invoices', 'ingestions'].includes(section) ? 'page' : undefined} href="#/invoices"><Icon kind="invoice" />Hóa đơn</a>}
        <a className={['tasks', 'approvals'].includes(section) ? 'active' : ''} aria-current={['tasks', 'approvals'].includes(section) ? 'page' : undefined} href="#/tasks"><Icon kind="task" />Nhiệm vụ phê duyệt</a>
        {canAudit && <a className={section === 'audit' ? 'active' : ''} aria-current={section === 'audit' ? 'page' : undefined} href="#/audit"><Icon kind="audit" />Hồ sơ kiểm toán</a>}
        {roles.includes('admin') && <a className={section === 'diagnostics' ? 'active' : ''} aria-current={section === 'diagnostics' ? 'page' : undefined} href="#/diagnostics"><Icon kind="settings" />Chẩn đoán hệ thống</a>}
      </nav><div className="sidebar-bottom"><strong>Smart Procure-to-Pay</strong><span>OLP PMNM 2026</span></div>
    </aside>
    <div className="workspace"><header className="topbar"><div>Không gian mua sắm</div><div className="account"><span className="avatar" aria-hidden="true">{(user?.name || user?.username || 'U').slice(0, 1).toUpperCase()}</span>
      <div><strong>{user?.name || user?.username}</strong><small>{roles.map(role => roleNames[role] || role).join(' · ')}</small></div><button onClick={() => void authAction(logout)}>Đăng xuất</button></div></header>
      {authError && <p className="notice notice-error" role="alert">{authError}</p>}
      <main id="workspace" className="workspace-main" tabIndex={-1} key={route}><Suspense fallback={<p role="status">Đang tải màn hình…</p>}>{content}</Suspense></main>
    </div>
  </div>;
}
