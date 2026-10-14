import { LEDGER_COLUMNS,normalizeLedgerRow } from './immudb.client';

const row={seal_key:'smartprocure:audit:invoice:11111111-1111-4111-8111-111111111111:v1',
  invoice_id:'11111111-1111-4111-8111-111111111111',audit_package_id:'22222222-2222-4222-8222-222222222222',
  package_version:'SMARTPROCURE-AUDIT-1',package_sha256:'a'.repeat(64),merkle_root:'b'.repeat(64),
  final_business_state:'READY_FOR_PAYMENT',sealed_at:'2026-10-14T00:00:00.000000Z'};

describe('Exact ledger wire column identity',()=>{
  it('preserves the bare v1.11.0 row and normalizes the observed Apache labels without changing values',()=>{
    expect(normalizeLedgerRow(row)).toEqual(row);
    const qualified=Object.fromEntries(Object.entries(row).map(([name,value])=>['(smartprocure_audit_seals.'+name+')',value]));
    expect(normalizeLedgerRow(qualified)).toEqual(row);
  });
  it('rejects another table, duplicate aliases, unknown and missing identity columns',()=>{
    expect(()=>normalizeLedgerRow({...row,'(other.seal_key)':row.seal_key})).toThrow();
    expect(()=>normalizeLedgerRow({...row,'(smartprocure_audit_seals.seal_key)':row.seal_key})).toThrow();
    expect(()=>normalizeLedgerRow({...row,verified:true})).toThrow();
    const partial=Object.fromEntries(LEDGER_COLUMNS.split(',').filter(name=>name!=='invoice_id').map(name=>[name,row[name]]));
    expect(()=>normalizeLedgerRow(partial)).toThrow();
  });
});
