import { ImmudbClient,LEDGER_COLUMNS,normalizeLedgerRow } from './immudb.client';

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

describe('Historical receipt routing',()=>{
  const key=row.seal_key,receipt={verified:true,entry:row,txId:'2',txHash:'a'.repeat(64),stateTxId:'3',stateHash:'b'.repeat(64),rowProof:{},transactionHeader:{}};
  const seal={status:'SEALED',immudb_tx_id:'2',immudb_tx_hash:'a'.repeat(64),immudb_state_tx_id:'3',immudb_state_hash:'b'.repeat(64),receipt};
  let adapter:ImmudbClient,priorEpoch:string|undefined;
  beforeEach(()=>{priorEpoch=process.env.IMMUDB_LEDGER_EPOCH;process.env.IMMUDB_LEDGER_EPOCH='apache-d5f425e-opendx-1';adapter=new ImmudbClient();});
  afterEach(async()=>{jest.restoreAllMocks();await adapter.onModuleDestroy();if(priorEpoch===undefined)delete process.env.IMMUDB_LEDGER_EPOCH;else process.env.IMMUDB_LEDGER_EPOCH=priorEpoch;});
  it('uses original database anchors to verify an old sealed entry through the archive',async()=>{
    const fetcher=jest.spyOn(global,'fetch').mockResolvedValue(new Response(JSON.stringify(receipt),{status:200}));
    expect(await adapter.get(key,seal)).toEqual(row);
    expect(fetcher.mock.calls[0][0]).toMatch(/\/historical\/verify$/);
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({sealKey:key,txId:'2',txHash:seal.immudb_tx_hash,stateTxId:'3',stateHash:seal.immudb_state_hash});
  });
  it.each([404,409,503])('does not fall back to the active ledger after archive HTTP %s',async status=>{
    const fetcher=jest.spyOn(global,'fetch').mockResolvedValue(new Response('{}',{status}));
    await expect(adapter.get(key,seal)).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toMatch(/\/historical\/verify$/);
  });
  it('checks a new receipt on the active epoch with its retained server UUID',async()=>{
    const current={...seal,receipt:{...receipt,ledgerEpoch:'apache-d5f425e-opendx-1',serverUUID:'original-server'}};
    const fetcher=jest.spyOn(global,'fetch').mockResolvedValue(new Response(JSON.stringify(current.receipt),{status:200}));
    await adapter.proof(key,current);expect(fetcher.mock.calls[0][0]).toMatch(/\/verify$/);
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string).serverUUID).toBe('original-server');
  });
  it('rejects loss of a retained new-epoch UUID before contacting the ledger',async()=>{
    const current={...seal,receipt:{...receipt,ledgerEpoch:'apache-d5f425e-opendx-1'}};
    const fetcher=jest.spyOn(global,'fetch');await expect(adapter.proof(key,current)).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([{ledgerEpoch:'another-epoch',serverUUID:'original-server'},{ledgerEpoch:'apache-d5f425e-opendx-1',serverUUID:'replaced-server'}])('rejects a returned epoch/UUID replacement %j',async identity=>{
    const current={...seal,receipt:{...receipt,ledgerEpoch:'apache-d5f425e-opendx-1',serverUUID:'original-server'}};
    jest.spyOn(global,'fetch').mockResolvedValue(new Response(JSON.stringify({...receipt,...identity}),{status:200}));
    await expect(adapter.proof(key,current)).rejects.toThrow();
  });
});
