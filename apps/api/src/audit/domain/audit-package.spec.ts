import { createHash,randomUUID } from 'node:crypto';
import { makeLeaf,merkleRoot,buildPackage,inspectPackage,finalBusinessState,verificationStatus,Evidence } from './audit-package';
import { canonicalJson,hashJson } from './canonical-json';
const digest=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const node=(a:string,b:string)=>digest(Buffer.concat([Buffer.from('SMARTPROCURE-AUDIT-NODE-v1\0'),Buffer.from(a,'hex'),Buffer.from(b,'hex')]));
export function fixtureEvidence():Evidence {
  return {supplier:{id:randomUUID(),tax_code:'123'},po:{id:randomUUID(),total_amount:'100.00'},poItems:[{id:randomUUID(),line_number:1,unit_price:'100.0000'}],
    grns:[],grnItems:[],invoice:{id:randomUUID(),status:'READY_FOR_PAYMENT'},invoiceItems:[],files:[],
    match:{id:randomUUID(),status:'PASSED',completed_at:'2026-10-06T08:00:00.000000Z'},matchItems:[],approvalCase:null,tasks:[],decisions:[],events:[]};
}
describe('SP-MERKLE-1 and package',()=>{
  it('hashes the documented domain-separated bytes, including leaf identity',()=>{
    const leaf=makeLeaf('PO_ITEM','one',{amount:'1.00'});
    expect(leaf.sha256).toBe(digest('SMARTPROCURE-AUDIT-LEAF-v1\0PO_ITEM\0one\0'+canonicalJson(leaf.data)));
    expect(makeLeaf('GRN_ITEM','one',leaf.data).sha256).not.toBe(leaf.sha256);
    expect(makeLeaf('PO_ITEM','two',leaf.data).sha256).not.toBe(leaf.sha256);
  });
  it('handles single/even/odd levels using raw hash bytes and duplicate-last',()=>{
    const h=['a','b','c','d','e'].map(digest);
    expect(merkleRoot([h[0]])).toBe(h[0]);
    expect(merkleRoot(h.slice(0,2))).toBe(node(h[0],h[1]));
    expect(merkleRoot(h.slice(0,3))).toBe(node(node(h[0],h[1]),node(h[2],h[2])));
    expect(merkleRoot(h)).toBe(node(node(node(h[0],h[1]),node(h[2],h[3])),node(node(h[4],h[4]),node(h[4],h[4]))));
    expect(merkleRoot(h)).not.toBe(merkleRoot([...h].reverse()));
  });
  it.each([{hashes:[]},{hashes:['bad']},{hashes:['A'.repeat(64)]}])('rejects malformed hashes %j',({hashes})=>expect(()=>merkleRoot(hashes)).toThrow());
  it('separates the package hash from the business root and reuses build metadata',()=>{
    const e=fixtureEvidence(),time='2026-10-06T09:00:00Z';
    const a=buildPackage(e,time,time,'FINALIZATION'),b=buildPackage(e,time,time,'FINALIZATION');
    expect(a).toEqual(b);expect(a.packageSha256).toBe(hashJson(a.manifest));
    const later=buildPackage(e,'2026-10-07T09:00:00Z',time,'FINALIZATION');
    expect(later.manifest.merkleRoot).toBe(a.manifest.merkleRoot);expect(later.packageSha256).not.toBe(a.packageSha256);
    expect(inspectPackage(a.manifest)).toEqual({packageSha256:a.packageSha256,merkleRoot:a.manifest.merkleRoot,manifestMatches:true});
    a.manifest.evidence.po.total_amount='999.00';
    expect(inspectPackage(a.manifest).manifestMatches).toBe(false);
  });
  it('authenticates each independent document, line and decision',()=>{
    const e=fixtureEvidence(),time='2026-10-06T09:00:00Z',before=buildPackage(e,time,time,'FINALIZATION');
    e.poItems[0].unit_price='101.0000';
    expect(buildPackage(e,time,time,'FINALIZATION').manifest.merkleRoot).not.toBe(before.manifest.merkleRoot);
  });
  it.each(['RECEIVED','PARSED','PENDING_MATCH','MATCHED','EXCEPTION'])('excludes nonterminal %s',status=>{
    const e=fixtureEvidence();expect(finalBusinessState({status},e.match,null)).toBeNull();
  });
  it.each(['STARTING','PENDING','FAILED','CANCELLED'])('excludes active/invalid case %s',status=>{
    const e=fixtureEvidence();expect(finalBusinessState(e.invoice,e.match,{status})).toBeNull();
  });
  it.each([['READY_FOR_PAYMENT','APPROVED','READY_FOR_PAYMENT'],['REJECTED','REJECTED','REJECTED'],['EXCEPTION','CREDIT_NOTE_REQUESTED','CREDIT_NOTE_REQUESTED']])('recognizes terminal %s/%s',(status,caseStatus,want)=>{
    const e=fixtureEvidence();expect(finalBusinessState({status},e.match,{status:caseStatus})).toBe(want);
  });
  it('requires persisted completed matching evidence',()=>{
    expect(finalBusinessState({status:'READY_FOR_PAYMENT'},null,null)).toBeNull();
    expect(finalBusinessState({status:'READY_FOR_PAYMENT'},{status:'PASSED'},null)).toBeNull();
  });
  it('requires every verification layer and distinguishes unavailable/mismatch/tamper',()=>{
    const good={source:true,package:true,merkle:true,entry:true,proof:true,available:true};
    expect(verificationStatus(good)).toBe('VERIFIED');
    for(const field of ['source','package','merkle']) expect(verificationStatus({...good,[field]:false})).toBe('TAMPERED');
    for(const field of ['entry','proof']) expect(verificationStatus({...good,[field]:false})).toBe('LEDGER_MISMATCH');
    expect(verificationStatus({...good,available:false})).toBe('UNAVAILABLE');
  });
});
