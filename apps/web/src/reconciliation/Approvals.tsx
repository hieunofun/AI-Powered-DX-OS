import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import type { ProcurementApi } from '../procurement/api';
import { DateText, ErrorNotice, Field, Loading, Status, useResource } from '../procurement/common';
import { decimal } from '../procurement/decimal';
import { actions, MatchEvidence, roles } from './common';
import type { ApprovalTask } from './types';

export function TaskList({ api }: { api: ProcurementApi }) {
  const resource = useResource(useCallback((signal: AbortSignal) => api.myTasks(signal), [api]));
  return <><header className="page-heading"><div><p className="eyebrow">PHÊ DUYỆT</p><h1>Nhiệm vụ của tôi</h1><p>Nhiệm vụ đang mở hoặc đã nhận theo vai trò và tài khoản hiện tại.</p></div><button onClick={resource.reload}>Làm mới</button></header>
    <section className="panel">{resource.loading && <Loading />}{!!resource.error && <ErrorNotice error={resource.error} retry={resource.reload} />}
      {resource.data && (!resource.data.length ? <p className="empty">Không có nhiệm vụ đang chờ bạn xử lý.</p> : <div className="table-scroll" tabIndex={0} aria-label="Nhiệm vụ phê duyệt"><table><thead><tr><th>Nhiệm vụ</th><th>Bộ phận</th><th>Trạng thái</th><th>Hồ sơ</th></tr></thead>
        <tbody>{resource.data.map(task => <tr key={task.id}><td><strong>{task.taskName}</strong><small>{task.assigneeSubject ? 'Đã có người nhận' : 'Chưa có người nhận'}</small></td><td>{roles[task.assignedRole] || task.assignedRole}</td><td><Status value={task.status} /></td>
          <td><a className="record-link" href={`#/approvals/${task.approvalCaseId}`}>Xem và xử lý</a></td></tr>)}</tbody></table></div>)}
    </section><p className="footnote">Hiển thị tối đa 200 nhiệm vụ theo API hiện tại. Hoàn thành nhiệm vụ để tiếp tục bước kế tiếp; một hồ sơ có thể cần nhiều bộ phận duyệt.</p></>;
}

function TaskDecision({ api, task, override, close, done }: { api: ProcurementApi; task: ApprovalTask; override: boolean; close: () => void; done: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [action, setAction] = useState('APPROVE'); const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>();
  useEffect(() => { const node = dialog.current; const previous = trigger.current; node?.showModal(); return () => { node?.close(); if (previous?.isConnected) previous.focus(); }; }, []);
  return <dialog ref={dialog} className="confirm-dialog" aria-labelledby="decision-title" onCancel={e => { e.preventDefault(); if (!busy) close(); }}>
    <form onSubmit={async e => { e.preventDefault(); if (busy || !reason.trim()) return; setBusy(true); setError(undefined);
      try { await api.completeTask(task.id, action, reason.trim()); close(); done(); } catch (failure) { setError(failure); } finally { setBusy(false); } }}>
      <h2 id="decision-title">Quyết định xử lý</h2><p>{override ? 'Bạn đang xử lý bằng quyền quản trị thay người nhận nhiệm vụ. Thao tác này được ghi nhận trong hồ sơ.' : 'Quyết định được lưu cùng lý do và tài khoản thực hiện.'} Phê duyệt kèm giải trình không tự sửa số tiền hóa đơn.</p>
      <Field id="decision-action" label="Quyết định"><select id="decision-action" disabled={busy} value={action} onChange={e => setAction(e.target.value)}>{Object.entries(actions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      <Field id="decision-reason" label="Lý do quyết định" hint="Bắt buộc trên màn hình này; tối đa 2.000 ký tự."><textarea id="decision-reason" required maxLength={2000} disabled={busy} value={reason} onChange={e => setReason(e.target.value)} aria-describedby="decision-reason-hint" /></Field>
      {!!error && <ErrorNotice error={error} />}<div className="actions"><button type="button" disabled={busy} onClick={close}>Quay lại</button><button className={action === 'REJECT' ? 'danger' : 'primary'} disabled={busy || !reason.trim()}>{busy ? 'Đang xử lý…' : 'Xác nhận quyết định'}</button></div>
    </form></dialog>;
}

export function ApprovalDetail({ api, id }: { api: ProcurementApi; id: string }) {
  const { user, hasAnyRole } = useAuth(); const [selected, setSelected] = useState<ApprovalTask>();
  const [busy, setBusy] = useState(''); const [error, setError] = useState<unknown>();
  const resource = useResource(useCallback(async (signal: AbortSignal) => {
    const approval = await api.approvalCase(id, signal);
    const [tasks, match] = await Promise.all([api.caseTasks(id, signal), api.matchResult(approval.matchResultId, signal)]);
    return { approval, tasks, match };
  }, [api, id]));
  if (resource.loading) return <Loading />; if (resource.error) return <ErrorNotice error={resource.error} retry={resource.reload} />;
  if (!resource.data) return null;
  const { approval, tasks, match } = resource.data;
  const admin = hasAnyRole(['admin']); const policy = approval.matchSnapshot.workflowPolicySnapshot;
  return <><a className="back-link" href="#/tasks">← Nhiệm vụ của tôi</a><header className="page-heading"><div><p className="eyebrow">PHÊ DUYỆT</p><h1>Hồ sơ xử lý sai lệch</h1><p><Status value={approval.status} /> · {approval.caseType === 'CLEAN_FINANCE' ? 'Hóa đơn khớp, cần duyệt tài chính' : 'Sai lệch cần bộ phận kiểm tra'}</p></div><button onClick={resource.reload} disabled={!!busy}>Làm mới</button></header>
    <div className="actions evidence-copy">{hasAnyRole(['accountant', 'finance_manager', 'buyer', 'admin']) && <a className="button" href={`#/invoices/${approval.invoiceId}`}>Xem hóa đơn</a>}
      <a className="button" href={`#/orders/${match.purchaseOrderId}`}>Xem PO</a>{hasAnyRole(['accountant', 'finance_manager', 'admin']) && <a className="button" href={`#/audit/${approval.invoiceId}`}>Kiểm chứng hồ sơ</a>}</div>
    {!!error && <ErrorNotice error={error} retry={() => { setError(undefined); resource.reload(); }} />}
    {approval.invoiceStatus === 'READY_FOR_PAYMENT' && <p className="notice notice-success">Đã đủ điều kiện chuyển sang bước thanh toán; chưa có xác nhận chuyển tiền.</p>}
    {approval.status === 'CREDIT_NOTE_REQUESTED' && <p className="notice">Đã ghi nhận yêu cầu điều chỉnh hóa đơn. Hệ thống chưa tự gửi yêu cầu cho nhà cung cấp.</p>}
    {['FAILED', 'STARTING'].includes(approval.status) && <p className="notice notice-error">Luồng xử lý chưa được xác nhận hoàn tất. Quản trị viên cần kiểm tra và đối chiếu trạng thái trước khi tiếp tục.</p>}
    <section className="panel metadata"><div><small>Bước hiện tại</small><strong>{approval.assignedRole ? roles[approval.assignedRole] || approval.assignedRole : 'Đã kết thúc'}</strong><span>{approval.currentStage}</span></div>
      {policy ? <><div><small>Ngưỡng cần duyệt tài chính</small><strong>{decimal(policy.financeApprovalThreshold)}</strong><span>{approval.matchSnapshot.requiresFinanceApproval === true ? 'Cần duyệt tài chính' : approval.matchSnapshot.requiresFinanceApproval === false ? 'Không cần bước tài chính' : 'Chưa có bằng chứng về bước tài chính'}</span></div>
        <div><small>Giới hạn tự động STP tại lúc bắt đầu</small><strong>{policy.autoReadyForPaymentMaxAmount === null ? 'Không giới hạn hóa đơn khớp' : decimal(policy.autoReadyForPaymentMaxAmount)}</strong></div></>
        : <p className="notice">Hồ sơ chưa có bản chụp chính sách workflow. Cần kiểm tra hồ sơ trước khi quyết định.</p>}</section>
    <section className="panel"><div className="section-heading"><h2>Nhiệm vụ trong hồ sơ</h2><span>{tasks.length} bước đã tạo</span></div>
      <div className="task-cards">{tasks.map(task => { const active = approval.status === 'PENDING' && ['OPEN', 'CLAIMED'].includes(task.status);
        const allowed = admin || hasAnyRole([task.assignedRole]); const owned = task.status === 'CLAIMED' && task.assigneeSubject === user?.sub;
        return <article key={task.id}><div><h3>{task.taskName}</h3><p>{roles[task.assignedRole] || task.assignedRole} · <Status value={task.status} /></p>
          <small>{owned ? 'Bạn đã nhận nhiệm vụ này' : task.assigneeSubject ? 'Nhiệm vụ đã được người khác nhận' : 'Chưa có người nhận'}</small>
          {task.action && <p>{actions[task.action] || task.action}: {task.actionReason || 'Không có lý do ghi nhận'}</p>}</div><div className="actions">
          {active && allowed && task.status === 'OPEN' && <button disabled={!!busy} onClick={async () => { if (busy) return; setBusy(task.id); setError(undefined); try { await api.claimTask(task.id); resource.reload(); } catch (failure) { setError(failure); } finally { setBusy(''); } }}>{busy === task.id ? 'Đang nhận…' : 'Nhận nhiệm vụ'}</button>}
          {active && allowed && (owned || admin) && <button className="primary" disabled={!!busy} onClick={() => setSelected(task)}>{admin && !owned ? 'Xử lý bằng quyền quản trị' : 'Ra quyết định'}</button>}
        </div></article>; })}</div></section>
    <MatchEvidence match={match} /><section className="panel"><div className="section-heading"><h2>Lịch sử quyết định</h2></div>
      {!approval.decisions?.length ? <p className="empty">Chưa có quyết định hoàn tất.</p> : <ol className="decision-history">{approval.decisions.map(decision => <li key={decision.id}><strong>{actions[decision.action] || decision.action}</strong><p>{decision.reason || 'Không có lý do ghi nhận'}</p><small><DateText value={decision.createdAt} /> · Chủ thể: <span className="hash-value">{decision.actorSubject}</span></small></li>)}</ol>}</section>
    {selected && <TaskDecision api={api} task={selected} override={admin && selected.assigneeSubject !== user?.sub} close={() => setSelected(undefined)} done={resource.reload} />}
  </>;
}
