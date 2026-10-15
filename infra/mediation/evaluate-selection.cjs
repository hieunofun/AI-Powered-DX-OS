/* SPDX-License-Identifier: MIT */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { createHash, randomUUID } = require('node:crypto'), { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..'), directory = path.join(__dirname, 'fixtures'), sha = bytes => createHash('sha256').update(bytes).digest('hex');
if (!process.argv.includes('--live') || !process.argv.includes('--env-file')) throw new Error('Explicit live synthetic evaluation and ignored backend env-file required');
const privateFile = process.argv[process.argv.indexOf('--env-file') + 1]; if (!privateFile || !fs.existsSync(privateFile)) throw new Error('Ignored backend env unavailable');
const values = Object.fromEntries(fs.readFileSync(privateFile, 'utf8').split(/\r?\n/).filter(line => /^(GEMINI_API_KEY|GEMINI_MODEL)=/.test(line)).map(line => {
  const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
if (!values.GEMINI_API_KEY) throw new Error('Backend provider key unavailable');
const load = file => require(path.join(root, 'apps/api/dist', file));
const { GeminiExplanationProvider } = load('packs/openresolve/mediation/gemini-explanation.provider.js'), { grounded } = load('packs/openresolve/mediation/mediation-validation.js');
const { geminiConfig } = load('ai/extraction/provider-config.js'), { LocalProviderBudget } = load('ai/extraction/provider-budget.js');
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
assert.equal(manifest.version, 'case-extractive-synthetic-v1'); assert.equal(manifest.disclosure, 'SYNTHETIC');
assert.equal(manifest.sources.path, 'selection-inputs.json'); assert.equal(manifest.labels.path, 'selection-labels.json');
const source = fs.readFileSync(path.join(directory, manifest.sources.path)); assert.equal(sha(source), manifest.sources.sha256);
const cases = JSON.parse(source); assert.equal(cases.length, 8); assert.equal(new Set(cases.map(c => c.id)).size, 8);
assert.equal(cases.filter(c => c.split === 'dev').length, 4); assert.equal(cases.filter(c => c.split === 'held-out').length, 4);
const config = geminiConfig({ ...values, AI_DOCUMENT_POLICY: 'synthetic-only', AI_REQUESTS_PER_MINUTE: '20', AI_REQUESTS_PER_DAY: '20', AI_TOKENS_PER_DAY: '60000', AI_TIMEOUT_MS: '30000', AI_MAX_INPUT_TOKENS: '3000', AI_MAX_OUTPUT_TOKENS: '1024' });
const budget = new LocalProviderBudget(config), provider = new GeminiExplanationProvider(config, fetch, budget), started = new Date().toISOString(), results = [];
const sourceHashes = Object.fromEntries(fs.readdirSync(path.join(root, 'apps/api/src/packs/openresolve/mediation')).filter(file => file.endsWith('.ts') && !file.endsWith('.spec.ts')).map(file => {
  const name = 'apps/api/src/packs/openresolve/mediation/' + file; return [name, sha(fs.readFileSync(path.join(root, name)))]; }));
async function main() {
  for (const item of cases) {
    const begin = performance.now();
    try {
      const selection = await provider.select({ question: item.question, facts: item.facts, tools: ['case.read_summary', 'case.request_evidence', 'case.add_note'] }, 'SYNTHETIC', async () => undefined);
      // Offline authorization/confirmation fixtures only; no fake runtime Evidence/Case is persisted.
      const snapshot = { facts: item.facts.map(f => ({ ...f, id: randomUUID(), evidenceId: randomUUID(), evidenceHash: sha(Buffer.from(item.id)), factsVersion: 'fictional-confirmed-v1' })), requiredFactCodes: item.required_codes };
      const result = grounded(snapshot, selection); results.push({ id: item.id, split: item.split, status: 'PASS', selection, result, elapsedMs: Math.round(performance.now() - begin) }); console.log('GENERATED ' + item.id);
    } catch (error) { results.push({ id: item.id, split: item.split, status: 'FAIL', code: error.code || error.name, elapsedMs: Math.round(performance.now() - begin) }); console.log('FAIL ' + item.id + ' ' + (error.code || error.name)); }
  }
  // Gold labels are first opened after all provider outputs have been finalized.
  const labelsBytes = fs.readFileSync(path.join(directory, manifest.labels.path)); assert.equal(sha(labelsBytes), manifest.labels.sha256); const labels = JSON.parse(labelsBytes);
  for (const result of results) {
    const gold = labels[result.id]; assert(gold); if (result.status !== 'PASS') continue;
    result.relevantAliasesExact = JSON.stringify([...result.selection.fact_aliases].sort()) === JSON.stringify([...gold.fact_aliases].sort());
    result.missingEvidenceExact = JSON.stringify([...result.result.missing_evidence].sort()) === JSON.stringify([...gold.missing_evidence].sort());
  }
  for (const [name, hash] of Object.entries(sourceHashes)) assert.equal(sha(fs.readFileSync(path.join(root, name))), hash, 'Code changed during live evaluation');
}
main().catch(error => { console.error('FAIL synthetic evaluation: ' + (error.code || error.name)); process.exitCode = 1; }).finally(() => {
  const metrics = Object.fromEntries(['dev', 'held-out'].map(split => {
    const selected = results.filter(r => r.split === split); return [split, { denominator: selected.length, validResponses: selected.filter(r => r.status === 'PASS').length,
      exactRelevantAliases: selected.filter(r => r.relevantAliasesExact).length, exactServerMissingEvidence: selected.filter(r => r.missingEvidenceExact).length }]; }));
  const times = results.filter(r => r.status === 'PASS').map(r => r.elapsedMs).sort((a, b) => a - b);
  const report = { started, completed: new Date().toISOString(), gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    worktreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()), sourceHashes,
    manifest, environment: { node: process.version, platform: process.platform, provider: 'actual Gemini REST; fictional authorized-facts fixtures, no database or production decision/SSO claim', model: config.model },
    metrics, providerBudget: budget.snapshot(), p95Ms: times[Math.ceil(times.length * 0.95) - 1] || null, modelSamples: times.length,
    toolsExecuted: 0, actualProviderBill: null, results, limitations: manifest.limitations };
  const output = path.join(root, 'docs/ai/evidence/issue54-explanation-evaluation-' + started.replaceAll(/[^0-9]/g, '') + '.json'); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: path.relative(root, output), metrics, providerBudget: report.providerBudget, p95Ms: report.p95Ms }));
  if (results.length !== 8 || results.some(r => r.status !== 'PASS' || !r.relevantAliasesExact || !r.missingEvidenceExact)) process.exitCode = 1;
});
