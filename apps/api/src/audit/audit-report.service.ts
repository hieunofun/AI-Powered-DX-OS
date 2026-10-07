import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { AuditSealService } from './audit-seal.service';
import { canonicalJson,hashJson } from './domain/canonical-json';

export function reportPayload(verification:any) {
  const {result,pkg,seal,receipt}=verification,e=pkg.package_json.evidence;
  const payload={reportVersion:'SMARTPROCURE-AUDIT-REPORT-1',generatedAt:result.verifiedAt,
    invoiceId:pkg.invoice_id,invoiceNumber:e.invoice?.invoice_number??null,poNumber:e.po?.po_number??null,
    supplier:{code:e.supplier?.supplier_code??null,name:e.supplier?.name??null,taxCode:e.supplier?.tax_code??null},
    finalBusinessState:pkg.final_business_state,packageVersion:pkg.package_version,
    canonicalizationVersion:pkg.canonicalization_version,packageSha256:pkg.package_sha256,
    merkleRoot:pkg.merkle_root,leafCount:pkg.leaf_count,sealKey:seal.seal_key,
    immudb:{txId:receipt?.txId??seal.immudb_tx_id,txHash:receipt?.txHash??seal.immudb_tx_hash,
      stateTxId:receipt?.stateTxId??seal.immudb_state_tx_id,stateHash:receipt?.stateHash??seal.immudb_state_hash,
      cryptographicProofValid:result.immudbCryptographicProofValid,proofMethod:receipt?.method??null,
      originalReceipt:seal.receipt??null},
    currentRoot:result.currentRoot,sealedRoot:result.sealedRoot,verificationStatus:result.verificationStatus,
    checks:{sourceSnapshotMatchesPackage:result.sourceSnapshotMatchesPackage,packageHashMatches:result.packageHashMatches,
      merkleRootMatches:result.merkleRootMatches,immudbEntryMatches:result.immudbEntryMatches,
      immudbCryptographicProofValid:result.immudbCryptographicProofValid},
    verifiedAt:result.verifiedAt,leafManifest:pkg.package_json.leaves.map((l:any)=>({type:l.type,identifier:l.identifier,sha256:l.sha256})),
    discrepancyCodes:e.match?.discrepancy_codes??[],workflow:{caseId:e.approvalCase?.id??null,status:e.approvalCase?.status??null,
      decisions:e.decisions.map((d:any)=>({id:d.id,action:d.action,reason:d.reason,actorSubject:d.actor_subject,createdAt:d.created_at}))},
    performance:Object.fromEntries(Object.entries(result.performance).map(([k,v])=>[k,(v as number).toFixed(3)])),
    limitations:['No legal/PKI signature. PostgreSQL remains mutable.','PDF bytes are not ledger-anchored; the attached JSON payload is hashed.']};
  return {...payload,reportPayloadSha256:hashJson(payload)};
}
@Injectable()
export class AuditReportService {
  constructor(private readonly audit:AuditSealService) {}
  async json(invoiceId:string,actor:string) {return reportPayload(await this.audit.verify(invoiceId,actor));}
  async pdf(invoiceId:string,actor:string) {
    const report=await this.json(invoiceId,actor);
    const bytes=await renderReportPdf(report);
    return {report,bytes};
  }
}
export function renderReportPdf(report:any):Promise<Buffer> {
  return new Promise((resolve,reject)=>{
    const doc=new PDFDocument({size:'A4',margin:44,info:{Title:'SmartProcure-Pay Audit Verification Report',Author:'SmartProcure-Pay'}});
    const fonts=[resolvePath(process.cwd(),'infra/audit/fonts/NotoSans.ttf'),resolvePath(process.cwd(),'../../infra/audit/fonts/NotoSans.ttf')];
    const font=fonts.find(existsSync);
    if(!font) {reject(new Error('Audit report font unavailable'));return;}
    doc.font(font);
    const chunks:Buffer[]=[];doc.on('data',chunk=>chunks.push(chunk));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
    doc.fontSize(18).text('SmartProcure-Pay Audit Verification Report');doc.moveDown();
    const field=(label:string,value:any)=>doc.fontSize(10).text(label+': '+String(value??'N/A')).moveDown(0.35);
    field('Verification Status',report.verificationStatus);
    if(report.verificationStatus!=='VERIFIED') doc.fillColor('#a00000').fontSize(12).text('WARNING: Evidence is not VERIFIED. Investigate before relying on this report.').fillColor('black').moveDown();
    for(const [label,value] of Object.entries({Invoice:report.invoiceNumber,'Invoice ID':report.invoiceId,PO:report.poNumber,
      Supplier:report.supplier.name,'Supplier tax code':report.supplier.taxCode,'Final State':report.finalBusinessState,
      'Package Version':report.packageVersion,'Canonicalization':report.canonicalizationVersion,
      'Package SHA-256':report.packageSha256,'Merkle Root':report.merkleRoot,'Current Relational Root':report.currentRoot,
      'ImmuDB Transaction ID':report.immudb.txId,'Verified At':report.verifiedAt,'Leaf count':report.leafCount,
      'JSON report payload SHA-256':report.reportPayloadSha256})) field(label,value);
    field('Discrepancy codes',report.discrepancyCodes.join(', ')||'None');
    field('Approval case',report.workflow.status??'Default clean STP: no approval case');
    for(const decision of report.workflow.decisions) field('Decision',decision.action+' | '+(decision.reason??'No reason supplied')+' | '+decision.createdAt);
    doc.moveDown().fontSize(12).text('Leaf hash manifest');
    for(const leaf of report.leafManifest) field(leaf.type+' '+leaf.identifier,leaf.sha256);
    doc.moveDown().fontSize(9).text('The attached report.json contains this report payload and its SHA-256. Separately generated exports have their own verification timestamps. PDF bytes are not immutably anchored. No legal digital signature or invoice certificate is claimed.');
    doc.file(Buffer.from(canonicalJson(report),'utf8'),{name:'report.json',description:'Exact JSON verification report paired with this PDF',type:'application/json'});
    doc.end();
  });
}
