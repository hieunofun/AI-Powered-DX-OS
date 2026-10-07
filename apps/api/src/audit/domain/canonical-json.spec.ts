import { createHash } from 'node:crypto';
import { canonicalJson,canonicalUuid,hashJson,utcTimestamp } from './canonical-json';
describe('SP-CJSON-1',()=>{
  it('recursively sorts object keys, preserving array business order',()=>{
    expect(canonicalJson({z:[{z:1,a:2},false,null],a:'x'})).toBe('{"a":"x","z":[{"a":2,"z":1},false,null]}');
    expect(hashJson([2,1])).not.toBe(hashJson([1,2]));
  });
  it('preserves Unicode, escaping and exact numeric strings',()=>{
    const value={supplier:'Công ty 日本 🧾',amount:'9999999999999999.99',text:'\n"\\',zero:'0.0000'};
    expect(JSON.parse(canonicalJson(value))).toEqual(value);
    expect(hashJson(value)).toBe(createHash('sha256').update(canonicalJson(value),'utf8').digest('hex'));
    expect(hashJson('é')).not.toBe(hashJson('e\u0301')); // no undocumented Unicode normalization
  });
  it.each([undefined,NaN,Infinity,-Infinity,0.1,-0,Number.MAX_SAFE_INTEGER+1,BigInt(1),new Date(),()=>1])('rejects unsupported %s',v=>expect(()=>canonicalJson(v)).toThrow());
  it('rejects undefined members, sparse arrays, cycles and symbol keys',()=>{
    for(const v of [{x:undefined},[undefined],new Array(2),{[Symbol('x')]:1}]) expect(()=>canonicalJson(v)).toThrow();
    const v:any={};v.self=v;expect(()=>canonicalJson(v)).toThrow();
  });
  it('allows repeated non-cyclic objects and exact integers',()=>{
    const shared={b:2,a:1};expect(canonicalJson([shared,shared])).toBe('[{"a":1,"b":2},{"a":1,"b":2}]');
    expect(canonicalJson([null,true,false,0,Number.MAX_SAFE_INTEGER])).toBe('[null,true,false,0,9007199254740991]');
  });
  it('normalizes timestamp timezones while preserving microseconds',()=>{
    expect(utcTimestamp('2026-10-06 15:00:01.123456+07')).toBe('2026-10-06T08:00:01.123456Z');
    expect(utcTimestamp('2026-10-06T08:00:01Z')).toBe('2026-10-06T08:00:01.000000Z');
    expect(utcTimestamp(new Date('2026-10-06T08:00:01.123Z'))).toBe('2026-10-06T08:00:01.123000Z');
    expect(()=>utcTimestamp('2026-10-06T08:00:01')).toThrow();
  });
  it('canonicalizes UUID casing, not arbitrary business text',()=>{
    expect(canonicalUuid('ABCDEF01-1234-5678-90AB-ABCDEF012345')).toBe('abcdef01-1234-5678-90ab-abcdef012345');
    expect(()=>canonicalUuid('bad')).toThrow();
  });
  it('is independent of object insertion order',()=>{
    const pairs=[['z',null],['é','unicode'],['a',{q:1,b:true}]];
    expect(hashJson(Object.fromEntries(pairs))).toBe(hashJson(Object.fromEntries(pairs.reverse())));
  });
});
