import { randomUUID } from 'node:crypto';
import { AuditSealService } from './audit-seal.service';
import { AuditError } from './audit-error';
import { buildPackage,Evidence } from './domain/audit-package';
import { reportPayload,renderReportPdf } from './audit-report.service';
import { hashJson } from './domain/canonical-json';

describe('Audit orchestration (repository and ledger mocked; real proof tested in CI)',()=>{
  const invoiceId=randomUUID(),packageId=randomUUID(),sealId=randomUUID(),time='2026-10-06T09:00:00.000000Z';
  let evidence:Evidence,loaded:any,proof:any,repo:any,ledger:any,service:AuditSealService;
  beforeEach(()=>{
    evidence={supplier:{id:randomUUID(),name:'Công ty Việt Nam',supplier_code:'VN',tax_code:'123'},po:{id:randomUUID(),po_number:'PO-1',total_amount:'100.00'},poItems:[],grns:[],grnItems:[],
      invoice:{id:invoiceId,invoice_number:'INV-1',status:'READY_FOR_PAYMENT'},invoiceItems:[],files:[],match:{id:randomUUID(),status:'PASSED',completed_at:time,discrepancy_codes:[]},matchItems:[],approvalCase:null,tasks:[],decisions:[],events:[]};
    const built=buildPackage(evidence,time,time,'FINALIZATION');
    const pkg={id:packageId,invoice_id:invoiceId,match_result_id:evidence.match.id,approval_case_id:null,
      package_version:built.manifest.packageVersion,canonicalization_version:built.manifest.canonicalizationVersion,
      package_json:built.manifest,package_sha256:built.packageSha256,merkle_root:built.manifest.merkleRoot,
      leaf_count:built.manifest.leafCount,final_business_state:'READY_FOR_PAYMENT',built_at:time};
    const entry={seal_key:'smartprocure:audit:invoice:'+invoiceId+':v1',invoice_id:invoiceId,audit_package_id:packageId,
      package_version:pkg.package_version,package_sha256:pkg.package_sha256,merkle_root:pkg.merkle_root,final_business_state:'READY_FOR_PAYMENT',sealed_at:time};
    proof={verified:true,entry,txId:'12',txHash:'a'.repeat(64),stateTxId:'14',stateHash:'b'.repeat(64),method:'mocked official verifier',rowProof:{},transactionHeader:{}};
    loaded={pkg,seal:{id:sealId,seal_key:entry.seal_key,status:'SEALED',package_sha256:pkg.package_sha256,merkle_root:pkg.merkle_root,
      immudb_tx_id:'12',immudb_tx_hash:proof.txHash,immudb_state_tx_id:'14',immudb_state_hash:proof.stateHash,receipt:structuredClone(proof)},op:null};
    repo={serialized:jest.fn(async(_id,fn)=>fn({})),prepare:jest.fn(async()=>loaded),load:jest.fn(async()=>loaded),
      current:jest.fn(async()=>structuredClone(evidence)),verificationIntent:jest.fn(async()=>randomUUID()),verificationResult:jest.fn(),
      dispatch:jest.fn(),finish:jest.fn(),failure:jest.fn(),detail:jest.fn(async()=>loaded)};
    ledger={get:jest.fn(async()=>entry),insert:jest.fn(),proof:jest.fn(async()=>proof)};
    service=new AuditSealService(repo,ledger);
  });
  it('returns VERIFIED only with every independent check',async()=>{
    const {result}=await service.verify(invoiceId,'actor');
    expect(result).toMatchObject({verificationStatus:'VERIFIED',sourceSnapshotMatchesPackage:true,packageHashMatches:true,
      merkleRootMatches:true,immudbEntryMatches:true,immudbCryptographicProofValid:true});
    expect(ledger.proof).toHaveBeenCalledWith(loaded.seal.seal_key,loaded.seal);
  });
  it('detects changed relational money while verifying the original ledger proof',async()=>{
    repo.current.mockResolvedValueOnce({...evidence,po:{...evidence.po,total_amount:'101.00'}});
    const {result}=await service.verify(invoiceId,'actor');
    expect(result.verificationStatus).toBe('TAMPERED');expect(result.currentRoot).not.toBe(result.sealedRoot);
    expect(result.immudbCryptographicProofValid).toBe(true);expect(ledger.insert).not.toHaveBeenCalled();
  });
  it('classifies unencodable current metadata as tampering and still checks the ledger',async()=>{
    repo.current.mockResolvedValueOnce({...evidence,po:{...evidence.po,metadata:{financialValue:0.1}}});
    const {result}=await service.verify(invoiceId,'actor');
    expect(result.verificationStatus).toBe('TAMPERED');expect(result.currentRoot).toBeNull();
    expect(result.sourceSnapshotMatchesPackage).toBe(false);expect(result.immudbCryptographicProofValid).toBe(true);
    expect(ledger.proof).toHaveBeenCalled();expect(ledger.insert).not.toHaveBeenCalled();
  });
  it('detects corrupted original package and independently checks the ledger',async()=>{
    loaded.pkg.package_json=structuredClone(loaded.pkg.package_json);loaded.pkg.package_json.evidence.po.total_amount='2.00';
    const {result}=await service.verify(invoiceId,'actor');
    expect(result.verificationStatus).toBe('TAMPERED');expect(result.packageHashMatches).toBe(false);expect(result.merkleRootMatches).toBe(false);
    expect(ledger.proof).toHaveBeenCalled();
  });
  it.each(['merkle_root','package_sha256','invoice_id','audit_package_id','package_version','final_business_state'])('detects different ledger %s',async field=>{
    ledger.get.mockResolvedValueOnce({...proof.entry,[field]:'different'});
    expect((await service.verify(invoiceId,'actor')).result.verificationStatus).toBe('LEDGER_MISMATCH');
  });
  it('rejects a valid-looking row when cryptographic verification fails',async()=>{
    ledger.proof.mockRejectedValueOnce(new AuditError('AUDIT_LEDGER_MISMATCH','Proof invalid.',409));
    const {result}=await service.verify(invoiceId,'actor');
    expect(result.verificationStatus).toBe('LEDGER_MISMATCH');expect(result.immudbCryptographicProofValid).toBe(false);
  });
  it('detects receipt transaction tampering and missing sealed rows',async()=>{
    loaded.seal.immudb_tx_id='99';expect((await service.verify(invoiceId,'actor')).result.verificationStatus).toBe('LEDGER_MISMATCH');
    ledger.get.mockResolvedValueOnce(null);expect((await service.verify(invoiceId,'actor')).result.verificationStatus).toBe('LEDGER_MISMATCH');
  });
  it('distinguishes ledger outage without inventing a proof',async()=>{
    ledger.get.mockRejectedValueOnce(new Error('internal connection string secret'));
    const {result}=await service.verify(invoiceId,'actor');expect(result.verificationStatus).toBe('UNAVAILABLE');
    expect(result.immudbCryptographicProofValid).toBe(false);expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('requires a ledger identity/proof for idempotent seal success',async()=>{
    expect(await service.seal(invoiceId,'admin')).toMatchObject({status:'SEALED',idempotent:true});
    expect(ledger.insert).not.toHaveBeenCalled();expect(ledger.proof).toHaveBeenCalled();
  });
  it('commits dispatch before INSERT and finalizes only after proof',async()=>{
    loaded.seal.status='PENDING';loaded.op={id:randomUUID()};ledger.get.mockResolvedValueOnce(null);
    await service.seal(invoiceId,'admin');
    expect(repo.dispatch.mock.invocationCallOrder[0]).toBeLessThan(ledger.insert.mock.invocationCallOrder[0]);
    expect(ledger.proof.mock.invocationCallOrder[0]).toBeLessThan(repo.finish.mock.invocationCallOrder[0]);
  });
  it('adopts an existing exact entry after PostgreSQL receipt failure without inserting again',async()=>{
    loaded.seal.status='FAILED';loaded.op={id:randomUUID()};
    await service.seal(invoiceId,'admin');expect(repo.finish).toHaveBeenCalled();expect(ledger.insert).not.toHaveBeenCalled();
  });
  it('keeps a failed receipt write recoverable and does not fabricate success',async()=>{
    loaded.seal.status='PENDING';loaded.op={id:randomUUID()};repo.finish.mockRejectedValueOnce(new Error('DB failed'));
    await expect(service.seal(invoiceId,'admin')).rejects.toBeInstanceOf(AuditError);expect(repo.failure).toHaveBeenCalled();
  });
  it('leaves the original intent when the secondary failure write is unavailable',async()=>{
    loaded.seal.status='PENDING';loaded.op={id:randomUUID()};ledger.get.mockRejectedValue(new Error('offline'));repo.failure.mockRejectedValue(new Error('also offline'));
    await expect(service.seal(invoiceId,'admin')).rejects.toBeInstanceOf(AuditError);
    await expect(service.automatic(invoiceId)).resolves.toBeUndefined();
  });
  it('never repairs/reseals a corrupted package',async()=>{
    loaded.pkg.package_sha256='f'.repeat(64);
    await expect(service.seal(invoiceId,'admin')).rejects.toMatchObject({errorCode:'AUDIT_PACKAGE_TAMPERED'});expect(ledger.insert).not.toHaveBeenCalled();
  });
  it('hashes the exact standalone JSON payload excluding only its own hash',async()=>{
    const report=reportPayload(await service.verify(invoiceId,'actor'));
    const {reportPayloadSha256,...payload}=report;expect(hashJson(payload)).toBe(reportPayloadSha256);
    expect(report.workflow.decisions).toEqual([]);expect(report.supplier.name).toBe('Công ty Việt Nam');
  });
  it('renders valid PDF with its matching JSON attachment and warning',async()=>{
    repo.current.mockResolvedValueOnce({...evidence,po:{...evidence.po,total_amount:'2.00'}});
    const report=reportPayload(await service.verify(invoiceId,'actor'));
    expect(report.verificationStatus).toBe('TAMPERED');
    const pdf=await renderReportPdf(report);expect(pdf.subarray(0,5).toString()).toBe('%PDF-');expect(pdf.length).toBeGreaterThan(1000);
    expect(pdf.toString('latin1')).toContain('report.json');
  });
});
