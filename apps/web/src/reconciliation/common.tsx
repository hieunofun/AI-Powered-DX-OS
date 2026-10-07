import { ApiError } from '../procurement/api';
import { DateText, Status } from '../procurement/common';
import { decimal as formatDecimal, percentage } from '../procurement/decimal';
import type { InvoiceFile, MatchResult } from './types';
const decimal = (value?: string) => value === undefined ? '—' : formatDecimal(value);

export const invoiceStatuses = ['RECEIVED', 'PARSED', 'PENDING_MATCH', 'MATCHED', 'EXCEPTION', 'APPROVED', 'READY_FOR_PAYMENT', 'REJECTED', 'CANCELLED'];
export const roles: Record<string, string> = { buyer: 'Mua hàng', warehouse: 'Kho', accountant: 'Kế toán', finance_manager: 'Tài chính', admin: 'Quản trị viên' };
export const actions: Record<string, string> = { APPROVE: 'Phê duyệt', APPROVE_WITH_ADJUSTMENT: 'Phê duyệt kèm giải trình', REJECT: 'Từ chối', REQUEST_CREDIT_NOTE: 'Yêu cầu điều chỉnh hóa đơn' };
const discrepancyNames: Record<string, string> = {
  SUPPLIER_MISMATCH: 'Nhà cung cấp không khớp', SELLER_TAX_CODE_MISSING: 'Thiếu MST người bán',
  SELLER_TAX_CODE_MISMATCH: 'MST người bán không khớp', CURRENCY_MISMATCH: 'Đồng tiền không khớp',
  UNRECOGNIZED_ITEM: 'Chưa nhận diện được mặt hàng', AMBIGUOUS_ITEM: 'Có nhiều mặt hàng ứng viên',
  ITEM_DESCRIPTION_MISMATCH: 'Mô tả mặt hàng khác nhau', MISSING_GRN: 'Chưa có hàng được chấp nhận',
  QUANTITY_MISMATCH: 'Số lượng vượt mức được đối soát', PRICE_MISMATCH: 'Đơn giá sai lệch',
  TAX_MISMATCH: 'Thuế sai lệch', TOTAL_MISMATCH: 'Tổng tiền sai lệch',
};
export async function absent<T>(promise: Promise<T>, code: string): Promise<T | null> {
  try { return await promise; } catch (error) {
    if (error instanceof ApiError && error.status === 404 && error.code === code) return null;
    throw error;
  }
}
export function Discrepancies({ codes }: { codes: string[] }) {
  return codes.length ? <ul className="discrepancies">{codes.map(code => <li key={code}>{discrepancyNames[code] || 'Sai lệch chưa có mô tả'} <code>{code}</code></li>)}</ul>
    : <p className="evidence-copy">Không phát hiện sai lệch ngoài chính sách áp dụng.</p>;
}
export function FileEvidence({ files }: { files: InvoiceFile[] }) {
  return <section className="panel"><div className="section-heading"><h2>Tệp đã tiếp nhận</h2><span>{files.length} tệp</span></div>
    {!files.length && <p className="empty">Không có tệp được ghi nhận cho hồ sơ này.</p>}
    <ul className="file-evidence">{files.map(file => <li key={file.id}><div><strong>{file.originalFilename}</strong><small>{file.fileKind} · {file.sizeBytes} byte</small></div>
      <Status value={file.processingStatus} /><code className="hash-value">SHA-256 · {file.sha256}</code>{file.parseErrorCode && <code>{file.parseErrorCode}</code>}</li>)}</ul>
  </section>;
}
export function MatchEvidence({ match }: { match: MatchResult }) {
  const policy = match.policySnapshot;
  return <section className="panel"><div className="section-heading"><h2>Đối soát 3 chiều</h2><Status value={match.status} /></div>
    <div className="evidence-copy"><Discrepancies codes={match.discrepancyCodes} /></div>
    <div className="metadata"><div><small>Chính sách tại thời điểm đối soát</small><strong>{policy.policyCode}</strong><span>{match.ruleVersion} · <DateText value={match.completedAt} /></span></div>
      <div><small>Dung sai số lượng / đơn giá</small><strong>{decimal(policy.quantityTolerancePercent)}% / {decimal(policy.priceTolerancePercent)}%</strong></div>
      <div><small>Dung sai thuế / tổng tiền</small><strong>{decimal(policy.taxTolerancePercent)} điểm % / {decimal(policy.totalTolerancePercent)}%</strong></div></div>
    <p className="evidence-copy">Bằng chứng được lưu tại lần đối soát này. Lượng nhận hàng đã chấp nhận được trừ phần đã phân bổ hoặc giữ chỗ cho hóa đơn trước.</p>
    <div className="table-scroll" tabIndex={0} aria-label="So sánh PO GRN hóa đơn"><table className="comparison-table"><thead><tr><th>Mặt hàng</th><th>Đơn đặt hàng (PO)</th><th>Nhận hàng (GRN)</th><th>Hóa đơn</th><th>Kết quả</th></tr></thead>
      <tbody>{match.items.map(line => <tr key={line.id}><td><strong>Dòng {line.lineNumber}</strong><small>{line.details.invoiceSku || 'Không có SKU'}</small></td>
        <td>{line.details.poDescription || 'Chưa xác định mặt hàng'}<small>Đặt: {decimal(line.details.orderedQuantity)}</small>
          <small>Đơn giá: {decimal(line.details.price?.poUnitPrice)}</small><small>Thuế: {line.details.tax ? percentage(line.details.tax.poTaxRate) : '—'}</small></td>
        <td>Chấp nhận: {decimal(line.details.cumulativeAcceptedReceived)}<small>Đã phân bổ/giữ chỗ trước: {decimal(line.details.previousValidInvoicedQuantity)}</small>
          <small>Còn để đối soát: {decimal(line.details.availableToInvoice)}</small></td>
        <td>{line.details.invoiceDescription}<small>SL: {decimal(line.details.invoiceQuantity)}</small><small>Đơn giá: {decimal(line.details.price?.invoiceUnitPrice)}</small>
          <small>Thuế: {line.details.tax ? percentage(line.details.tax.invoiceTaxRate) : '—'}</small></td>
        <td><Status value={line.status} /><Discrepancies codes={line.discrepancyCodes} /><small>SL chưa khớp: {decimal(line.quantityVariance)}</small>
          <small>Lệch đơn giá: {decimal(line.unitPriceVariance)}</small><small>Lệch tiền dòng: {decimal(line.lineTotalVariance)}</small></td></tr>)}</tbody></table></div>
  </section>;
}
