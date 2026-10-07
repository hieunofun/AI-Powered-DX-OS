import { PoolClient, types } from 'pg';
import { Evidence, finalBusinessState } from './domain/audit-package';
import { canonicalJson, utcTimestamp } from './domain/canonical-json';
import { AuditError } from './audit-error';

const parsers={getTypeParser:(oid:number,format?:any)=>{
  if(oid===1184) return utcTimestamp;
  if(oid===1082) return (value:string)=>value;
  return types.getTypeParser(oid,format);
}};
export async function evidenceRows(c:PoolClient,text:string,values:any[]=[]) {
  return (await c.query({text,values,types:parsers})).rows;
}
function minimized(value:any):any {
  if(Array.isArray(value)) return value.map(minimized);
  if(value && typeof value==='object') return Object.fromEntries(Object.entries(value)
    .filter(([key])=>!/(password|secret|token|authorization|credential|raw.?xml|raw.?pdf)/i.test(key))
    .map(([key,v])=>[key,minimized(v)]));
  return value;
}
// Called under the workflow transaction for capture, and REPEATABLE READ for
// current evidence verification. No matching/decision is recalculated here.
export async function readEvidence(c:PoolClient,invoiceId:string,cutoff:string):Promise<Evidence> {
  const rows=(sql:string,params:any[]=[])=>evidenceRows(c,sql,params);
  const invoice=(await rows('SELECT * FROM invoices WHERE id=$1',[invoiceId]))[0]??null;
  if(!invoice) throw new AuditError('INVOICE_NOT_FOUND','Invoice not found.',404);
  const po=(await rows('SELECT * FROM purchase_orders WHERE id=$1',[invoice.purchase_order_id]))[0]??null;
  const supplier=(await rows('SELECT id,supplier_code,tax_code,name,status FROM suppliers WHERE id=$1',[invoice.supplier_id]))[0]??null;
  const poItems=await rows('SELECT * FROM purchase_order_items WHERE purchase_order_id=$1 ORDER BY line_number,id',[invoice.purchase_order_id]);
  const grns=await rows('SELECT * FROM goods_receipts WHERE purchase_order_id=$1 AND created_at<=$2 ORDER BY received_at,id',[invoice.purchase_order_id,cutoff]);
  const grnItems=await rows(`SELECT gi.* FROM goods_receipt_items gi JOIN goods_receipts g ON g.id=gi.goods_receipt_id
    WHERE g.purchase_order_id=$1 AND g.created_at<=$2 AND gi.created_at<=$2 ORDER BY g.received_at,g.id,gi.line_number,gi.id`,[invoice.purchase_order_id,cutoff]);
  const invoiceItems=await rows('SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY line_number,id',[invoiceId]);
  const files=await rows(`SELECT f.id,f.ingestion_id,f.file_kind,f.object_key,f.media_type,f.size_bytes,f.sha256,
    f.processing_status,f.created_at FROM invoice_files f JOIN invoice_ingestions g ON g.id=f.ingestion_id
    WHERE g.invoice_id=$1 ORDER BY f.file_kind,f.id`,[invoiceId]);
  const match=(await rows('SELECT * FROM match_results WHERE invoice_id=$1',[invoiceId]))[0]??null;
  const matchItems=await rows(`SELECT m.* FROM match_result_items m JOIN invoice_items i ON i.id=m.invoice_item_id
    WHERE m.match_result_id=$1 ORDER BY i.line_number,m.id`,[match?.id??null]);
  const approvalCase=(await rows('SELECT * FROM approval_cases WHERE invoice_id=$1',[invoiceId]))[0]??null;
  const tasks=await rows('SELECT * FROM approval_tasks WHERE approval_case_id=$1 ORDER BY created_at,id',[approvalCase?.id??null]);
  const decisions=await rows('SELECT * FROM approval_decisions WHERE approval_case_id=$1 ORDER BY created_at,id',[approvalCase?.id??null]);
  const entityIds=[invoiceId,po?.id,match?.id,approvalCase?.id,...grns.map(r=>r.id),...tasks.map(r=>r.id),...files.map(r=>r.ingestion_id)].filter(Boolean);
  const events=await rows(`SELECT id,entity_type,entity_id,event_type,actor_subject,payload_hash,metadata,created_at
    FROM audit_records WHERE entity_id=ANY($1::uuid[]) AND created_at<=$2 AND event_type NOT LIKE 'AUDIT_%'
    ORDER BY created_at,id`,[entityIds,cutoff]);
  return minimized({supplier,po,poItems,grns,grnItems,invoice,invoiceItems,files,match,matchItems,approvalCase,tasks,decisions,events});
}
export async function scheduleAuditFinalization(c:PoolClient,invoiceId:string,actorSubject:string,captureMode='FINALIZATION') {
  const existing=await c.query('SELECT invoice_id FROM audit_finalizations WHERE invoice_id=$1',[invoiceId]);
  if(existing.rowCount) return;
  const timestamp=(await evidenceRows(c,'SELECT clock_timestamp() AS captured_at'))[0].captured_at;
  const evidence=await readEvidence(c,invoiceId,timestamp);
  const state=finalBusinessState(evidence.invoice,evidence.match,evidence.approvalCase);
  if(!state) throw new AuditError('AUDIT_NOT_ELIGIBLE','Invoice has no terminal workflow outcome.',409);
  // Validate serialization before committing the business transition. The frozen
  // source snapshot also survives an outage/delay before package construction.
  canonicalJson(evidence);
  await c.query(`INSERT INTO audit_finalizations(invoice_id,match_result_id,approval_case_id,final_business_state,
    finalized_at,source_snapshot,actor_subject,capture_mode) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
    ON CONFLICT(invoice_id) DO NOTHING`,[invoiceId,evidence.match.id,evidence.approvalCase?.id??null,state,
    timestamp,JSON.stringify(evidence),actorSubject,captureMode]);
}
