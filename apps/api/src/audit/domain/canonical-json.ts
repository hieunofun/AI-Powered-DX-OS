import { createHash } from 'node:crypto';

// Project format SP-CJSON-1, deliberately not an RFC 8785 claim. Numbers are
// reserved for exact integer counts; financial/NUMERIC data must be strings.
export function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  const encode = (v: unknown): string => {
    if (v === null) return 'null';
    if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v) || Object.is(v,-0)) throw new Error('Canonical numbers must be safe integers');
      return String(v);
    }
    if (typeof v !== 'object' || v === undefined) throw new Error('Unsupported canonical value');
    if (active.has(v)) throw new Error('Cyclic canonical value');
    active.add(v);
    try {
      if (Array.isArray(v)) {
        for (let i=0;i<v.length;i++) if (!(i in v)) throw new Error('Sparse canonical array');
        return '['+v.map(encode).join(',')+']';
      }
      if (Object.getPrototypeOf(v)!==Object.prototype && Object.getPrototypeOf(v)!==null) throw new Error('Canonical objects must be plain');
      if (Object.getOwnPropertySymbols(v).length) throw new Error('Symbol keys are unsupported');
      return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+encode((v as any)[k])).join(',')+'}';
    } finally { active.delete(v); }
  };
  return encode(value);
}
export const sha256 = (value: string|Buffer): string => createHash('sha256').update(value).digest('hex');
export const hashJson = (value: unknown): string => sha256(canonicalJson(value));
export function canonicalUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('Invalid UUID');
  return value.toLowerCase();
}
// Preserve PostgreSQL microseconds instead of losing them in pg's Date parser.
export function utcTimestamp(value: string|Date): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('Invalid timestamp');
    return value.toISOString().replace(/(\.\d{3})Z$/,'$1000Z');
  }
  if (!/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d(?::?\d\d)?)$/.test(value)) throw new Error('Timestamp needs explicit timezone');
  const fraction=(value.match(/\.(\d+)/)?.[1]??'').padEnd(6,'0');
  const iso=new Date(value.replace(' ','T').replace(/([+-]\d\d)$/,'$1:00')).toISOString();
  return iso.replace(/\.\d{3}Z$/,'.'+fraction+'Z');
}
