import { useCallback, useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import type { ProcurementApi } from './api';
import { ApiError } from './api';
import { ConfirmAction, DateText, ErrorNotice, ErrorSummary, Field, inputAccessibility, Loading, Pagination, Status, statusNames, useResource, useDraftGuard, type FieldError } from './common';
import { decimal, percentage, quantityDifference, validDecimal } from './decimal';
import type { PoInput, PoLineInput, PurchaseOrder, Supplier } from './types';

const poStatuses = ['DRAFT', 'ISSUED', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'CLOSED', 'CANCELLED'];

export function OrderList({ api }: { api: ProcurementApi }) {
  const { hasAnyRole } = useAuth();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState({ poNumber: '', status: '', page: 1 });
  const load = useCallback((signal: AbortSignal) => api.orders({ ...filter, limit: 20 }, signal), [api, filter]);
  const result = useResource(load);
  return <>
    <header className="page-heading"><div><p className="eyebrow">MUA SẮM</p><h1>Đơn đặt hàng</h1>
      <p>Theo dõi PO từ bản nháp đến khi nhận đủ hàng.</p></div>
      {hasAnyRole(['buyer', 'admin']) && <a className="button primary" href="#/orders/new">+ Tạo đơn đặt hàng</a>}
    </header>
    <section className="panel">
      <form className="filters" onSubmit={e => { e.preventDefault(); setFilter(value => ({ ...value, poNumber: search.trim(), page: 1 })); }}>
        <Field id="po-search" label="Tìm số PO"><input id="po-search" value={search} placeholder="Ví dụ: PO-2026" onChange={e => setSearch(e.target.value)} /></Field>
        <Field id="po-status" label="Trạng thái"><select id="po-status" value={filter.status} onChange={e => setFilter({ ...filter, status: e.target.value, page: 1 })}>
          <option value="">Tất cả trạng thái</option>{poStatuses.map(value => <option key={value} value={value}>{statusNames[value]}</option>)}
        </select></Field><button className="primary">Tìm kiếm</button><button type="button" onClick={result.reload}>Làm mới</button>
      </form>
      {result.loading && <Loading />}{!!result.error && <ErrorNotice error={result.error} retry={result.reload} />}
      {result.data && <>
        {!result.data.data.length ? <div className="empty"><h2>Chưa có đơn đặt hàng phù hợp</h2><p>Thử bộ lọc khác hoặc tạo PO đầu tiên.</p></div>
          : <div className="table-scroll" tabIndex={0} aria-label="Danh sách đơn đặt hàng"><table><thead><tr>
            <th>Số PO / Nhà cung cấp</th><th>Ngày đặt</th><th>Dự kiến giao</th><th>Trạng thái</th><th className="numeric">Tổng tiền</th>
          </tr></thead><tbody>{result.data.data.map(po => <tr key={po.id}>
            <td><a className="record-link" href={`#/orders/${po.id}`}>{po.poNumber}</a><small>{po.supplierName || 'Nhà cung cấp'}{po.supplierTaxCode && ` · MST ${po.supplierTaxCode}`}</small></td>
            <td><DateText value={po.orderDate} /></td><td><DateText value={po.expectedDeliveryDate} /></td><td><Status value={po.status} /></td>
            <td className="numeric"><strong>{decimal(po.totalAmount)}</strong><small>{po.currency}</small></td>
          </tr>)}</tbody></table></div>}
        <Pagination {...result.data} onPage={page => setFilter({ ...filter, page })} />
      </>}
    </section>
    <p className="footnote">PO đã phát hành được khóa nội dung. Kho xác nhận GRN để cập nhật tình trạng nhận hàng.</p>
  </>;
}

export function OrderDetail({ api, id }: { api: ProcurementApi; id: string }) {
  const { hasAnyRole } = useAuth();
  const [action, setAction] = useState<'issue' | 'cancel' | null>(null);
  const load = useCallback(async (signal: AbortSignal) => {
    const [po, fulfillment] = await Promise.all([api.order(id, signal), api.fulfillment(id, signal)]);
    return { po, fulfillment };
  }, [api, id]);
  const result = useResource(load);
  if (result.loading) return <Loading />;
  if (result.error) return <ErrorNotice error={result.error} retry={result.reload} />;
  if (!result.data) return null;
  const { po, fulfillment } = result.data;
  const canBuy = hasAnyRole(['buyer', 'admin']);
  const canReceive = hasAnyRole(['warehouse', 'admin']) && ['ISSUED', 'PARTIALLY_RECEIVED'].includes(po.status);
  return <>
    <a className="back-link" href="#/orders">← Đơn đặt hàng</a>
    <header className="page-heading"><div><p className="eyebrow">HỒ SƠ MUA SẮM</p><h1>{po.poNumber}</h1><p>{po.supplierName || 'Nhà cung cấp'} · <Status value={po.status} /></p></div>
      <div className="actions">
        <button onClick={result.reload}>Làm mới</button>
        {hasAnyRole(['buyer', 'accountant', 'finance_manager', 'admin']) && <a className="button" href={`#/invoices?po=${id}`}>Hóa đơn của PO</a>}
        {hasAnyRole(['accountant', 'admin']) && ['ISSUED', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED'].includes(po.status) && <a className="button" href={`#/invoices/new?po=${id}`}>+ Nhập hóa đơn</a>}
        {canBuy && po.status === 'DRAFT' && <><a className="button" href={`#/orders/${id}/edit`}>Sửa bản nháp</a><button className="primary" onClick={() => setAction('issue')}>Phát hành PO</button></>}
        {canReceive && <a className="button primary" href={`#/receipts/new?po=${id}`}>+ Lập phiếu nhận hàng</a>}
        {canBuy && ['DRAFT', 'ISSUED'].includes(po.status) && <button className="danger-outline" onClick={() => setAction('cancel')}>Hủy PO</button>}
      </div>
    </header>
    {!canBuy && <p className="notice">Bạn có quyền xem PO. Việc tạo, sửa và phát hành thuộc bộ phận mua hàng.</p>}
    <section className="panel metadata"><div><small>Nhà cung cấp</small><strong>{po.supplierName || '—'}</strong><span>MST {po.supplierTaxCode || '—'}</span></div>
      <div><small>Ngày đặt hàng</small><strong><DateText value={po.orderDate} /></strong></div><div><small>Dự kiến giao</small><strong><DateText value={po.expectedDeliveryDate} /></strong></div>
      <div><small>Phiên bản hồ sơ</small><strong>{po.version}</strong></div></section>
    {po.cancelledReason && <p className="notice">Lý do hủy: {po.cancelledReason}</p>}
    <section className="panel"><div className="section-heading"><h2>Chi tiết đặt hàng</h2><span>{po.items?.length || 0} mặt hàng · {po.currency}</span></div>
      <div className="table-scroll" tabIndex={0} aria-label="Chi tiết mặt hàng"><table><thead><tr><th>Mặt hàng</th><th className="numeric">Số lượng</th><th className="numeric">Đơn giá</th><th className="numeric">Thuế</th><th className="numeric">Thành tiền</th></tr></thead>
        <tbody>{po.items?.map(item => <tr key={item.id}><td><strong>{item.description}</strong><small>{item.sku || 'Chưa có SKU'}</small></td>
          <td className="numeric">{decimal(item.orderedQuantity)}</td><td className="numeric">{decimal(item.unitPrice)}</td><td className="numeric">{percentage(item.taxRate)}</td><td className="numeric">{decimal(item.lineTotal)}</td></tr>)}</tbody></table></div>
      <dl className="totals"><div><dt>Trước thuế</dt><dd>{decimal(po.subtotal)} {po.currency}</dd></div><div><dt>Tiền thuế</dt><dd>{decimal(po.taxAmount)} {po.currency}</dd></div><div className="grand-total"><dt>Tổng thanh toán</dt><dd>{decimal(po.totalAmount)} {po.currency}</dd></div></dl>
    </section>
    <section className="panel"><div className="section-heading"><div><h2>Tiến độ nhận hàng</h2><p>Chỉ tính phiếu đã xác nhận, chưa bị hủy.</p></div>
      <a href={`#/receipts?po=${id}`}>Xem các phiếu nhận →</a></div>
      <div className="table-scroll" tabIndex={0} aria-label="Tiến độ nhận hàng"><table><thead><tr><th>Mặt hàng</th><th className="numeric">Đã đặt</th><th className="numeric">Đã chấp nhận</th><th className="numeric">Đã từ chối</th><th className="numeric">Còn cần nhận</th></tr></thead><tbody>
        {po.items?.map(item => {
          const received = fulfillment.find(line => line.purchaseOrderItemId === item.id);
          return <tr key={item.id}><td>{item.description}</td><td className="numeric">{decimal(item.orderedQuantity)}</td><td className="numeric">{decimal(received?.acceptedQuantity || '0')}</td><td className="numeric">{decimal(received?.rejectedQuantity || '0')}</td><td className="numeric">{decimal(quantityDifference(item.orderedQuantity, received?.acceptedQuantity || '0'))}</td></tr>;
        })}
      </tbody></table></div><p className="footnote">Giá trị âm ở “Còn cần nhận” thể hiện số lượng nhận vượt đơn.</p>
    </section>
    {action && <ConfirmAction title={action === 'issue' ? 'Phát hành đơn đặt hàng?' : 'Hủy đơn đặt hàng?'} reasonRequired={action === 'cancel'}
      explanation={action === 'issue' ? 'Nội dung PO sẽ được khóa. Kho có thể lập phiếu nhận hàng sau khi phát hành.' : 'Thao tác hủy sẽ được ghi nhận cùng lý do. Kiểm tra các phiếu nhận liên quan trước khi xác nhận.'}
      onClose={() => setAction(null)} onConfirm={async reason => {
        if (action === 'issue') await api.issueOrder(id, po.version); else await api.cancelOrder(id, po.version, reason);
        result.reload();
      }} />}
  </>;
}

const blankLine = (): PoLineInput => ({ sku: '', description: '', orderedQuantity: '1', unitPrice: '', taxRate: '0.1' });

export function OrderEditor({ api, id }: { api: ProcurementApi; id?: string }) {
  const { hasAnyRole } = useAuth();
  const [revision, setRevision] = useState(0);
  const load = useCallback(async (signal: AbortSignal) => id ? api.order(id, signal) : null, [api, id]);
  const result = useResource(load);
  if (!hasAnyRole(['buyer', 'admin'])) return <p className="notice">Chỉ nhân viên mua hàng và quản trị viên được sửa PO. <a href="#/orders">Về danh sách</a></p>;
  if (result.loading) return <Loading />;
  if (result.error) return <ErrorNotice error={result.error} retry={result.reload} />;
  if (result.data && result.data.status !== 'DRAFT') return <p className="notice">PO đã khóa nội dung. <a href={`#/orders/${id}`}>Xem hồ sơ</a></p>;
  return <OrderForm key={`${id || 'new'}-${revision}`} api={api} existing={result.data || undefined} onReload={() => { setRevision(v => v + 1); result.reload(); }} />;
}

function OrderForm({ api, existing, onReload }: { api: ProcurementApi; existing?: PurchaseOrder; onReload: () => void }) {
  const [value, setValue] = useState<PoInput>(() => ({
    supplierId: existing?.supplierId || '', currency: existing?.currency || 'VND',
    orderDate: existing?.orderDate || `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`,
    expectedDeliveryDate: existing?.expectedDeliveryDate || '',
    items: existing?.items?.map(item => ({ sku: item.sku || '', description: item.description, orderedQuantity: item.orderedQuantity, unitPrice: item.unitPrice, taxRate: item.taxRate })) || [blankLine()],
  }));
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useDraftGuard(value, busy);
  const errorFor = (id: string) => errors.find(error => error.id === id)?.message;
  const setLine = (index: number, field: keyof PoLineInput, text: string) => setValue(old => ({ ...old, items: old.items.map((line, i) => i === index ? { ...line, [field]: text } : line) }));
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    const invalid: FieldError[] = [];
    if (!value.supplierId) invalid.push({ id: 'supplier', message: 'Chọn nhà cung cấp đang hoạt động.' });
    if (!/^[A-Z]{3}$/.test(value.currency)) invalid.push({ id: 'currency', message: 'Mã tiền tệ gồm 3 chữ cái, ví dụ VND.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value.orderDate)) invalid.push({ id: 'order-date', message: 'Nhập ngày đặt hàng.' });
    if (value.expectedDeliveryDate && value.expectedDeliveryDate < value.orderDate) invalid.push({ id: 'delivery-date', message: 'Ngày giao dự kiến phải từ ngày đặt hàng trở đi.' });
    value.items.forEach((line, i) => {
      if (!line.description.trim()) invalid.push({ id: `description-${i}`, message: `Dòng ${i + 1}: nhập tên mặt hàng.` });
      if (!validDecimal(line.orderedQuantity, true)) invalid.push({ id: `orderedQuantity-${i}`, message: `Dòng ${i + 1}: số lượng phải lớn hơn 0, tối đa 14 chữ số nguyên và 4 chữ số thập phân.` });
      if (!validDecimal(line.unitPrice)) invalid.push({ id: `unitPrice-${i}`, message: `Dòng ${i + 1}: đơn giá không âm, tối đa 14 chữ số nguyên và 4 chữ số thập phân.` });
      if (!validDecimal(line.taxRate, false, 3)) invalid.push({ id: `taxRate-${i}`, message: `Dòng ${i + 1}: nhập thuế suất dạng thập phân, ví dụ 0.1 tương ứng 10%.` });
    });
    setErrors(invalid); if (invalid.length) return;
    setBusy(true); setFailure(null);
    const body = { ...value, expectedDeliveryDate: value.expectedDeliveryDate || undefined, items: value.items.map(line => ({ ...line, description: line.description.trim(), sku: line.sku.trim() })) };
    try {
      const saved = existing ? await api.updateOrder(existing.id, body, existing.version) : await api.createOrder(body);
      window.location.hash = `/orders/${saved.id}`;
    } catch (error) { setFailure(error); } finally { setBusy(false); }
  }
  return <>
    <a className="back-link" href={existing ? `#/orders/${existing.id}` : '#/orders'}>← Quay lại</a>
    <header className="page-heading"><div><p className="eyebrow">BẢN NHÁP PO</p><h1>{existing ? `Sửa ${existing.poNumber}` : 'Tạo đơn đặt hàng'}</h1><p>Lưu bản nháp trước khi phát hành cho kho.</p></div></header>
    <form noValidate onSubmit={submit} className="editor">
      <ErrorSummary errors={errors} />
      {!!failure && <ErrorNotice error={failure} />}
      {failure instanceof ApiError && failure.status === 409 && <p className="notice">Dữ liệu nhập vẫn được giữ. <button type="button" onClick={() => { if (window.confirm('Bỏ các thay đổi đang nhập và tải phiên bản mới?')) onReload(); }}>Tải lại bản mới</button></p>}
      <fieldset disabled={busy}>
        <section className="panel"><div className="section-heading"><h2>Thông tin đặt hàng</h2></div>
          <SupplierPicker api={api} value={value.supplierId} existingName={existing?.supplierName} onChange={supplierId => setValue({ ...value, supplierId })} errors={errors} />
          <div className="form-grid">
            <Field id="currency" label="Tiền tệ" error={errorFor('currency')}><input id="currency" value={value.currency} maxLength={3} {...inputAccessibility('currency', errors)} onChange={e => setValue({ ...value, currency: e.target.value.toUpperCase() })} /></Field>
            <Field id="order-date" label="Ngày đặt hàng" error={errorFor('order-date')}><input id="order-date" type="date" value={value.orderDate} {...inputAccessibility('order-date', errors)} onChange={e => setValue({ ...value, orderDate: e.target.value })} /></Field>
            <Field id="delivery-date" label="Dự kiến giao" error={errorFor('delivery-date')}><input id="delivery-date" type="date" value={value.expectedDeliveryDate || ''} {...inputAccessibility('delivery-date', errors)} onChange={e => setValue({ ...value, expectedDeliveryDate: e.target.value })} /></Field>
          </div>
        </section>
        <section className="panel"><div className="section-heading"><h2>Mặt hàng đặt mua</h2><button type="button" onClick={() => setValue({ ...value, items: [...value.items, blankLine()] })}>+ Thêm mặt hàng</button></div>
          <p className="footnote">Dùng dấu chấm cho phần thập phân (ví dụ 12.5). Tổng tiền và thuế được máy chủ tính sau khi lưu.</p>
          {value.items.map((line, i) => <fieldset className="line-editor" key={i}><legend>Mặt hàng {i + 1}</legend>
            <div className="line-header"><Field id={`description-${i}`} label="Tên mặt hàng" error={errorFor(`description-${i}`)}><input id={`description-${i}`} value={line.description} {...inputAccessibility(`description-${i}`, errors)} onChange={e => setLine(i, 'description', e.target.value)} /></Field>
              <Field id={`sku-${i}`} label="SKU (tùy chọn)"><input id={`sku-${i}`} value={line.sku} onChange={e => setLine(i, 'sku', e.target.value)} /></Field></div>
            <div className="form-grid">{(['orderedQuantity', 'unitPrice', 'taxRate'] as const).map((name, fieldIndex) => <Field key={name} id={`${name}-${i}`} label={['Số lượng đặt', 'Đơn giá', 'Thuế suất (0.1 = 10%)'][fieldIndex]} error={errorFor(`${name}-${i}`)}>
              <input id={`${name}-${i}`} inputMode="decimal" value={line[name]} {...inputAccessibility(`${name}-${i}`, errors)} onChange={e => setLine(i, name, e.target.value)} /></Field>)}</div>
            <button className="text-danger" type="button" disabled={value.items.length === 1} onClick={() => setValue({ ...value, items: value.items.filter((_, index) => index !== i) })}>Xóa mặt hàng {i + 1}</button>
          </fieldset>)}
        </section>
      </fieldset>
      <div className="save-bar"><span>{existing ? `Đang sửa phiên bản ${existing.version}` : 'Chưa lưu hồ sơ'} · {value.items.length} mặt hàng</span><button className="primary" disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu bản nháp'}</button></div>
    </form>
  </>;
}

function SupplierPicker({ api, value, existingName, onChange, errors }: { api: ProcurementApi; value: string; existingName?: string; onChange: (id: string) => void; errors: FieldError[] }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState({ search: '', page: 1 });
  const [selected, setSelected] = useState<Supplier | undefined>();
  const load = useCallback(async (signal: AbortSignal) => {
    const [list, chosen] = await Promise.all([api.suppliers({ ...filter, limit: 20 }, signal), value ? api.suppliers({ id: value }, signal) : Promise.resolve(null)]);
    return { list, chosen: chosen?.data[0] };
  }, [api, filter, value]);
  const result = useResource(load);
  const current = result.data?.chosen || selected;
  return <div className="supplier-picker">
    <div className="filters"><Field id="supplier-search" label="Tra cứu nhà cung cấp"><input id="supplier-search" placeholder="Tên, mã NCC hoặc mã số thuế" value={search} onChange={e => setSearch(e.target.value)} /></Field>
      <button type="button" onClick={() => setFilter({ search: search.trim(), page: 1 })}>Tra cứu</button></div>
    {result.loading && <p role="status">Đang tra cứu nhà cung cấp…</p>}{!!result.error && <ErrorNotice error={result.error} retry={result.reload} />}
    <Field id="supplier" label="Nhà cung cấp" error={errors.find(error => error.id === 'supplier')?.message}>
      <select id="supplier" value={value} {...inputAccessibility('supplier', errors)} disabled={result.loading || !!result.error} onChange={e => { setSelected(result.data?.list.data.find(item => item.id === e.target.value)); onChange(e.target.value); }}>
        <option value="">Chọn nhà cung cấp đang hoạt động</option>
        {value && !result.data?.list.data.some(item => item.id === value) && <option value={value}>{current?.name || existingName || 'Nhà cung cấp đã chọn'}</option>}
        {result.data?.list.data.map(item => <option key={item.id} value={item.id} disabled={item.status !== 'ACTIVE'}>{item.name} · MST {item.taxCode}{item.status !== 'ACTIVE' ? ' · Ngừng hoạt động / bị chặn' : ''}</option>)}
      </select>
    </Field>
    {result.data && <Pagination {...result.data.list} onPage={page => setFilter({ ...filter, page })} />}
    {result.data && !result.data.list.total && <p className="footnote">Không có nhà cung cấp phù hợp. Danh mục nhà cung cấp cần được quản trị chuẩn bị trước khi tạo PO.</p>}
  </div>;
}
