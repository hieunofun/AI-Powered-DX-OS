import { useCallback, useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ApiError, type ProcurementApi } from './api';
import { ConfirmAction, DateText, ErrorNotice, ErrorSummary, Field, inputAccessibility, Loading, Pagination, Status, statusNames, useResource, useDraftGuard, type FieldError } from './common';
import { decimal, units, validDecimal } from './decimal';
import type { GoodsReceipt, GrnLineInput, PurchaseOrder } from './types';

export function ReceiptList({ api, poId }: { api: ProcurementApi; poId?: string }) {
  const { hasAnyRole } = useAuth();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState({ grnNumber: '', status: '', page: 1 });
  const load = useCallback((signal: AbortSignal) => api.receipts({ ...filter, purchaseOrderId: poId, limit: 20 }, signal), [api, filter, poId]);
  const result = useResource(load);
  return <>
    <header className="page-heading"><div><p className="eyebrow">KHO & GIAO NHẬN</p><h1>Phiếu nhận hàng</h1><p>Phân loại hàng đạt, hàng lỗi và xác nhận GRN theo PO.</p></div>
      {hasAnyRole(['warehouse', 'admin']) && <a className="button primary" href="#/orders">Chọn PO để nhận hàng</a>}
    </header>
    {poId && <p className="notice">Đang lọc theo một đơn đặt hàng. <a href={`#/orders/${poId}`}>Xem PO</a> · <a href="#/receipts">Bỏ bộ lọc PO</a></p>}
    <section className="panel"><form className="filters" onSubmit={e => { e.preventDefault(); setFilter({ ...filter, grnNumber: search.trim(), page: 1 }); }}>
      <Field id="grn-search" label="Tìm số phiếu"><input id="grn-search" value={search} placeholder="Ví dụ: GRN-2026" onChange={e => setSearch(e.target.value)} /></Field>
      <Field id="grn-status" label="Trạng thái"><select id="grn-status" value={filter.status} onChange={e => setFilter({ ...filter, status: e.target.value, page: 1 })}>
        <option value="">Tất cả trạng thái</option>{['DRAFT', 'RECEIVED', 'CANCELLED'].map(status => <option key={status} value={status}>{statusNames[status]}</option>)}
      </select></Field><button className="primary">Tìm kiếm</button><button type="button" onClick={result.reload}>Làm mới</button>
    </form>
      {result.loading && <Loading />}{!!result.error && <ErrorNotice error={result.error} retry={result.reload} />}
      {result.data && <>{!result.data.data.length ? <div className="empty"><h2>Chưa có phiếu nhận hàng phù hợp</h2><p>Mở PO đã phát hành để lập phiếu khi hàng được giao.</p></div>
        : <div className="table-scroll" tabIndex={0} aria-label="Danh sách phiếu nhận hàng"><table><thead><tr><th>Số GRN</th><th>Đơn đặt hàng</th><th>Ngày nhận</th><th>Tham chiếu giao hàng</th><th>Trạng thái</th></tr></thead><tbody>
          {result.data.data.map(grn => <tr key={grn.id}><td><a className="record-link" href={`#/receipts/${grn.id}`}>{grn.grnNumber}</a></td><td><a href={`#/orders/${grn.purchaseOrderId}`}>{grn.poNumber || 'Xem PO'}</a></td><td><DateText value={grn.receivedAt} /></td><td>{grn.referenceNote || '—'}</td><td><Status value={grn.status} /></td></tr>)}
        </tbody></table></div>}<Pagination {...result.data} onPage={page => setFilter({ ...filter, page })} /></>}
    </section><p className="footnote">Phiếu nháp chưa được tính vào tiến độ nhận hàng. Chỉ hàng đã chấp nhận trên phiếu đã xác nhận mới được dùng cho đối soát.</p>
  </>;
}

export function ReceiptDetail({ api, id }: { api: ProcurementApi; id: string }) {
  const { hasAnyRole } = useAuth();
  const [action, setAction] = useState<'receive' | 'cancel' | null>(null);
  const load = useCallback(async (signal: AbortSignal) => {
    const grn = await api.receipt(id, signal);
    const po = await api.order(grn.purchaseOrderId, signal);
    return { grn, po };
  }, [api, id]);
  const result = useResource(load);
  if (result.loading) return <Loading />;
  if (result.error) return <ErrorNotice error={result.error} retry={result.reload} />;
  if (!result.data) return null;
  const { grn, po } = result.data;
  const canReceive = hasAnyRole(['warehouse', 'admin']);
  const canCancel = canReceive && grn.status !== 'CANCELLED' && !(grn.status === 'RECEIVED' && ['CLOSED', 'CANCELLED'].includes(po.status));
  return <>
    <a className="back-link" href="#/receipts">← Phiếu nhận hàng</a>
    <header className="page-heading"><div><p className="eyebrow">HỒ SƠ GIAO NHẬN</p><h1>{grn.grnNumber}</h1><p><a href={`#/orders/${po.id}`}>{po.poNumber}</a> · <Status value={grn.status} /></p></div>
      <div className="actions"><button onClick={result.reload}>Làm mới</button>
        {canReceive && grn.status === 'DRAFT' && <><a className="button" href={`#/receipts/${id}/edit`}>Sửa bản nháp</a><button className="primary" onClick={() => setAction('receive')}>Xác nhận nhận hàng</button></>}
        {canCancel && <button className="danger-outline" onClick={() => setAction('cancel')}>Hủy phiếu</button>}
      </div>
    </header>
    {!canReceive && <p className="notice">Bạn có quyền xem GRN. Chỉ nhân viên kho và quản trị viên được sửa, xác nhận hoặc hủy phiếu.</p>}
    <section className="panel metadata"><div><small>Đơn đặt hàng</small><strong><a href={`#/orders/${po.id}`}>{po.poNumber}</a></strong><Status value={po.status} /></div>
      <div><small>Ngày giờ nhận hàng</small><strong>{new Date(grn.receivedAt).toLocaleString('vi-VN')}</strong></div>
      <div><small>Tham chiếu giao hàng</small><strong>{grn.referenceNote || '—'}</strong></div>
      <div><small>Nhà cung cấp</small><strong>{po.supplierName || '—'}</strong></div></section>
    {grn.cancelledReason && <p className="notice">Lý do hủy: {grn.cancelledReason}</p>}
    <section className="panel"><div className="section-heading"><h2>Kết quả kiểm nhận</h2><span>{grn.items?.length || 0} dòng hàng</span></div>
      <div className="table-scroll" tabIndex={0} aria-label="Chi tiết kiểm nhận"><table><thead><tr><th>Mặt hàng / Lô hàng</th><th className="numeric">Thực nhận</th><th className="numeric">Chấp nhận</th><th className="numeric">Từ chối</th><th>Lý do từ chối</th></tr></thead><tbody>
        {grn.items?.map(line => <tr key={line.id}><td><strong>{po.items?.find(item => item.id === line.purchaseOrderItemId)?.description || 'Mặt hàng PO'}</strong><small>{line.lotNumber || 'Chưa có mã lô'}</small></td><td className="numeric">{decimal(line.receivedQuantity)}</td><td className="numeric">{decimal(line.acceptedQuantity)}</td><td className="numeric">{decimal(line.rejectedQuantity)}</td><td>{line.damageNote || '—'}</td></tr>)}
      </tbody></table></div>
      <p className="footnote">Thực nhận = chấp nhận + từ chối khi xác nhận phiếu. Kho phải ghi lý do cho hàng bị từ chối.</p>
    </section>
    {action && <ConfirmAction title={action === 'receive' ? 'Xác nhận phiếu nhận hàng?' : 'Hủy phiếu nhận hàng?'} reasonRequired={action === 'cancel'}
      explanation={action === 'receive' ? 'Kết quả kiểm nhận sẽ được khóa và cộng vào tiến độ PO. Máy chủ kiểm tra phân loại đủ và giới hạn nhận vượt trước khi xác nhận.' : grn.status === 'RECEIVED' ? 'Số lượng đã chấp nhận trên phiếu này sẽ bị trừ khỏi tiến độ PO. Lý do hủy được lưu trong hồ sơ.' : 'Phiếu nháp sẽ được chuyển sang trạng thái đã hủy và giữ lại lý do.'}
      onClose={() => setAction(null)} onConfirm={async reason => {
        if (action === 'receive') await api.receive(id); else await api.cancelReceipt(id, reason);
        result.reload();
      }} />}
  </>;
}

export function ReceiptEditor({ api, id, poId }: { api: ProcurementApi; id?: string; poId?: string }) {
  const { hasAnyRole } = useAuth();
  const [revision, setRevision] = useState(0);
  const load = useCallback(async (signal: AbortSignal) => {
    const grn = id ? await api.receipt(id, signal) : undefined;
    const parentId = grn?.purchaseOrderId || poId;
    if (!parentId) return null;
    return { grn, po: await api.order(parentId, signal) };
  }, [api, id, poId]);
  const result = useResource(load);
  if (!hasAnyRole(['warehouse', 'admin'])) return <p className="notice">Chỉ nhân viên kho và quản trị viên được sửa GRN. <a href="#/receipts">Về danh sách</a></p>;
  if (result.loading) return <Loading />;
  if (result.error) return <ErrorNotice error={result.error} retry={result.reload} />;
  if (!result.data) return <p className="notice">Mở một PO đã phát hành để lập phiếu nhận. <a href="#/orders">Chọn PO</a></p>;
  if (result.data.grn && result.data.grn.status !== 'DRAFT') return <p className="notice">Phiếu đã khóa nội dung. <a href={`#/receipts/${id}`}>Xem hồ sơ</a></p>;
  if (!result.data.grn && !['ISSUED', 'PARTIALLY_RECEIVED'].includes(result.data.po.status)) return <p className="notice">PO không còn ở trạng thái có thể lập phiếu nhận mới. <a href={`#/orders/${result.data.po.id}`}>Xem PO</a></p>;
  return <ReceiptForm key={`${id || poId}-${revision}`} api={api} {...result.data} onReload={() => { setRevision(v => v + 1); result.reload(); }} />;
}

function localTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function ReceiptForm({ api, po, grn, onReload }: { api: ProcurementApi; po: PurchaseOrder; grn?: GoodsReceipt; onReload: () => void }) {
  const [receivedAt, setReceivedAt] = useState(() => localTimestamp(grn ? new Date(grn.receivedAt) : new Date()));
  const [referenceNote, setReferenceNote] = useState(grn?.referenceNote || '');
  const [lines, setLines] = useState<(GrnLineInput & { included: boolean })[]>(() => (po.items || []).map(item => {
    const existing = grn?.items?.find(line => line.purchaseOrderItemId === item.id);
    return { purchaseOrderItemId: item.id, receivedQuantity: existing?.receivedQuantity || '', acceptedQuantity: existing?.acceptedQuantity || '0',
      rejectedQuantity: existing?.rejectedQuantity || '0', lotNumber: existing?.lotNumber || '', damageNote: existing?.damageNote || '', included: grn ? !!existing : true };
  }));
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useDraftGuard({ receivedAt, referenceNote, lines }, busy);
  const errorFor = (id: string) => errors.find(error => error.id === id)?.message;
  const setLine = (index: number, patch: Partial<GrnLineInput & { included: boolean }>) => setLines(old => old.map((line, i) => i === index ? { ...line, ...patch } : line));
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    const invalid: FieldError[] = [];
    if (!receivedAt || Number.isNaN(new Date(receivedAt).getTime())) invalid.push({ id: 'received-at', message: 'Nhập ngày giờ nhận hàng hợp lệ.' });
    if (!lines.some(line => line.included)) invalid.push({ id: 'include-0', message: 'Chọn ít nhất một mặt hàng được giao.' });
    lines.forEach((line, i) => {
      if (!line.included) return;
      let quantitiesValid = true;
      (['receivedQuantity', 'acceptedQuantity', 'rejectedQuantity'] as const).forEach((field, index) => {
        if (!validDecimal(line[field], index === 0)) {
          quantitiesValid = false;
          invalid.push({ id: `${field}-${i}`, message: `Dòng ${i + 1}: ${['thực nhận phải lớn hơn 0', 'chấp nhận không được âm', 'từ chối không được âm'][index]}, tối đa 4 chữ số thập phân.` });
        }
      });
      if (quantitiesValid) {
        if (units(line.acceptedQuantity) + units(line.rejectedQuantity) > units(line.receivedQuantity)) invalid.push({ id: `acceptedQuantity-${i}`, message: `Dòng ${i + 1}: tổng chấp nhận và từ chối vượt số lượng thực nhận.` });
        if (units(line.rejectedQuantity) > 0n && !line.damageNote.trim()) invalid.push({ id: `damageNote-${i}`, message: `Dòng ${i + 1}: ghi lý do từ chối hàng.` });
      }
    });
    setErrors(invalid); if (invalid.length) return;
    setBusy(true); setFailure(null);
    const body = { purchaseOrderId: po.id, receivedAt: new Date(receivedAt).toISOString(), referenceNote: referenceNote.trim(),
      items: lines.filter(line => line.included).map(line => ({ purchaseOrderItemId: line.purchaseOrderItemId, receivedQuantity: line.receivedQuantity,
        acceptedQuantity: line.acceptedQuantity, rejectedQuantity: line.rejectedQuantity, lotNumber: line.lotNumber.trim(), damageNote: line.damageNote.trim() })) };
    try {
      const saved = grn ? await api.updateReceipt(grn.id, body) : await api.createReceipt(body);
      window.location.hash = `/receipts/${saved.id}`;
    } catch (error) { setFailure(error); } finally { setBusy(false); }
  }
  return <>
    <a className="back-link" href={grn ? `#/receipts/${grn.id}` : `#/orders/${po.id}`}>← Quay lại</a>
    <header className="page-heading"><div><p className="eyebrow">BẢN NHÁP GRN</p><h1>{grn ? `Sửa ${grn.grnNumber}` : 'Lập phiếu nhận hàng'}</h1><p>{po.poNumber} · {po.supplierName}</p></div></header>
    <form className="editor" noValidate onSubmit={submit}>
      <ErrorSummary errors={errors} />{!!failure && <ErrorNotice error={failure} />}
      {failure instanceof ApiError && failure.status === 409 && <p className="notice">Dữ liệu nhập vẫn được giữ. <button type="button" onClick={() => { if (window.confirm('Bỏ các thay đổi đang nhập và tải lại hồ sơ?')) onReload(); }}>Tải lại hồ sơ</button></p>}
      <fieldset disabled={busy}>
        <section className="panel"><div className="section-heading"><h2>Thông tin giao nhận</h2></div><div className="form-grid two-columns">
          <Field id="received-at" label="Ngày giờ nhận hàng (giờ địa phương)" error={errorFor('received-at')}><input id="received-at" type="datetime-local" value={receivedAt} {...inputAccessibility('received-at', errors)} onChange={e => setReceivedAt(e.target.value)} /></Field>
          <Field id="reference-note" label="Tham chiếu giao hàng (tùy chọn)"><input id="reference-note" value={referenceNote} placeholder="Số phiếu giao hàng, vận đơn…" onChange={e => setReferenceNote(e.target.value)} /></Field>
        </div></section>
        <section className="panel"><div className="section-heading"><h2>Kiểm nhận từng mặt hàng</h2></div><p className="footnote">Bỏ chọn mặt hàng chưa được giao. Bản nháp cho phép chưa phân loại hết; khi xác nhận phải đủ thực nhận = chấp nhận + từ chối.</p>
          {lines.map((line, i) => <fieldset className={`line-editor ${line.included ? '' : 'excluded'}`} key={line.purchaseOrderItemId}><legend>Mặt hàng {i + 1}</legend>
            <label className="checkbox-label" htmlFor={`include-${i}`}><input type="checkbox" id={`include-${i}`} checked={line.included} {...inputAccessibility(`include-${i}`, errors)} onChange={e => setLine(i, { included: e.target.checked })} /><strong>{po.items?.[i].description}</strong></label>
            {errorFor(`include-${i}`) && <small className="field-error" id={`include-${i}-error`}>{errorFor(`include-${i}`)}</small>}
            <p className="footnote">Đã đặt: {decimal(po.items?.[i].orderedQuantity || '0')} · SKU {po.items?.[i].sku || '—'}</p>
            {line.included && <>
              <div className="form-grid">{(['receivedQuantity', 'acceptedQuantity', 'rejectedQuantity'] as const).map((name, fieldIndex) => <Field key={name} id={`${name}-${i}`} label={['Số lượng thực nhận', 'Số lượng chấp nhận', 'Số lượng từ chối'][fieldIndex]} error={errorFor(`${name}-${i}`)}>
                <input id={`${name}-${i}`} inputMode="decimal" value={line[name]} {...inputAccessibility(`${name}-${i}`, errors)} onChange={e => setLine(i, { [name]: e.target.value })} /></Field>)}</div>
              <div className="form-grid two-columns"><Field id={`lotNumber-${i}`} label="Mã lô hàng (tùy chọn)"><input id={`lotNumber-${i}`} value={line.lotNumber} maxLength={100} onChange={e => setLine(i, { lotNumber: e.target.value })} /></Field>
                <Field id={`damageNote-${i}`} label="Lý do từ chối hàng" error={errorFor(`damageNote-${i}`)}><input id={`damageNote-${i}`} value={line.damageNote} {...inputAccessibility(`damageNote-${i}`, errors)} onChange={e => setLine(i, { damageNote: e.target.value })} /></Field></div>
            </>}
          </fieldset>)}
        </section>
      </fieldset>
      <div className="save-bar"><span>{lines.filter(line => line.included).length} mặt hàng · Chưa xác nhận nhận hàng</span><button className="primary" disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu bản nháp'}</button></div>
    </form>
  </>;
}
