/* SPDX-License-Identifier: MIT */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateDataset } = require('./validate-dataset.cjs');
const repo = path.resolve(__dirname, '../..');
require('ts-node').register({ project: path.join(repo, 'apps/api/tsconfig.json') });
const { createExtractionProvider } = require(path.join(repo, 'apps/api/src/ai/extraction/ai-extraction.module.ts'));
const { scoreExtractions } = require(path.join(repo, 'apps/api/src/ai/extraction/evaluation.ts'));

async function main() {
  const args = process.argv.slice(2);
  const option = key => args.find(arg => arg.startsWith('--' + key + '='))?.slice(key.length + 3);
  const split = option('split'), predictionsPath = option('predictions'), out = option('out');
  const live = args.includes('--live');
  if (args.some(arg => arg !== '--live' && !/^--(?:split|predictions|out)=.+$/.test(arg)) ||
    !['dev', 'held-out'].includes(split) || live === Boolean(predictionsPath)) {
    throw new Error('Use --split=dev|held-out and exactly one of --live or --predictions=FILE; optional --out=FILE.');
  }
  const root = path.join(__dirname, 'datasets', 'vn-synthetic-v1');
  const { manifest } = validateDataset(root);
  const selected = manifest.cases.filter(sample => sample.split === split);
  let predictions;
  if (live) {
    if (process.env.AI_PROVIDER !== 'gemini') throw new Error('Live evaluation requires AI_PROVIDER=gemini and GEMINI_API_KEY.');
    const provider = createExtractionProvider();
    predictions = [];
    for (const sample of selected) {
      try {
        // Only source bytes and schema field descriptions reach the provider.
        // Gold labels are read after every extraction completes.
        const result = await provider.extract({ evidenceId: randomUUID(), schemaId: manifest.schema_id,
          bytes: fs.readFileSync(path.join(root, sample.source)), mediaType: sample.media_type,
          disclosure: 'SYNTHETIC', fields: manifest.fields });
        predictions.push({ id: sample.id, fields: result.fields, extractor: result.extractor, usage: result.usage });
      } catch (error) {
        predictions.push({ id: sample.id, error: error.code || 'UNAVAILABLE', run_id: error.runId });
      }
    }
  } else {
    const file = JSON.parse(fs.readFileSync(path.resolve(predictionsPath), 'utf8'));
    if (file.dataset_version !== manifest.version || file.split !== split || !Array.isArray(file.predictions)) {
      throw new Error('Prediction dataset version/split does not match the selected evaluation.');
    }
    predictions = file.predictions;
  }
  const truth = selected.map(sample => ({ id: sample.id, fields: JSON.parse(fs.readFileSync(path.join(root, sample.labels), 'utf8')).fields }));
  const report = { dataset_version: manifest.version, split, mode: live ? 'LIVE_PROVIDER' : 'OFFLINE_PREDICTIONS',
    synthetic: true, liveProviderInvoked: live,
    ...scoreExtractions(truth, predictions), predictions };
  if (out) fs.writeFileSync(path.resolve(out), JSON.stringify(report, null, 2) + '\n');
  const { predictions: _predictions, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
  if (report.failedCases > 0) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
