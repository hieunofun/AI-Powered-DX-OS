/* SPDX-License-Identifier: MIT */
'use strict';
const fs = require('node:fs'), { randomUUID, createHash } = require('node:crypto');
async function send(kind, options) {
  let origin; try { origin = new URL(options.baseUrl); } catch { throw new Error('Simulator requires a valid loopback API origin'); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || !['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) throw new Error('Simulator is restricted to a loopback API origin without embedded credentials');
  if (!/^[a-f0-9-]{36}$/.test(options.sourceId || '') || !options.token || /[\r\n]/.test(options.token)) throw new Error('Configured source ID and server-side simulator token are required');
  const bytes = options.bytes; if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 65536) throw new Error('Simulator input must be 1..65536 bytes');
  let data; try { data = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Simulator input must be JSON for its source contract'); }
  const schema = kind === 'EXTERNAL_ORDER' ? 'openresolve.external-order.v1' : 'openresolve.receiving-sensor.v1';
  if (data?.schema_id !== schema) throw new Error('Simulator input uses another source contract');
  const family = kind === 'EXTERNAL_ORDER' ? 'external-orders' : 'receiving-sensors';
  const response = await fetch(origin.origin + '/apps/openresolve/v1/connectors/' + family + '/' + options.sourceId + '/events', {
    method: 'POST', headers: { Authorization: 'Bearer ' + options.token, 'Content-Type': 'application/json', 'Idempotency-Key': options.idempotencyKey || randomUUID(), 'X-Correlation-ID': options.correlationId || randomUUID() }, body: bytes,
    signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  const result = await response.json();
  if (response.status !== 202) throw new Error('Simulator ingress HTTP ' + response.status + ': ' + (typeof result.code === 'string' ? result.code : 'invalid response'));
  return { simulated_client: true, source_kind: kind, http_status: response.status, transport_sha256: createHash('sha256').update(bytes).digest('hex'), operation: result };
}
async function cli(kind, defaultTokenEnv) {
  const entries = process.argv.slice(2); if (entries.length % 2) throw new Error('Simulator expects --name value pairs');
  const args = Object.fromEntries(Array.from({ length: entries.length / 2 }, (_, index) => [entries[index * 2], entries[index * 2 + 1]]));
  if (Object.keys(args).some(key => !['--base-url', '--source-id', '--input', '--idempotency-key', '--token-env'].includes(key)) || !args['--input']) throw new Error('Use --base-url --source-id --input and optional --token-env/--idempotency-key');
  const stat = fs.statSync(args['--input']); if (!stat.isFile() || stat.size < 1 || stat.size > 65536) throw new Error('Simulator input must be a bounded source JSON file');
  const result = await send(kind, { baseUrl: args['--base-url'], sourceId: args['--source-id'], bytes: fs.readFileSync(args['--input']),
    token: process.env[args['--token-env'] || defaultTokenEnv], idempotencyKey: args['--idempotency-key'] });
  console.log(JSON.stringify(result));
}
module.exports = { send, cli };
