import { Injectable,OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { AuditError } from '../audit-error';
import { utcTimestamp } from '../domain/canonical-json';

export const LEDGER_TABLE_SQL=`CREATE TABLE IF NOT EXISTS smartprocure_audit_seals (
  seal_key VARCHAR[150],invoice_id VARCHAR[36],audit_package_id VARCHAR[36],package_version VARCHAR[30],
  package_sha256 VARCHAR[64],merkle_root VARCHAR[64],final_business_state VARCHAR[50],sealed_at VARCHAR[40],
  PRIMARY KEY seal_key)`;
export const LEDGER_COLUMNS='seal_key,invoice_id,audit_package_id,package_version,package_sha256,merkle_root,final_business_state,sealed_at';
export function immudbOptions() {
  const raw=Number(process.env.IMMUDB_TIMEOUT_MS||10000);
  const timeout=Number.isFinite(raw)?Math.min(30000,Math.max(100,raw)):10000;
  return {host:process.env.IMMUDB_HOST||'smartprocure-immudb',port:Number(process.env.IMMUDB_PGSQL_PORT||5432),
    database:process.env.IMMUDB_DATABASE||'defaultdb',user:process.env.IMMUDB_USERNAME||'immudb',password:process.env.IMMUDB_PASSWORD,
    ssl:process.env.IMMUDB_SSL==='true'?{rejectUnauthorized:true}:false,
    // v1.11.0 caches parsed SQL per wire session; WHERE substitution mutates
    // that cached AST. Retire each checked-out session so a later seal key
    // cannot inherit the first query's bound parameter. Queries stay static.
    connectionTimeoutMillis:timeout,query_timeout:timeout,idleTimeoutMillis:10000,max:5,maxUses:1};
}
@Injectable()
export class ImmudbClient implements OnModuleDestroy {
  // Independent ledger pool: never borrow the application's PostgreSQL pool.
  private readonly pool=new Pool(immudbOptions());
  constructor() {this.pool.on('error',()=>{/* safe operation errors are recorded by the service */});}
  async onModuleDestroy() {await this.pool.end();}
  async state() {return (await this.pool.query('SELECT immudb_state()')).rows[0];}
  async get(sealKey:string) {
    const rows=(await this.pool.query('SELECT '+LEDGER_COLUMNS+' FROM smartprocure_audit_seals WHERE seal_key=$1',[sealKey])).rows;
    if(rows.length>1) throw new AuditError('AUDIT_LEDGER_MISMATCH','Ledger identity is inconsistent.',409);
    return rows[0]??null;
  }
  async insert(pkg:any,seal:any) {
    // INSERT only. Never UPSERT/UPDATE an existing historical ledger entry.
    await this.pool.query(`INSERT INTO smartprocure_audit_seals (${LEDGER_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [seal.seal_key,pkg.invoice_id,pkg.id,pkg.package_version,pkg.package_sha256,pkg.merkle_root,pkg.final_business_state,utcTimestamp(new Date())]);
  }
  async proof(sealKey:string,seal:any=null) {
    const url=process.env.IMMUDB_VERIFIER_URL||'http://smartprocure-audit-verifier:8081';
    const response=await fetch(url+'/verify',{method:'POST',headers:{'Content-Type':'application/json',
      Authorization:'Bearer '+(process.env.IMMUDB_VERIFIER_TOKEN||'')},body:JSON.stringify({sealKey,
        ...(seal?{stateTxId:seal.immudb_state_tx_id,stateHash:seal.immudb_state_hash}:{})}),
      signal:AbortSignal.timeout(immudbOptions().query_timeout)});
    if(response.status===409 || response.status===404) throw new AuditError('AUDIT_LEDGER_MISMATCH','Ledger cryptographic evidence does not agree.',409);
    if(!response.ok) throw new AuditError('AUDIT_LEDGER_UNAVAILABLE','Ledger verifier is unavailable.');
    const proof:any=await response.json();
    if(proof.verified!==true || !/^[1-9]\d*$/.test(proof.txId) || !/^[1-9]\d*$/.test(proof.stateTxId) ||
      !/^[0-9a-f]{64}$/.test(proof.txHash) || !/^[0-9a-f]{64}$/.test(proof.stateHash) || !proof.rowProof || !proof.transactionHeader)
      throw new AuditError('AUDIT_LEDGER_MISMATCH','Ledger cryptographic evidence is incomplete.',409);
    return proof;
  }
}
export function entryMatches(entry:any,pkg:any,seal:any) {
  if(!entry) return false;
  return entry.seal_key===seal.seal_key && entry.seal_key==='smartprocure:audit:invoice:'+pkg.invoice_id+':v1' &&
    entry.invoice_id===pkg.invoice_id && entry.audit_package_id===pkg.id && entry.package_version===pkg.package_version &&
    entry.package_sha256===pkg.package_sha256 && entry.package_sha256===seal.package_sha256 &&
    entry.merkle_root===pkg.merkle_root && entry.merkle_root===seal.merkle_root && entry.final_business_state===pkg.final_business_state &&
    typeof entry.sealed_at==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(entry.sealed_at);
}
