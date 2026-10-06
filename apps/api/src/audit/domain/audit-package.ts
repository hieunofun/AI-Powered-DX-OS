import { canonicalJson, canonicalUuid, hashJson, sha256, utcTimestamp } from './canonical-json';
export const PACKAGE_VERSION='SMARTPROCURE-AUDIT-1';
export const CANONICALIZATION_VERSION='SP-CJSON-1';
export const MERKLE_VERSION='SP-MERKLE-1';
export interface AuditLeaf { type:string; identifier:string; data:any; sha256:string }
export interface Evidence {
  supplier:any; po:any; poItems:any[]; grns:any[]; grnItems:any[];
  invoice:any; invoiceItems:any[]; files:any[]; match:any; matchItems:any[];
  approvalCase:any; tasks:any[]; decisions:any[]; events:any[];
}
export function finalBusinessState(invoice:any, match:any, approval:any):string|null {
  if (!invoice || !match?.completed_at || !['PASSED','REVIEW_REQUIRED'].includes(match.status)) return null;
  if (approval && !['APPROVED','REJECTED','CREDIT_NOTE_REQUESTED'].includes(approval.status)) return null;
  if (invoice.status==='READY_FOR_PAYMENT' && (approval ? approval.status==='APPROVED' : match.status==='PASSED')) return 'READY_FOR_PAYMENT';
  if (invoice.status==='REJECTED' && approval?.status==='REJECTED') return 'REJECTED';
  if (invoice.status==='EXCEPTION' && approval?.status==='CREDIT_NOTE_REQUESTED') return 'CREDIT_NOTE_REQUESTED';
  return null;
}
export function makeLeaf(type:string, identifier:string, data:any):AuditLeaf {
  if (!type || !identifier || type.includes('\0') || identifier.includes('\0')) throw new Error('Invalid leaf identity');
  // Both the semantic type and stable identity are authenticated.
  return {type,identifier,data,sha256:sha256('SMARTPROCURE-AUDIT-LEAF-v1\0'+type+'\0'+identifier+'\0'+canonicalJson(data))};
}
export function merkleRoot(hashes:string[]):string {
  if (!hashes.length || hashes.some(h=>!/^[0-9a-f]{64}$/.test(h))) throw new Error('Invalid Merkle leaves');
  let level:Buffer[]=hashes.map(h=>Buffer.from(h,'hex'));
  while (level.length>1) {
    const next:Buffer[]=[];
    for(let i=0;i<level.length;i+=2) next.push(Buffer.from(sha256(Buffer.concat([
      Buffer.from('SMARTPROCURE-AUDIT-NODE-v1\0'),level[i],level[i+1]??level[i],
    ])),'hex'));
    level=next;
  }
  return level[0].toString('hex');
}
export function businessLeaves(e:Evidence):AuditLeaf[] {
  const leaves:AuditLeaf[]=[];
  const one=(type:string,row:any,identifier?:string)=>{if(row) leaves.push(makeLeaf(type,identifier??row.id,row));};
  one('SUPPLIER',e.supplier); one('PO_HEADER',e.po);
  e.poItems.forEach(r=>one('PO_ITEM',r));
  // Reader defines every business order; hashing never reorders arrays.
  for(const grn of e.grns) {
    one('GRN_HEADER',grn);
    e.grnItems.filter(r=>r.goods_receipt_id===grn.id).forEach(r=>one('GRN_ITEM',r));
  }
  one('INVOICE_HEADER',e.invoice); e.invoiceItems.forEach(r=>one('INVOICE_ITEM',r));
  e.files.forEach(r=>one('INVOICE_FILE',r)); one('MATCH_RESULT',e.match);
  e.matchItems.forEach(r=>one('MATCH_ITEM',r)); one('APPROVAL_CASE',e.approvalCase);
  e.tasks.forEach(r=>one('APPROVAL_TASK',r)); e.decisions.forEach(r=>one('APPROVAL_DECISION',r));
  e.events.forEach(r=>one('AUDIT_EVENT',r));
  return leaves;
}
export function buildPackage(evidence:Evidence,builtAt:string,capturedAt:string,captureMode:string) {
  const finalState=finalBusinessState(evidence.invoice,evidence.match,evidence.approvalCase);
  if(!finalState) throw new Error('Evidence is not a terminal business outcome');
  const leaves=businessLeaves(evidence);
  const manifest={packageVersion:PACKAGE_VERSION,canonicalizationVersion:CANONICALIZATION_VERSION,
    merkleVersion:MERKLE_VERSION,invoiceId:canonicalUuid(evidence.invoice.id),
    matchResultId:canonicalUuid(evidence.match.id),approvalCaseId:evidence.approvalCase?.id??null,
    finalBusinessState:finalState,builtAt:utcTimestamp(builtAt),capturedAt:utcTimestamp(capturedAt),captureMode,
    evidence,leaves,leafCount:leaves.length,merkleRoot:merkleRoot(leaves.map(l=>l.sha256))};
  return {manifest,packageSha256:hashJson(manifest)};
}
export function inspectPackage(pkg:any) {
  const leaves=businessLeaves(pkg.evidence);
  return {packageSha256:hashJson(pkg),merkleRoot:merkleRoot(leaves.map(l=>l.sha256)),
    manifestMatches:canonicalJson(leaves)===canonicalJson(pkg.leaves) && pkg.leafCount===leaves.length};
}
export function verificationStatus(checks:{source:boolean;package:boolean;merkle:boolean;entry:boolean;proof:boolean;available:boolean}) {
  if(!checks.available) return 'UNAVAILABLE';
  if(!checks.entry || !checks.proof) return 'LEDGER_MISMATCH';
  if(!checks.source || !checks.package || !checks.merkle) return 'TAMPERED';
  return 'VERIFIED';
}
