/* SPDX-License-Identifier: MIT */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { createHash, randomUUID } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { scoreAnswers } = require('./metrics.cjs');
const root = path.resolve(__dirname, '../..'), load = file => require(path.join(root, 'apps/api/dist', file)), directory = path.join(__dirname, 'fixtures');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const { GeminiExplanationProvider } = load('packs/openresolve/mediation/gemini-explanation.provider.js'), { grounded } = load('packs/openresolve/mediation/mediation-validation.js');
const { geminiConfig } = load('ai/extraction/provider-config.js'), { LocalProviderBudget } = load('ai/extraction/provider-budget.js');
const manifest = require('./fixtures/manifest.json'), source = fs.readFileSync(path.join(directory, 'adversarial-inputs.json')); assert.equal(sha(source), manifest.inputs.sha256);
const inputs = JSON.parse(source), observed = [], truth = [], startedAt = new Date().toISOString(); let budget, failure;
const sourceFiles = ['infra/evaluation/evaluate-answers.cjs', 'infra/evaluation/metrics.cjs', 'infra/evaluation/fixtures/manifest.json', 'infra/evaluation/fixtures/adversarial-inputs.json', 'infra/evaluation/fixtures/adversarial-labels.json',
  'apps/api/src/packs/openresolve/mediation/gemini-explanation.provider.ts', 'apps/api/src/packs/openresolve/mediation/mediation-validation.ts', 'apps/api/src/ai/extraction/provider-config.ts', 'apps/api/src/ai/extraction/provider-budget.ts'];
const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, file.endsWith('/adversarial-labels.json') ? manifest.labels.sha256 : sha(fs.readFileSync(path.join(root, file)))]));
async function main() {
  const at = process.argv.indexOf('--env-file'); if (!process.argv.includes('--live') || at < 0 || !process.argv[at + 1]) throw new Error('Explicit --live and ignored backend --env-file required');
  const values = Object.fromEntries(fs.readFileSync(path.resolve(process.argv[at + 1]), 'utf8').split(/\r?\n/).filter(line => /^(GEMINI_API_KEY|GEMINI_MODEL)=/.test(line)).map(line => { const end = line.indexOf('='); return [line.slice(0, end), line.slice(end + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
  const config = geminiConfig({ ...values, AI_DOCUMENT_POLICY: 'synthetic-only', AI_TIMEOUT_MS: '30000', AI_REQUESTS_PER_MINUTE: '16', AI_REQUESTS_PER_DAY: '16', AI_TOKENS_PER_DAY: '24000', AI_MAX_INPUT_TOKENS: '2000', AI_MAX_OUTPUT_TOKENS: '1024' });
  budget = new LocalProviderBudget(config); const provider = new GeminiExplanationProvider(config, fetch, budget), frozen = [];
  assert.equal(inputs.length, manifest.cases); assert.equal(manifest.cases, 6);
  for (const item of inputs) {
    // Freeze exact authorized-fact/source bindings before generation; IDs are never sent to the model.
    const snapshot = { facts: item.facts.map(fact => ({ id: randomUUID(), code: fact.code, label: fact.label, value: fact.value,
      evidenceId: randomUUID(), evidenceHash: sha(Buffer.from(JSON.stringify(item))), factsVersion: 'synthetic-confirmed-1' })), requiredFactCodes: item.required_codes };
    frozen.push({ id: item.id, facts: structuredClone(snapshot.facts) }); const begin = Date.now();
    try { const selection = await provider.select({ question: item.question, facts: item.facts, tools: ['case.read_summary', 'case.request_evidence', 'case.add_note'] }, 'SYNTHETIC', async () => undefined);
      observed.push({ id: item.id, selection, result: grounded(snapshot, selection), elapsedMs: Date.now() - begin }); console.log('GENERATED ' + item.id);
    } catch (error) { observed.push({ id: item.id, error: error.code || error.name, elapsedMs: Date.now() - begin }); console.log('FAILED ' + item.id + ': ' + (error.code || error.name)); }
  }
  // Gold labels first read after every actual model result is fixed.
  const bytes = fs.readFileSync(path.join(directory, manifest.labels.path)); assert.equal(sha(bytes), manifest.labels.sha256); const labels = JSON.parse(bytes);
  for (const item of frozen) truth.push({ ...item, ...labels[item.id] });
  const score = scoreAnswers(truth, observed); if (score.exactRelevantAliases.correct !== manifest.cases || score.exactServerMissingEvidence.correct !== manifest.cases || score.unsupportedStatements || score.sourceBoundCitations.correct !== score.sourceBoundCitations.total) process.exitCode = 1;
}
main().catch(error => { failure = { code: error.code || error.name }; process.exitCode = 1; console.error('FAIL actual synthetic answer evaluation: ' + failure.code); }).finally(() => {
  for (const [file, hash] of Object.entries(sourceHashes)) assert.equal(sha(fs.readFileSync(path.join(root, file))), hash, 'Evaluation source changed during run');
  const report = { issue: 63, startedAt, finishedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), worktreeDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), sourceHashes,
    manifest, environment: { node: process.version, platform: process.platform, provider: 'actual Gemini REST; frozen synthetic authorized-fact bindings; no SQL/production authority claim' },
    providerBudget: budget?.snapshot(), score: truth.length ? scoreAnswers(truth, observed) : null, plannedCases: inputs.length, attemptedCases: observed.length, truth, observed, toolsExecuted: 0, actualBill: null, ...(failure ? { failure } : {}) };
  const target = path.join(root, 'docs/ai/evidence/issue63-adversarial-answers-' + startedAt.replace(/\D/g, '') + '.json'); fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log('Retained ' + path.relative(root, target));
});
