/* SPDX-License-Identifier: MIT */
'use strict';
// Bounded read-only operating baseline on the existing isolated CI stack, not integrated P4/SLO acceptance.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), os = require('node:os');
const { performance } = require('node:perf_hooks'), { createHash } = require('node:crypto'), { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..'), startedAt = new Date().toISOString(), samples = {}, warmups = {}, resources = {}; let failure;
const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
const command = args => execFileSync(docker, args, { cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 4 * 1048576 });
const api = 'http://127.0.0.1:4000', auth = 'http://127.0.0.1:8080/realms/smartprocure/protocol/openid-connect/token';
async function sample(route, token) {
  const at = performance.now();
  try {
    const response = await fetch(api + route, { headers: token ? { Authorization: 'Bearer ' + token } : {}, signal: AbortSignal.timeout(15000) });
    const bytes = Buffer.from(await response.arrayBuffer()); assert.ok(bytes.length <= 1048576, 'Fixture response exceeded one MiB');
    const result = { elapsedMs: performance.now() - at, status: response.status, bytes: bytes.length };
    if (response.status === 200) {
      const body = JSON.parse(bytes.toString()); if (route === '/health') assert.equal(body.status, 'ok');
      else { assert.ok(Array.isArray(body.data)); assert.ok(body.data.length <= 10); result.returnedRows = body.data.length; result.totalRows = body.total; }
    } return result;
  } catch (error) { return { elapsedMs: performance.now() - at, error: error.code || error.name }; }
}
async function main() {
  if (process.env.CI !== 'true' || !process.argv.includes('--legacy-fixture')) throw new Error('Explicit isolated CI --legacy-fixture required');
  const ids = command(['compose', 'ps', '-q']).trim().split(/\r?\n/).filter(Boolean); assert.ok(ids.length >= 5, 'Expected the actual composed legacy fixture');
  resources.containerIds = ids; const context = command(['context', 'show']).trim(); resources.dockerContext = context;
  // Only known fixture password/client and loopback endpoints; token remains in memory.
  const tokenResponse = await fetch(auth, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: 'smartprocure-ci', grant_type: 'password', username: 'buyer.demo', password: process.env.DEMO_PASSWORD || 'DemoPassword123!' }), signal: AbortSignal.timeout(15000) });
  assert.equal(tokenResponse.status, 200, 'Actual fixture Keycloak authentication failed'); const body = await tokenResponse.json(); assert.ok(typeof body.access_token === 'string');
  const unauthorized = await sample('/purchase-orders?page=1&limit=10'); assert.equal(unauthorized.status, 401, 'Protected read requires actual verified authentication'); resources.unauthenticatedReadStatus = unauthorized.status;
  for (const [name, route, token] of [['health', '/health', undefined], ['purchaseOrderPage', '/purchase-orders?page=1&limit=10', body.access_token]]) {
    warmups[name] = []; for (let index = 0; index < 2; index++) warmups[name].push(await sample(route, token));
    samples[name] = []; for (let index = 0; index < 20; index++) samples[name].push(await sample(route, token));
  }
  resources.containerStats = command(['stats', '--no-stream', '--format', '{{json .}}', ...ids]).trim().split(/\r?\n/).filter(Boolean).map(line => {
    const row = JSON.parse(line); return { id: row.ID, name: row.Name, cpuPercent: row.CPUPerc, memoryUsageLimit: row.MemUsage, memoryPercent: row.MemPerc, processes: row.PIDs, networkIO: row.NetIO, blockIO: row.BlockIO };
  });
  if ([...Object.values(samples), ...Object.values(warmups)].flat().some(row => row.status !== 200 || row.error)) { failure = { code: 'BASELINE_REQUEST_FAILED' }; process.exitCode = 1; }
}
main().catch(error => { failure = { code: error.code || error.name, message: error.message }; console.error('FAIL legacy operating baseline: ' + failure.code); process.exitCode = 1; }).finally(() => {
  const metrics = Object.fromEntries(['health', 'purchaseOrderPage'].map(name => {
    const rows = samples[name] || [], successful = rows.filter(row => row.status === 200 && !row.error), sorted = successful.map(row => row.elapsedMs).sort((a, b) => a - b);
    return [name, { plannedRequests: 20, attemptedRequests: rows.length, successfulRequests: successful.length, failedOrMissingRequests: 20 - successful.length, successfulNearestRankP95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
      note: 'Success-only latency; errors/missing remain explicit. No SLO/pass claim from this percentile.' }];
  }));
  const sourceFiles = ['infra/acceptance/measure-legacy-baseline.cjs', 'apps/api/src/purchase-orders/purchase-orders.controller.ts', 'apps/api/src/purchase-orders/purchase-orders.repository.ts', 'apps/api/src/auth/auth.service.ts', 'docker-compose.yml'];
  const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
  const report = { issue: 66, profile: 'DIRECT_LEGACY_API_READ_BASELINE', acceptanceStatus: 'PARTIAL', startedAt, finishedAt: new Date().toISOString(), candidateCommit: process.env.ACCEPTANCE_CANDIDATE_SHA || null, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    environment: { node: process.version, platform: process.platform, architecture: process.arch, kernel: os.release(), cpuThreads: os.cpus().length, hostMemoryBytes: os.totalmem(), nodeMemory: process.memoryUsage() },
    workload: { concurrency: 1, perEndpointWarmups: 2, perEndpointMeasuredRequests: 20, method: 'GET; consume entire response', healthEndpoint: api + '/health', businessEndpoint: api + '/purchase-orders?page=1&limit=10', authentication: 'actual loopback Keycloak/buyer.demo JWT; no token retained', setup: 'after existing real legacy acceptance on isolated CI fixture', databaseRows: 'actual current synthetic CI purchase-order state, returned/total counts retained per sample' },
    metrics, samples, warmups, resources, sourceHashes, modelRequestsByThisWorkload: 0, actualModelBill: null,
    limitations: ['Legacy direct NestJS/JWT/PostgreSQL reads, not APISIX/end-to-end P4 tenant/domain runtime', 'Twenty serial samples per endpoint; no saturation/load/production sizing or SLO claim', 'Docker stats is one actual point-in-time snapshot, not peak resource measurement', 'No integrated AT qualification, external ingress/case/decision/export throughput or paid-model cost claim'], ...(failure ? { failure } : {}) };
  const directory = path.join(root, 'docs/acceptance/evidence'); fs.mkdirSync(directory, { recursive: true }); const target = path.join(directory, 'issue66-operating-baseline-' + new Date().toISOString().replace(/\D/g, '') + '.json'); fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log('Retained ' + path.relative(root, target));
});
