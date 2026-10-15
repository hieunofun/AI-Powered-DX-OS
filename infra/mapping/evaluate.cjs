/* SPDX-License-Identifier: MIT */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { createHash } = require('node:crypto'), { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..'), built = name => require(path.join(root, 'apps/api/dist', name));
const { GeminiMappingProvider } = built('packs/openresolve/mapping/gemini-mapping.provider.js'), { ReviewedMappingEngine } = built('packs/openresolve/mapping/mapping-engine.js');
const { geminiConfig } = built('ai/extraction/provider-config.js'), { LocalProviderBudget } = built('ai/extraction/provider-budget.js');
const corpus = path.join(__dirname, 'fixtures/vn-mapping-synthetic-v1'), manifest = require(path.join(corpus, 'manifest.json'));
const checks = [], cases = [], started = new Date().toISOString(); let budget;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const implementation = ['mapping-engine.ts', 'gemini-mapping.provider.ts', 'mapping.types.ts'].map(file => 'apps/api/src/packs/openresolve/mapping/' + file);
const sourceHashes = Object.fromEntries(implementation.map(file => [file, sha(fs.readFileSync(path.join(root, file)))]));
const safe = (relative, folder) => { const target = path.resolve(corpus, relative); if (!target.startsWith(path.join(corpus, folder) + path.sep)) throw new Error('Corpus path escapes allowlist'); return target; };
async function main() {
  if (!process.argv.includes('--live')) throw new Error('Explicit --live required');
  const at = process.argv.indexOf('--env-file'); if (at === -1) throw new Error('Ignored server-side --env-file required');
  assert.equal(manifest.synthetic, true); assert.equal(manifest.cases.length, 10);
  const credentials = Object.fromEntries(fs.readFileSync(path.resolve(process.argv[at + 1]), 'utf8').split(/\r?\n/).filter(line => /^(GEMINI_API_KEY|GEMINI_MODEL)=/.test(line))
    .map(line => { const end = line.indexOf('='); return [line.slice(0, end), line.slice(end + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
  const config = geminiConfig({ ...credentials, AI_DOCUMENT_POLICY: 'synthetic-only', AI_REQUESTS_PER_MINUTE: '30', AI_REQUESTS_PER_DAY: '30', AI_TOKENS_PER_DAY: '100000' });
  budget = new LocalProviderBudget(config); const engine = new ReviewedMappingEngine(new GeminiMappingProvider(config, undefined, budget));
  for (const entry of manifest.cases) {
    const bytes = fs.readFileSync(safe(entry.source, 'sources')); assert.equal(sha(bytes), entry.sha256); const snapshot = JSON.parse(bytes);
    const begin = performance.now();
    const result = await engine.suggest({ tenantId: snapshot.tenantId, subject: 'synthetic-mapping-evaluator' }, snapshot, 'SYNTHETIC', async () => assert.equal(sha(bytes), entry.sha256));
    const durationMs = Math.round(performance.now() - begin);
    // Labels are opened only after this case's actual model/deterministic work completes.
    const expected = JSON.parse(fs.readFileSync(safe(entry.label, 'labels'), 'utf8'));
    const selected = result.candidates.map(candidate => candidate.po_item_id).sort();
    const exact = result.resolution === expected.resolution && JSON.stringify(selected) === JSON.stringify([...expected.candidate_ids].sort());
    assert.equal(result.state, 'REVIEW_REQUIRED'); assert.ok(selected.every(id => snapshot.candidates.some(candidate => candidate.id === id)));
    cases.push({ id: entry.id, split: entry.split, source_sha256: entry.sha256, durationMs, exact, expected, result });
    console.log((exact ? 'MATCH ' : 'MISMATCH ') + entry.id + ': ' + result.method + '/' + result.resolution);
  }
  checks.push({ name: 'all cases retain human review and authorized catalog IDs', status: 'PASS' });
  for (const [file, expected] of Object.entries(sourceHashes)) assert.equal(sha(fs.readFileSync(path.join(root, file))), expected, 'Implementation changed during evaluation');
}
main().catch(error => { console.error('FAIL mapping evaluation: ' + (error.code || error.name) + ' ' + String(error.message).slice(0, 300)); process.exitCode = 1; }).finally(() => {
  const scores = {};
  for (const split of ['dev', 'held-out']) {
    const samples = cases.filter(sample => sample.split === split), predicted = samples.filter(sample => sample.result.resolution === 'MATCH');
    scores[split] = { attempted: samples.length, planned: manifest.cases.filter(sample => sample.split === split).length, exact: samples.filter(sample => sample.exact).length,
      denominator: samples.length, match_precision_numerator: predicted.filter(sample => sample.exact).length, match_precision_denominator: predicted.length,
      provider_failures: samples.filter(sample => sample.result.provider_failure).length,
      methods: Object.fromEntries(['DETERMINISTIC', 'GEMINI', 'DETERMINISTIC_FALLBACK'].map(method => [method, samples.filter(sample => sample.result.method === method).length])) };
  }
  const report = { started, completed: new Date().toISOString(), gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), worktreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
    sourceHashes, corpus: manifest.version, environment: { node: process.version, platform: process.platform, provider: 'actual Gemini on synthetic identities only; deterministic paths reported separately', budget: budget?.snapshot() },
    scores, checks, cases, limitations: manifest.limitations };
  const directory = path.join(root, 'docs/ai/evidence'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'issue25-mapping-evaluation-' + started.replaceAll(/[^0-9]/g, '') + '.json'), JSON.stringify(report, null, 2) + '\n');
});
