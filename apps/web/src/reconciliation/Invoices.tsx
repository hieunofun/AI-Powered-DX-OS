import { useCallback, useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ApiError, type ProcurementApi } from '../procurement/api';
import { ConfirmAction, DateText, ErrorNotice, ErrorSummary, Field, inputAccessibility, Loading, Pagination, Status, statusNames, useDraftGuard, useResource, type FieldError } from '../procurement/common';
import { decimal, percentage } from '../procurement/decimal';
import { absent, FileEvidence, invoiceStatuses, MatchEvidence } from './common';
import type { PurchaseOrder } from '../procurement/types';

export function InvoiceList({ api, poId, audit = false }: { api: ProcurementApi; poId?: string; audit?: boolean }) {
  const { hasAnyRole } = useAuth();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState({ invoiceNumber: '', status: '', page: 1 });
  const load = useCallback((signal: AbortSignal) => api.invoices({ ...filter, purchaseOrderId: poId, limit: 20 }, signal), [api, filter, poId]);
  const resource = useResource(load);
  return <><header className="page-heading"><div><p className="eyebrow">{audit ? 'KIỂM TOÁN' : 'KẾ TOÁN'}</p><h1>{audit ? 'Hồ sơ kiểm toán' : 'Hóa đơn'}</h1><p>{audit ? 'Chọn hóa đơn đã kết thúc luồng xử lý để kiểm chứng và xuất báo cáo.' : 'Tiếp nhận chứng từ và theo dõi kết quả đối soát.'}</p></div>
    {!audit && hasAnyRole(['accountant', 'admin']) && <a className="button primary" href={`#/invoices/new${poId ? `?po=${poId}` : ''}`}>+ Nhập hóa đơn</a>}</header>
    {poId && <p className="notice">Đang lọc theo PO. <a href={`#/orders/${poId}`}>Xem PO</a> · <a href="#/invoices">Bỏ lọc</a></p>}
    <section className="panel"><form className="filters" onSubmit={e => { e.preventDefault(); setFilter({ ...filter, invoiceNumber: search.trim(), page: 1 }); }}>
      <Field id="invoice-search" label="Số hóa đơn chính xác"><input id="invoice-search" maxLength={100} value={search} onChange={e => setSearch(e.target.value)} /></Field>
      <Field id="invoice-status" label="Trạng thái"><select id="invoice-status" value={filter.status} onChange={e => setFilter({ ...filter, status: e.target.value, page: 1 })}>
        <option value="">Tất cả trạng thái</option>{invoiceStatuses.map(status => <option key={status} value={status}>{statusNames[status]}</option>)}</select></Field>
      <button className="primary">Tìm kiếm</button><button type="button" onClick={resource.reload}>Làm mới</button></form>
      {resource.loading && <Loading />}{!!resource.error && <ErrorNotice error={resource.error} retry={resource.reload} />}
      {resource.data && <>{!resource.data.data.length ? <p className="empty">Chưa có hóa đơn phù hợp.</p> : <div className="table-scroll" tabIndex={0} aria-label="Danh sách hóa đơn"><table><thead><tr><th>Hóa đơn / MST người bán</th><th>Ngày lập</th><th>Trạng thái</th><th className="numeric">Tổng tiền</th></tr></thead>
        <tbody>{resource.data.data.map(invoice => <tr key={invoice.id}><td><a className="record-link" href={`#/${audit ? 'audit' : 'invoices'}/${invoice.id}`}>{invoice.invoiceNumber}</a><small>{invoice.sellerTaxCode || 'Chưa có MST'}</small></td>
          <td><DateText value={invoice.invoiceDate} /></td><td><Status value={invoice.status} /></td><td className="numeric">{decimal(invoice.totalAmount)}<small>{invoice.currency}</small></td></tr>)}</tbody></table></div>}
        <Pagination {...resource.data} onPage={page => setFilter({ ...filter, page })} /></>}
    </section><p className="footnote">PDF chờ OCR được theo dõi bằng hồ sơ tiếp nhận riêng, chưa xuất hiện trong danh sách hóa đơn đã bóc tách.</p></>;
}

export function InvoiceUpload({ api, poId }: { api: ProcurementApi; poId?: string }) {
  const { hasAnyRole } = useAuth();
  const [selected, setSelected] = useState(poId || '');
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState<PurchaseOrder[]>([]);
  const [xml, setXml] = useState<File>(); const [pdf, setPdf] = useState<File>();
  const [busy, setBusy] = useState(false); const [lookupBusy, setLookupBusy] = useState(false);
  const [error, setError] = useState<unknown>(); const [errors, setErrors] = useState<FieldError[]>([]);
  const [ingestionId, setIngestionId] = useState('');
  const binding = useResource(useCallback((signal: AbortSignal) => selected ? api.order(selected, signal) : Promise.resolve(null), [api, selected]));
  useDraftGuard({ selected, xml: xml && [xml.name, xml.size, xml.lastModified], pdf: pdf && [pdf.name, pdf.size, pdf.lastModified] }, busy);
  if (!hasAnyRole(['accountant', 'admin'])) return <p className="notice">Việc nhập hóa đơn thuộc kế toán hoặc quản trị viên. <a href="#/invoices">Xem hóa đơn</a></p>;
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    const validation: FieldError[] = [];
    if (!binding.data || !['ISSUED', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED'].includes(binding.data.status)) validation.push({ id: 'invoice-po', message: 'Chọn PO đã phát hành hoặc đã nhận hàng.' });
    if (!xml && !pdf) validation.push({ id: 'invoice-xml', message: 'Chọn ít nhất một tệp XML hoặc PDF.' });
    for (const [id, file, extension] of [['invoice-xml', xml, 'xml'], ['invoice-pdf', pdf, 'pdf']] as const) {
      if (file && (!file.size || !file.name.toLowerCase().endsWith(`.${extension}`))) validation.push({ id, message: `Chọn tệp ${extension.toUpperCase()} có nội dung và đúng phần mở rộng.` });
    }
    setErrors(validation); setError(undefined); if (validation.length) return;
    const body = new FormData(); body.append('purchaseOrderId', selected);
    // The backend verifies actual bytes/media type; browser file associations may be empty.
    if (xml) body.append('xml', new Blob([xml], { type: 'application/xml' }), xml.name);
    if (pdf) body.append('pdf', new Blob([pdf], { type: 'application/pdf' }), pdf.name);
    setBusy(true); setIngestionId('');
    try { const result = await api.ingest(body); window.location.hash = result.invoiceId ? `/invoices/${result.invoiceId}` : `/ingestions/${result.ingestionId}`; }
    catch (failure) { setError(failure); if (failure instanceof ApiError && failure.ingestionId) setIngestionId(failure.ingestionId); }
    finally { setBusy(false); }
  }
  return <><a className="back-link" href="#/invoices">← Hóa đơn</a><header className="page-heading"><div><p className="eyebrow">TIẾP NHẬN</p><h1>Nhập hóa đơn</h1><p>Gắn tệp của nhà cung cấp với một PO để lưu và bóc tách.</p></div></header>
    <ErrorSummary errors={errors} />{!!error && <ErrorNotice error={error} />}
    {ingestionId && <p className="notice">Lần tiếp nhận được ghi nhận. <a href={`#/ingestions/${ingestionId}`}>Xem trạng thái và mã lỗi trước khi gửi lại</a>.</p>}
    <section className="panel"><form className="filters" onSubmit={async e => { e.preventDefault(); if (lookupBusy) return; setLookupBusy(true); setError(undefined);
      try { const result = await api.orders({ poNumber: search.trim(), limit: 50 }); setOptions(result.data.filter(po => ['ISSUED', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED'].includes(po.status))); }
      catch (failure) { setError(failure); } finally { setLookupBusy(false); } }}>
      <Field id="invoice-po-search" label="Tra cứu số PO"><input id="invoice-po-search" value={search} maxLength={100} disabled={busy} onChange={e => setSearch(e.target.value)} /></Field>
      <button disabled={busy || lookupBusy}>{lookupBusy ? 'Đang tra cứu…' : 'Tra cứu PO'}</button></form>
      <form onSubmit={e => void submit(e)} noValidate><fieldset disabled={busy} className="upload-fields"><div className="form-grid two-columns">
        <Field id="invoice-po" label="PO tiếp nhận hóa đơn" error={errors.find(e => e.id === 'invoice-po')?.message}><select id="invoice-po" value={selected} onChange={e => setSelected(e.target.value)} {...inputAccessibility('invoice-po', errors)}>
          <option value="">Chọn PO đã phát hành</option>{selected && !options.some(po => po.id === selected) && <option value={selected}>{binding.data?.poNumber || selected}</option>}
          {options.map(po => <option key={po.id} value={po.id}>{po.poNumber} · {po.supplierName}</option>)}</select></Field>
        <div>{binding.loading && selected && <p role="status">Đang kiểm tra PO…</p>}{!!binding.error && <ErrorNotice error={binding.error} retry={binding.reload} />}
          {binding.data && <p className="notice">{binding.data.supplierName} · MST {binding.data.supplierTaxCode}<br /><Status value={binding.data.status} /></p>}</div>
        <Field id="invoice-xml" label="Hóa đơn XML" error={errors.find(e => e.id === 'invoice-xml')?.message}><input id="invoice-xml" type="file" accept=".xml,application/xml,text/xml" onChange={e => setXml(e.target.files?.[0])} {...inputAccessibility('invoice-xml', errors)} /></Field>
        <Field id="invoice-pdf" label="Bản thể hiện PDF" error={errors.find(e => e.id === 'invoice-pdf')?.message}><input id="invoice-pdf" type="file" accept=".pdf,application/pdf" onChange={e => setPdf(e.target.files?.[0])} {...inputAccessibility('invoice-pdf', errors)} /></Field>
      </div><p className="evidence-copy">Hỗ trợ profile SmartProcureInvoice v1 và tập con Matbao/MIFI PBan 2.0.0. PDF gửi riêng được lưu ở trạng thái chờ OCR; chưa tạo dữ liệu hóa đơn. Xác minh chữ ký số chưa được cung cấp.</p>
        <div className="save-bar"><span>Tệp và dữ liệu hóa đơn được kiểm tra trên máy chủ.</span><button className="primary" disabled={busy || binding.loading || !binding.data}>{busy ? 'Đang tiếp nhận…' : 'Tiếp nhận hóa đơn'}</button></div>
      </fieldset></form></section></>;
}

export function IngestionDetail({ api, id }: { api: ProcurementApi; id: string }) {
  const resource = useResource(useCallback((signal: AbortSignal) => api.ingestion(id, signal), [api, id]));
  if (resource.loading) return <Loading />; if (resource.error) return <ErrorNotice error={resource.error} retry={resource.reload} />;
  const ingestion = resource.data; if (!ingestion) return null;
  return <><a className="back-link" href="#/invoices">← Hóa đơn</a><header className="page-heading"><div><p className="eyebrow">TIẾP NHẬN</p><h1>Hồ sơ tiếp nhận</h1><p className="hash-value">{ingestion.id}</p></div><button onClick={resource.reload}>Làm mới</button></header>
    <p className={`notice ${ingestion.status === 'FAILED' ? 'notice-error' : ''}`}><Status value={ingestion.status} /> {ingestion.status === 'OCR_REQUIRED' ? 'PDF đã lưu. Dịch vụ OCR chưa được cấu hình; chưa có dữ liệu hóa đơn để đối soát.' : ingestion.status === 'FAILED' ? 'Tiếp nhận thất bại. Kiểm tra tệp và mã lỗi trước khi gửi lại.' : 'Trạng thái tiếp nhận được đọc từ hồ sơ đã lưu.'}
      {ingestion.errorCode && <code> · {ingestion.errorCode}</code>}</p><div className="actions evidence-copy"><a className="button" href={`#/orders/${ingestion.purchaseOrderId}`}>Xem PO</a>
      {ingestion.invoiceId && <a className="button primary" href={`#/invoices/${ingestion.invoiceId}`}>Xem hóa đơn</a>}<a className="button" href={`#/invoices/new?po=${ingestion.purchaseOrderId}`}>Nhập tệp khác</a></div>
    <FileEvidence files={ingestion.files || []} /></>;
}

export function InvoiceDetail({ api, id }: { api: ProcurementApi; id: string }) {
  const { hasAnyRole } = useAuth(); const [action, setAction] = useState<'match' | 'workflow' | null>(null);
  const resource = useResource(useCallback(async (signal: AbortSignal) => {
    const invoice = await api.invoice(id, signal);
    const [po, files, match, approval] = await Promise.all([api.order(invoice.purchaseOrderId, signal), api.invoiceFiles(id, signal),
      absent(api.invoiceMatch(id, signal), 'MATCH_RESULT_NOT_FOUND'), absent(api.invoiceCase(id, signal), 'APPROVAL_CASE_NOT_FOUND')]);
    return { invoice, po, files, match, approval };
  }, [api, id]));
  if (resource.loading) return <Loading />; if (resource.error) return <ErrorNotice error={resource.error} retry={resource.reload} />;
  if (!resource.data) return null;
  const { invoice, po, files, match, approval } = resource.data;
  const canAct = hasAnyRole(['accountant', 'admin']);
  return <><a className="back-link" href="#/invoices">← Hóa đơn</a><header className="page-heading"><div><p className="eyebrow">HỒ SƠ KẾ TOÁN</p><h1>{invoice.invoiceNumber}</h1><p><Status value={invoice.status} /> · {po.supplierName}</p></div>
    <div className="actions"><button onClick={resource.reload}>Làm mới</button>{canAct && invoice.status === 'PARSED' && !match && <button className="primary" onClick={() => setAction('match')}>Đối soát 3 chiều</button>}
      {canAct && match && !approval && ['MATCHED', 'EXCEPTION'].includes(invoice.status) && <button className="primary" onClick={() => setAction('workflow')}>Bắt đầu luồng xử lý</button>}
      {hasAnyRole(['accountant', 'finance_manager', 'admin']) && <a className="button" href={`#/audit/${id}`}>Kiểm chứng hồ sơ</a>}</div></header>
    {invoice.status === 'READY_FOR_PAYMENT' && <p className="notice notice-success">Hóa đơn được phép chuyển sang bước thanh toán. Chưa có xác nhận chuyển tiền hoặc chữ ký số CFO.</p>}
    {approval ? <p className="notice">Luồng xử lý: <Status value={approval.status} /> · <a href={`#/approvals/${approval.id}`}>Xem nhiệm vụ và quyết định</a></p>
      : invoice.status === 'READY_FOR_PAYMENT' && match?.status === 'PASSED' && <p className="notice">Luồng tự động STP theo chính sách đã áp dụng; không có hồ sơ phê duyệt thủ công.</p>}
    <section className="panel metadata"><div><small>Đơn đặt hàng</small><a href={`#/orders/${po.id}`}>{po.poNumber}</a></div><div><small>Ngày hóa đơn</small><strong><DateText value={invoice.invoiceDate} /></strong></div>
      <div><small>MST người bán / mua</small><strong>{invoice.sellerTaxCode || '—'}</strong><span>{invoice.buyerTaxCode || '—'}</span></div><div><small>Tổng tiền</small><strong>{decimal(invoice.totalAmount)} {invoice.currency}</strong></div></section>
    <section className="panel"><div className="section-heading"><h2>Dòng hóa đơn</h2><span>{invoice.items?.length || 0} mặt hàng</span></div><div className="table-scroll" tabIndex={0} aria-label="Chi tiết hóa đơn"><table><thead><tr><th>Mặt hàng</th><th className="numeric">SL</th><th className="numeric">Đơn giá</th><th className="numeric">Thuế</th><th className="numeric">Tổng dòng</th></tr></thead>
      <tbody>{invoice.items?.map(line => <tr key={line.id}><td>{line.description}<small>{line.sku || 'Không có SKU'}</small></td><td className="numeric">{decimal(line.quantity)}</td><td className="numeric">{decimal(line.unitPrice)}</td><td className="numeric">{percentage(line.taxRate)}</td><td className="numeric">{decimal(line.lineTotal)}</td></tr>)}</tbody></table></div></section>
    {match ? <MatchEvidence match={match} /> : <p className="notice">Chưa có kết quả đối soát. Kế toán có thể bắt đầu khi hóa đơn đã được bóc tách.</p>}<FileEvidence files={files} />
    {action && <ConfirmAction title={action === 'match' ? 'Đối soát hóa đơn?' : 'Bắt đầu luồng xử lý?'} explanation={action === 'match' ? 'So sánh hóa đơn với PO và hàng đã chấp nhận, rồi lưu kết quả theo chính sách hiện hành.' : 'Máy chủ chọn luồng tự động hoặc nhiệm vụ phê duyệt từ kết quả đối soát và chính sách hiện hành.'}
      onClose={() => setAction(null)} onConfirm={async () => { if (action === 'match') await api.match(id); else await api.startWorkflow(id); resource.reload(); }} />}
  </>;
}
