import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { AuditError } from './audit-error';
import { buildPackage } from './domain/audit-package';
import { hashJson } from './domain/canonical-json';
import { evidenceRows,readEvidence,scheduleAuditFinalization } from './evidence-reader';

@Injectable()
export class AuditRepository {
  constructor(private readonly db:DatabaseService) {}
  async transaction<T>(c:PoolClient,work:()=>Promise<T>,readOnly=false):Promise<T> {
    await c.query(readOnly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {const result=await work();await c.query('COMMIT');return result;}
    catch(error) {await c.query('ROLLBACK');throw error;}
  }
  async serialized<T>(invoiceId:string,work:(c:PoolClient)=>Promise<T>):Promise<T> {
    const c=await this.db.getClient();let locked=false,destroy=false;
    try {
      locked=(await c.query("SELECT pg_try_advisory_lock(hashtextextended('audit:' || $1,0)) AS locked",[invoiceId])).rows[0].locked;
      if(!locked) throw new AuditError('AUDIT_OPERATION_IN_FLIGHT','An audit operation is already in progress.',409);
      return await work(c);
    } finally {
      if(locked) try {await c.query("SELECT pg_advisory_unlock(hashtextextended('audit:' || $1,0))",[invoiceId]);} catch {destroy=true;}
      c.release(destroy);
    }
  }
  async audit(c:PoolClient,invoiceId:string,event:string,actor:string,metadata:any) {
    // This hash covers exactly metadata in SP-CJSON-1; it is not the package root.
    metadata={...metadata,roles:[]}; // system/operator seal events do not invent JWT role evidence
    await c.query(`INSERT INTO audit_records(entity_type,entity_id,event_type,actor_subject,metadata,payload_hash)
      VALUES('INVOICE',$1,$2,$3,$4::jsonb,$5)`,[invoiceId,event,actor,JSON.stringify(metadata),hashJson(metadata)]);
  }
  async load(c:PoolClient,invoiceId:string) {
    const pkg=(await evidenceRows(c,'SELECT * FROM audit_packages WHERE invoice_id=$1',[invoiceId]))[0];
    if(!pkg) {
      const exists=await c.query('SELECT id FROM invoices WHERE id=$1',[invoiceId]);
      throw new AuditError(exists.rowCount?'AUDIT_PACKAGE_NOT_FOUND':'INVOICE_NOT_FOUND',exists.rowCount?'Audit package not found.':'Invoice not found.',404);
    }
    const seal=(await evidenceRows(c,'SELECT * FROM audit_seals WHERE audit_package_id=$1',[pkg.id]))[0];
    if(!seal) throw new AuditError('AUDIT_SEAL_NOT_FOUND','Audit seal not found.',404);
    return {pkg,seal};
  }
  async prepare(c:PoolClient,invoiceId:string,actor:string) {
    return this.transaction(c,async()=>{
      const invoice=(await c.query('SELECT id FROM invoices WHERE id=$1 FOR UPDATE',[invoiceId])).rows[0];
      if(!invoice) throw new AuditError('INVOICE_NOT_FOUND','Invoice not found.',404);
      if(!(await c.query('SELECT id FROM audit_packages WHERE invoice_id=$1',[invoiceId])).rowCount) {
        await scheduleAuditFinalization(c,invoiceId,actor,'BACKFILL');
        const marker=(await evidenceRows(c,'SELECT * FROM audit_finalizations WHERE invoice_id=$1',[invoiceId]))[0];
        const builtAt=(await evidenceRows(c,'SELECT clock_timestamp() AS built_at'))[0].built_at;
        const {manifest,packageSha256}=buildPackage(marker.source_snapshot,builtAt,marker.finalized_at,marker.capture_mode);
        const pkg=(await c.query(`INSERT INTO audit_packages(invoice_id,match_result_id,approval_case_id,package_version,
          canonicalization_version,package_json,package_sha256,merkle_root,leaf_count,final_business_state,built_at)
          VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11) RETURNING id`,[invoiceId,marker.match_result_id,
          marker.approval_case_id,manifest.packageVersion,manifest.canonicalizationVersion,JSON.stringify(manifest),
          packageSha256,manifest.merkleRoot,manifest.leafCount,manifest.finalBusinessState,manifest.builtAt])).rows[0];
        await c.query(`INSERT INTO audit_seals(audit_package_id,invoice_id,seal_key,package_sha256,merkle_root)
          VALUES($1,$2,$3,$4,$5)`,[pkg.id,invoiceId,'smartprocure:audit:invoice:'+invoiceId+':v1',packageSha256,manifest.merkleRoot]);
        await c.query("UPDATE audit_finalizations SET status='BUILT',last_error_code=NULL,updated_at=now() WHERE invoice_id=$1",[invoiceId]);
        await this.audit(c,invoiceId,'AUDIT_PACKAGE_CREATED',actor,{packageId:pkg.id,packageSha256,merkleRoot:manifest.merkleRoot});
      }
      const loaded=await this.load(c,invoiceId);
      let op:any=null;
      if(loaded.seal.status!=='SEALED') {
        op=(await c.query("SELECT * FROM audit_seal_operations WHERE audit_package_id=$1 AND operation='SEAL' AND status IN ('PENDING','FAILED')",[loaded.pkg.id])).rows[0];
        if(!op) op=(await c.query("INSERT INTO audit_seal_operations(audit_package_id,operation,actor_subject) VALUES($1,'SEAL',$2) RETURNING *",[loaded.pkg.id,actor])).rows[0];
      }
      return {...loaded,op};
    });
  }
  async dispatch(c:PoolClient,operationId:string) {
    await c.query("UPDATE audit_seal_operations SET status='PENDING',dispatched_at=clock_timestamp(),retry_safe=false,error_code=NULL,updated_at=now() WHERE id=$1",[operationId]);
  }
  async finish(c:PoolClient,loaded:any,receipt:any) {
    await this.transaction(c,async()=>{
      await c.query(`UPDATE audit_seals SET status='SEALED',immudb_tx_id=$2,immudb_tx_hash=$3,immudb_state_tx_id=$4,
        immudb_state_hash=$5,receipt=$6::jsonb,sealed_at=$7,verified_at=clock_timestamp(),last_verification_status='VERIFIED',
        last_error_code=NULL,updated_at=now() WHERE id=$1`,[loaded.seal.id,receipt.txId,receipt.txHash,receipt.stateTxId,
        receipt.stateHash,JSON.stringify(receipt),receipt.entry.sealed_at]);
      await c.query("UPDATE audit_seal_operations SET status='APPLIED',error_code=NULL,retry_safe=false,updated_at=now() WHERE id=$1",[loaded.op.id]);
      await this.audit(c,loaded.pkg.invoice_id,'AUDIT_PACKAGE_SEALED',loaded.op.actor_subject,{packageId:loaded.pkg.id,
        sealKey:loaded.seal.seal_key,immudbTxId:receipt.txId,merkleRoot:receipt.entry.merkle_root});
    });
  }
  async failure(c:PoolClient,loaded:any,code:string) {
    if(!loaded?.op) return;
    await this.transaction(c,async()=>{
      await c.query("UPDATE audit_seal_operations SET status='FAILED',error_code=$2,retry_safe=true,updated_at=now() WHERE id=$1",[loaded.op.id,code]);
      await c.query("UPDATE audit_seals SET status='FAILED',last_error_code=$2,updated_at=now() WHERE id=$1 AND status<>'SEALED'",[loaded.seal.id,code]);
    });
  }
  async current(c:PoolClient,pkg:any) {
    return this.transaction(c,()=>readEvidence(c,pkg.invoice_id,pkg.package_json.capturedAt),true);
  }
  async verificationIntent(c:PoolClient,pkg:any,actor:string) {
    return (await c.query("INSERT INTO audit_seal_operations(audit_package_id,operation,actor_subject,dispatched_at) VALUES($1,'VERIFY',$2,clock_timestamp()) RETURNING id",[pkg.id,actor])).rows[0].id;
  }
  async verificationResult(c:PoolClient,seal:any,opId:string,result:any) {
    await this.transaction(c,async()=>{
      await c.query(`UPDATE audit_seals SET verified_at=$2,last_verification_status=$3,last_error_code=$4,updated_at=now() WHERE id=$1`,
        [seal.id,result.verifiedAt,result.verificationStatus,result.verificationStatus==='UNAVAILABLE'?'AUDIT_LEDGER_UNAVAILABLE':null]);
      await c.query("UPDATE audit_seal_operations SET status=$2,error_code=$3,updated_at=now() WHERE id=$1",
        [opId,result.verificationStatus==='UNAVAILABLE'?'FAILED':'APPLIED',result.verificationStatus==='UNAVAILABLE'?'AUDIT_LEDGER_UNAVAILABLE':null]);
    });
  }
  detail(invoiceId:string) {return this.serialized(invoiceId,c=>this.load(c,invoiceId));}
  async eligible(invoiceId:string|null=null) {
    return (await this.db.query(`SELECT i.id AS "invoiceId",p.id AS "packageId",s.id AS "sealId",s.status,
      f.status AS "finalizationStatus",s.seal_key AS "sealKey",s.merkle_root AS "merkleRoot"
      FROM invoices i LEFT JOIN approval_cases a ON a.invoice_id=i.id
      LEFT JOIN match_results m ON m.invoice_id=i.id LEFT JOIN audit_finalizations f ON f.invoice_id=i.id
      LEFT JOIN audit_packages p ON p.invoice_id=i.id LEFT JOIN audit_seals s ON s.invoice_id=i.id
      WHERE ($1::uuid IS NULL OR i.id=$1) AND (f.invoice_id IS NOT NULL OR
        (m.completed_at IS NOT NULL AND m.status IN ('PASSED','REVIEW_REQUIRED') AND
         ((i.status='READY_FOR_PAYMENT' AND (a.status='APPROVED' OR (a.id IS NULL AND m.status='PASSED')))
          OR (i.status='REJECTED' AND a.status='REJECTED') OR (i.status='EXCEPTION' AND a.status='CREDIT_NOTE_REQUESTED'))))
      ORDER BY i.created_at,i.id`,[invoiceId])).rows;
  }
}
