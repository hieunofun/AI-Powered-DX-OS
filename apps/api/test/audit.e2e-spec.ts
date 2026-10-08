import { INestApplication,UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { AuditModule } from '../src/audit/audit.module';
import { AuthService } from '../src/auth/auth.service';
import { AuditSealService } from '../src/audit/audit-seal.service';
import { AuditReportService,renderReportPdf } from '../src/audit/audit-report.service';
import { AuditError } from '../src/audit/audit-error';

describe('Audit HTTP contracts (auth and audit orchestration mocked)',()=>{
  let app:INestApplication;
  const id=randomUUID(),base='/audit/invoices/'+id,roles=['admin','accountant','finance_manager','buyer','warehouse'];
  const report={verificationStatus:'VERIFIED',invoiceNumber:'INV-HTTP',invoiceId:id,poNumber:'PO-HTTP',supplier:{name:'Test Supplier',taxCode:'123'},
    workflow:{status:null,decisions:[]},immudb:{txId:'12'},discrepancyCodes:[],leafManifest:[],leafCount:0,reportPayloadSha256:'a'.repeat(64)};
  const audit={detail:jest.fn(async()=>({pkg:{invoice_id:id},seal:{status:'SEALED'}})),
    verify:jest.fn(async()=>({result:{invoiceId:id,verificationStatus:'VERIFIED',immudbCryptographicProofValid:true}})),
    seal:jest.fn(async()=>({status:'SEALED',invoiceId:id}))};
  const reports={json:jest.fn(async()=>report),pdf:jest.fn(async()=>({report,bytes:await renderReportPdf(report)}))};
  beforeAll(async()=>{
    const module=await Test.createTestingModule({imports:[AuditModule]}).overrideProvider(AuthService).useValue({verifyToken:async(token:string)=>{
      if(!roles.includes(token)) throw new UnauthorizedException();return {sub:'subject-'+token,roles:[token],username:token};
    }}).overrideProvider(AuditSealService).useValue(audit).overrideProvider(AuditReportService).useValue(reports).compile();
    app=module.createNestApplication();await app.init();
  });
  afterAll(()=>app.close());
  it.each(['admin','accountant','finance_manager'])('%s can read and verify business evidence',async role=>{
    await request(app.getHttpServer()).get(base).auth(role,{type:'bearer'}).expect(200);
    const response=await request(app.getHttpServer()).get(base+'/verify').auth(role,{type:'bearer'}).expect(200);
    expect(response.body.verificationStatus).toBe('VERIFIED');expect(response.headers['cache-control']).toBe('no-store');
  });
  it.each(['buyer','warehouse'])('%s cannot read/verify/export',async role=>{
    for(const suffix of ['','/verify','/report.json','/report.pdf']) await request(app.getHttpServer()).get(base+suffix).auth(role,{type:'bearer'}).expect(403);
  });
  it('unauthenticated readers and mutations are rejected',async()=>{
    for(const suffix of ['','/verify','/report.json','/report.pdf']) await request(app.getHttpServer()).get(base+suffix).expect(401);
    await request(app.getHttpServer()).post(base+'/seal').expect(401);
  });
  it('returns HTTP 200 for tampering and ledger mismatch results',async()=>{
    for(const status of ['TAMPERED','LEDGER_MISMATCH']) {
      audit.verify.mockResolvedValueOnce({result:{invoiceId:id,verificationStatus:status,immudbCryptographicProofValid:status==='TAMPERED'}});
      const response=await request(app.getHttpServer()).get(base+'/verify').auth('admin',{type:'bearer'}).expect(200);
      expect(response.body.verificationStatus).toBe(status);
    }
  });
  it('maps unavailable ledger verification to safe 503 result',async()=>{
    audit.verify.mockResolvedValueOnce({result:{invoiceId:id,verificationStatus:'UNAVAILABLE',immudbCryptographicProofValid:false}});
    const response=await request(app.getHttpServer()).get(base+'/verify').auth('accountant',{type:'bearer'}).expect(503);
    expect(response.body.verificationStatus).toBe('UNAVAILABLE');
    expect(response.headers['x-audit-verification-status']).toBe('UNAVAILABLE');
  });
  it('exports JSON as an attachment',async()=>{
    const response=await request(app.getHttpServer()).get(base+'/report.json').auth('finance_manager',{type:'bearer'}).expect(200).expect('Content-Type',/json/);
    expect(response.body.reportPayloadSha256).toBe(report.reportPayloadSha256);expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['x-audit-verification-status']).toBe(report.verificationStatus);
  });
  it('exports an actual PDFKit PDF',async()=>{
    const response=await request(app.getHttpServer()).get(base+'/report.pdf').auth('accountant',{type:'bearer'}).buffer(true)
      .parse((res,callback)=>{const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>callback(null,Buffer.concat(chunks)));})
      .expect(200).expect('Content-Type',/application\/pdf/);
    expect(response.body.subarray(0,5).toString()).toBe('%PDF-');
    expect(response.headers['x-audit-verification-status']).toBe(report.verificationStatus);
  });
  it.each(['accountant','finance_manager','buyer','warehouse'])('%s cannot request a manual seal',role=>
    request(app.getHttpServer()).post(base+'/seal').auth(role,{type:'bearer'}).expect(403));
  it('allows admin manual recovery with an empty body',()=>request(app.getHttpServer()).post(base+'/seal').auth('admin',{type:'bearer'}).expect(200));
  it.each([{merkleRoot:'forged'},[],{invoiceStatus:'READY_FOR_PAYMENT'}])('rejects client evidence %j',body=>
    request(app.getHttpServer()).post(base+'/seal').auth('admin',{type:'bearer'}).send(body).expect(400));
  it('returns 409 for nonterminal invoices and 404 for missing packages',async()=>{
    audit.seal.mockRejectedValueOnce(new AuditError('AUDIT_NOT_ELIGIBLE','Invoice has no terminal workflow outcome.',409));
    await request(app.getHttpServer()).post(base+'/seal').auth('admin',{type:'bearer'}).expect(409);
    audit.detail.mockRejectedValueOnce(new AuditError('AUDIT_PACKAGE_NOT_FOUND','Audit package not found.',404));
    await request(app.getHttpServer()).get(base).auth('accountant',{type:'bearer'}).expect(404);
  });
  it('rejects invalid UUIDs before querying business storage',()=>request(app.getHttpServer()).get('/audit/invoices/not-uuid').auth('admin',{type:'bearer'}).expect(400));
});
