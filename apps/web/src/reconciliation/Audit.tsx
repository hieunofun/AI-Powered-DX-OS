import { useCallback, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import type { ProcurementApi } from '../procurement/api';
import { ConfirmAction, ErrorNotice, Loading, Status, useResource } from '../procurement/common';
import { absent } from './common';
import type { Verification, VerificationStatus } from './types';

const verificationNames: Record<VerificationStatus, { name: string; description: string }> = {
  VERIFIED: { name: 'Kiểm chứng thành công', description: 'Nguồn dữ liệu, gói hồ sơ, Merkle root và bằng chứng sổ cái đều được xác nhận.' },
  TAMPERED: { name: 'Phát hiện hồ sơ bị thay đổi', description: 'Nguồn dữ liệu hoặc gói hồ sơ không khớp bản đã niêm phong. Cần điều tra sai lệch trước khi sử dụng.' },
  LEDGER_MISMATCH: { name: 'Bằng chứng sổ cái không khớp', description: 'Giá trị sổ cái hoặc bằng chứng mật mã không khớp với hồ sơ niêm phong.' },
  UNAVAILABLE: { name: 'Chưa kiểm chứng được sổ cái', description: 'Dịch vụ hoặc bằng chứng sổ cái hiện không sẵn sàng. Hồ sơ chưa được xác nhận hợp lệ.' },
};
function VerificationBanner({ status }: { status: VerificationStatus }) {
  const message = verificationNames[status];
  return <div className={`notice ${status === 'VERIFIED' ? 'notice-success' : 'notice-error'}`} role="status"><strong>{message?.name || 'Kết quả chưa xác định'}</strong> <code>{status}</code><p>{message?.description || 'Không thể xác nhận hồ sơ từ kết quả này.'}</p></div>;
}
export function AuditWorkspace({ api, id }: { api: ProcurementApi; id: string }) {
  const { hasAnyRole } = useAuth(); const [verification, setVerification] = useState<Verification>();
  const [exportStatus, setExportStatus] = useState<VerificationStatus>(); const [busy, setBusy] = useState('');
  const [error, setError] = useState<unknown>(); const [seal, setSeal] = useState(false);
  const resource = useResource(useCallback(async (signal: AbortSignal) => {
    const [invoice, audit] = await Promise.all([api.invoice(id, signal), absent(api.audit(id, signal), 'AUDIT_PACKAGE_NOT_FOUND')]);
    const approval = invoice.status === 'EXCEPTION' ? await absent(api.invoiceCase(id, signal), 'APPROVAL_CASE_NOT_FOUND') : null;
    return { invoice, audit, eligible: ['READY_FOR_PAYMENT', 'REJECTED'].includes(invoice.status) || approval?.status === 'CREDIT_NOTE_REQUESTED' };
  }, [api, id]));
  async function check() {
    if (busy) return; setBusy('verify'); setError(undefined); setVerification(undefined); setExportStatus(undefined);
    try { setVerification(await api.verify(id)); } catch (failure) { setError(failure); } finally { setBusy(''); }
  }
  async function download(kind: 'json' | 'pdf') {
    if (busy) return; setBusy(kind); setError(undefined); setExportStatus(undefined); setVerification(undefined);
    try {
      const report = await api.report(id, kind); setExportStatus(report.status);
      const url = URL.createObjectURL(report.blob); const link = document.createElement('a');
      link.href = url; link.download = `audit-${id}.${kind}`; document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (failure) { setError(failure); } finally { setBusy(''); }
  }
  if (resource.loading) return <Loading />; if (resource.error) return <ErrorNotice error={resource.error} retry={resource.reload} />;
  if (!resource.data) return null;
  const { invoice, audit, eligible } = resource.data;
  return <><a className="back-link" href={`#/invoices/${id}`}>← Hóa đơn</a><header className="page-heading"><div><p className="eyebrow">HỒ SƠ KIỂM TOÁN</p><h1>Kiểm chứng hồ sơ</h1><p>{invoice.invoiceNumber} · <Status value={invoice.status} /></p></div>
    <div className="actions"><button disabled={!!busy} onClick={() => { setVerification(undefined); setExportStatus(undefined); setError(undefined); resource.reload(); }}>Tải lại hồ sơ</button>
      {audit && <button className="primary" disabled={!!busy} onClick={() => void check()}>{busy === 'verify' ? 'Đang kiểm chứng…' : 'Kiểm chứng ngay'}</button>}
      {hasAnyRole(['admin']) && eligible && audit?.seal.status !== 'SEALED' && <button disabled={!!busy} onClick={() => setSeal(true)}>Niêm phong / thử lại</button>}</div></header>
    {!!error && <ErrorNotice error={error} />}
    {!audit ? <p className="notice">Chưa có gói hồ sơ niêm phong. Hồ sơ được niêm phong sau khi luồng xử lý kết thúc; quản trị viên kiểm tra việc niêm phong nếu trạng thái đã kết thúc.</p>
      : <><section className="panel metadata"><div><small>Trạng thái niêm phong</small><Status value={audit.seal.status} /><span>{audit.pkg.leaf_count} thành phần bằng chứng</span></div>
        <div><small>Trạng thái nghiệp vụ đã niêm phong</small><Status value={audit.pkg.final_business_state} /></div><div><small>Giao dịch sổ cái</small><strong>{audit.seal.immudb_tx_id || 'Chưa ghi nhận'}</strong></div></section>
        {!verification && !exportStatus && <p className="notice">Chưa chạy kiểm chứng trong lần xem này. Trạng thái niêm phong chưa xác nhận dữ liệu hiện tại nguyên vẹn.</p>}
        {verification && <><VerificationBanner status={verification.verificationStatus} /><p className="footnote">Thời điểm kiểm chứng: {verification.verifiedAt}</p><section className="panel"><div className="section-heading"><h2>Kiểm tra bằng chứng</h2></div>
          <ul className="verification-checks">{([
            ['Nguồn hiện tại khớp hồ sơ', verification.sourceSnapshotMatchesPackage], ['Hash gói hồ sơ khớp', verification.packageHashMatches],
            ['Merkle root khớp', verification.merkleRootMatches], ['Giá trị sổ cái khớp', verification.immudbEntryMatches], ['Bằng chứng mật mã sổ cái hợp lệ', verification.immudbCryptographicProofValid],
          ] as const).map(([label, passed]) => <li key={label}><span>{label}</span><strong>{passed === true ? 'Đạt' : 'Chưa đạt / chưa xác nhận'}</strong></li>)}</ul></section></>}
        <section className="panel"><div className="section-heading"><h2>Định danh hồ sơ và báo cáo</h2></div><dl className="hash-list"><dt>SHA-256 gói hồ sơ</dt><dd>{audit.pkg.package_sha256}</dd><dt>Merkle root đã niêm phong</dt><dd>{audit.pkg.merkle_root}</dd>
          {verification && <><dt>Merkle root nguồn hiện tại</dt><dd>{verification.currentRoot || 'Chưa xác định'}</dd></>}</dl>
          <div className="actions evidence-copy"><button disabled={!!busy} onClick={() => void download('json')}>{busy === 'json' ? 'Đang xuất…' : 'Tải báo cáo JSON'}</button><button disabled={!!busy} onClick={() => void download('pdf')}>{busy === 'pdf' ? 'Đang xuất…' : 'Tải báo cáo PDF'}</button></div>
          <p className="evidence-copy">Mỗi lần xuất chạy lại kiểm chứng. Báo cáo có thể chứa kết quả cảnh báo; PDF đính kèm JSON của chính lần xuất đó. Báo cáo không có chữ ký số pháp lý.</p></section>
      </>}
    {exportStatus && <><p className="footnote">Kết quả của báo cáo vừa xuất:</p><VerificationBanner status={exportStatus} /></>}
    {seal && <ConfirmAction title="Niêm phong hoặc thử lại hồ sơ?" explanation="Thao tác quản trị ghi nhận gói bằng chứng của trạng thái đã kết thúc. Hồ sơ đã niêm phong vẫn giữ nguyên bản gốc."
      onClose={() => setSeal(false)} onConfirm={async () => { await api.sealAudit(id); setVerification(undefined); setExportStatus(undefined); resource.reload(); }} />}
  </>;
}
