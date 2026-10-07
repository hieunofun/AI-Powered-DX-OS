import { Injectable } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { AuditRepository } from './audit.repository';
import { ImmudbClient,entryMatches } from './immudb/immudb.client';
import { AuditError } from './audit-error';
import { businessLeaves,inspectPackage,merkleRoot,verificationStatus,PACKAGE_VERSION,CANONICALIZATION_VERSION } from './domain/audit-package';
import { utcTimestamp } from './domain/canonical-json';

@Injectable()
export class AuditSealService {
  constructor(private readonly repository:AuditRepository,private readonly ledger:ImmudbClient) {}
  private async safe<T>(work:()=>Promise<T>):Promise<T> {
    try {return await work();} catch(error) {
      if(error instanceof AuditError) throw error;
      throw new AuditError('AUDIT_UNAVAILABLE','Audit operation could not be confirmed. Its durable intent remains available for reconciliation.');
    }
  }
  // A committed workflow outcome is never rolled back or reported as failed just
  // because the independent ledger is unavailable. Its marker is already durable.
  async automatic(invoiceId:string) {
    try {await this.seal(invoiceId,'system:audit');} catch {/* report/reconcile discovers the committed marker */}
  }
  seal(invoiceId:string,actor:string) {
    return this.safe(()=>this.repository.serialized(invoiceId,async c=>{
      const loaded=await this.repository.prepare(c,invoiceId,actor);
      const {pkg,seal,op}=loaded;
      try {
        const inspection=inspectPackage(pkg.package_json);
        if(inspection.packageSha256!==pkg.package_sha256 || inspection.merkleRoot!==pkg.merkle_root || !inspection.manifestMatches)
          throw new AuditError('AUDIT_PACKAGE_TAMPERED','Historical package evidence does not agree; resealing is prohibited.',409);
        let entry=await this.ledger.get(seal.seal_key);
        if(!entry) {
          if(seal.status==='SEALED') throw new AuditError('AUDIT_LEDGER_MISMATCH','Sealed ledger entry is missing.',409);
          await this.repository.dispatch(c,op.id);
          // An uncertain previous INSERT is resolved by stable-key lookup. The
          // ledger primary key prevents duplicates even if an old INSERT finishes late.
          try {await this.ledger.insert(pkg,seal);} catch(error) {
            entry=await this.ledger.get(seal.seal_key);
            if(!entry) throw error;
          }
          entry=await this.ledger.get(seal.seal_key);
        }
        if(!entryMatches(entry,pkg,seal)) throw new AuditError('AUDIT_LEDGER_MISMATCH','Ledger entry identity/root does not agree; overwrite is prohibited.',409);
        const receipt=await this.ledger.proof(seal.seal_key,seal.status==='SEALED'?seal:null);
        if(!entryMatches(receipt.entry,pkg,seal) || (seal.status==='SEALED' &&
          (receipt.txId!==seal.immudb_tx_id || receipt.txHash!==seal.immudb_tx_hash)))
          throw new AuditError('AUDIT_LEDGER_MISMATCH','Ledger transaction identity does not agree.',409);
        if(op) await this.repository.finish(c,loaded,receipt);
        return {invoiceId,packageId:pkg.id,sealId:seal.id,status:'SEALED',sealKey:seal.seal_key,
          packageSha256:pkg.package_sha256,merkleRoot:pkg.merkle_root,immudbTxId:receipt.txId,idempotent:!op};
      } catch(error) {
        try {await this.repository.failure(c,loaded,error instanceof AuditError?error.errorCode:'AUDIT_LEDGER_UNAVAILABLE');} catch {/* original PENDING survives */}
        throw error;
      }
    }));
  }
  detail(invoiceId:string) {return this.safe(()=>this.repository.detail(invoiceId));}
  verify(invoiceId:string,actor:string) {
    return this.safe(()=>this.repository.serialized(invoiceId,async c=>{
      const {pkg,seal}=await this.repository.load(c,invoiceId);
      const opId=await this.repository.verificationIntent(c,pkg,actor);
      let packageHashMatches=false,merkleRootMatches=false,sourceSnapshotMatchesPackage=false,currentRoot:string|null=null;
      const hashStart=performance.now();
      try {
        const checked=inspectPackage(pkg.package_json),p=pkg.package_json;
        packageHashMatches=checked.packageSha256===pkg.package_sha256 && p.packageVersion===PACKAGE_VERSION &&
          p.canonicalizationVersion===CANONICALIZATION_VERSION && p.packageVersion===pkg.package_version &&
          p.canonicalizationVersion===pkg.canonicalization_version && p.invoiceId===pkg.invoice_id &&
          p.matchResultId===pkg.match_result_id && p.approvalCaseId===pkg.approval_case_id &&
          p.finalBusinessState===pkg.final_business_state && p.builtAt===pkg.built_at;
        merkleRootMatches=checked.manifestMatches && checked.merkleRoot===pkg.merkle_root &&
          p.merkleRoot===pkg.merkle_root && p.leafCount===pkg.leaf_count;
      } catch {/* malformed historical package is tampering, never repaired */}
      let hashMs=performance.now()-hashStart;
      const buildStart=performance.now();
      let current:any;
      try {current=await this.repository.current(c,pkg);} catch(error) {
        if(!(error instanceof AuditError && error.getStatus()===404) && packageHashMatches) throw error;
      }
      const packageBuildMs=performance.now()-buildStart;
      const currentHashStart=performance.now();
      if(current) {
        try {
          currentRoot=merkleRoot(businessLeaves(current).map(l=>l.sha256));
          sourceSnapshotMatchesPackage=currentRoot===pkg.merkle_root;
        } catch {
          // Unencodable current evidence (e.g. corrupt JSON metadata containing
          // financial floats) is a failed source check, not a transport outage.
          // Continue independently verifying the original ledger evidence.
          currentRoot=null;sourceSnapshotMatchesPackage=false;
        }
      }
      hashMs+=performance.now()-currentHashStart;
      let immudbEntryMatches=false,immudbCryptographicProofValid=false,available=true,receipt:any=null;
      const ledgerStart=performance.now();
      try {
        const entry=await this.ledger.get(seal.seal_key);
        immudbEntryMatches=entryMatches(entry,pkg,seal);
        if(entry) {
          receipt=await this.ledger.proof(seal.seal_key,seal.status==='SEALED'?seal:null);
          immudbCryptographicProofValid=receipt.verified===true;
          immudbEntryMatches=immudbEntryMatches && entryMatches(receipt.entry,pkg,seal) && seal.status==='SEALED' &&
            receipt.txId===seal.immudb_tx_id && receipt.txHash===seal.immudb_tx_hash &&
            seal.receipt?.txId===seal.immudb_tx_id && seal.receipt?.txHash===seal.immudb_tx_hash &&
            seal.receipt?.stateTxId===seal.immudb_state_tx_id && seal.receipt?.stateHash===seal.immudb_state_hash;
        } else if(seal.status!=='SEALED') available=false;
      } catch(error) {
        if(error instanceof AuditError && error.errorCode==='AUDIT_LEDGER_MISMATCH') immudbCryptographicProofValid=false;
        else available=false;
      }
      const ledgerVerifyMs=performance.now()-ledgerStart;
      const result={invoiceId,packageId:pkg.id,sealId:seal.id,verificationStatus:verificationStatus({
        source:sourceSnapshotMatchesPackage,package:packageHashMatches,merkle:merkleRootMatches,
        entry:immudbEntryMatches,proof:immudbCryptographicProofValid,available}),
      sourceSnapshotMatchesPackage,packageHashMatches,merkleRootMatches,immudbEntryMatches,immudbCryptographicProofValid,
      sealedRoot:pkg.merkle_root,currentRoot,immudbTxId:receipt?.txId??seal.immudb_tx_id,
      verifiedAt:utcTimestamp(new Date()),performance:{packageBuildMs,hashMs,ledgerVerifyMs}};
      await this.repository.verificationResult(c,seal,opId,result);
      return {result,pkg,seal,receipt};
    }));
  }
}
