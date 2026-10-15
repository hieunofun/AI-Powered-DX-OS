/* SPDX-License-Identifier: MIT */
'use strict';
// Recompute fixed previously recorded runs; do not pool repeated runs or treat them as fresh samples.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { createHash } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { scoreFields, scoreMappings, scoreAnswers } = require('./metrics.cjs');
const root = path.resolve(__dirname, '../..'), directory = 'docs/ai/evidence/', sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const blobHash = file => sha(execFileSync('git', ['show', 'HEAD:' + file], { cwd: root, maxBuffer: 16 * 1048576 }));
const sourceVerification = report => {
  const checked = Object.entries(report.sourceHashes || {}).map(([file, hash]) => {
    const blob = execFileSync('git', ['show', 'HEAD:' + file], { cwd: root, maxBuffer: 16 * 1048576 }), currentGitHash = sha(blob), crlfHash = sha(Buffer.from(blob.toString('utf8').replace(/\r?\n/g, '\r\n')));
    return { file, recordedHash: hash, currentGitHash, matchKind: hash === currentGitHash ? 'EXACT_GIT_BYTES' : hash === crlfHash ? 'CRLF_CHECKOUT_OF_GIT_BLOB' : 'DIFFERENT_SOURCE' };
  });
  return { sourceFiles: checked.length, matchedGitBytes: checked.filter(row => row.matchKind === 'EXACT_GIT_BYTES').length,
    matchedCrlfCheckouts: checked.filter(row => row.matchKind === 'CRLF_CHECKOUT_OF_GIT_BLOB').length, mismatches: checked.filter(row => row.matchKind === 'DIFFERENT_SOURCE'),
    interpretation: 'Recorded Windows raw-byte hashes are distinguished from exact Git blob hashes and verified CRLF checkouts. Changed source remains an explicit integration/retest gate; Linux runtime proof is separate.' };
};
const selected = {
  digital: 'vn-synthetic-v1-heldout-live.json', reviewed: 'issue26-ocr-runtime-20261014222959203.json', mapping: 'issue25-mapping-evaluation-20261014230619864.json',
  answers: 'issue63-adversarial-answers-20261015184210039.json',
};
const digital = read(directory + selected.digital), digitalManifest = read('infra/ai/datasets/vn-synthetic-v1/manifest.json');
const digitalTruth = digitalManifest.cases.filter(row => row.split === 'held-out').map(row => ({ id: row.id, fields: read('infra/ai/datasets/vn-synthetic-v1/' + row.labels).fields }));
const reviewed = read(directory + selected.reviewed), reviewedManifest = read('infra/ocr/fixtures/vn-reviewed-v1/manifest.json');
const reviewedTruth = reviewedManifest.cases.filter(row => row.split === 'held-out').map(row => ({ id: row.id,
  fields: Object.entries(read('infra/ocr/fixtures/vn-reviewed-v1/' + row.label).values).map(([field, value]) => ({ path: field, status: value === null ? 'MISSING' : 'EXTRACTED', ...(value === null ? {} : { value }) })) }));
const reviewedObserved = reviewed.cases.filter(row => row.split === 'held-out').map(row => ({ id: row.id,
  fields: row.fields.map(field => ({ path: field.path, status: field.observed_status, ...(Object.hasOwn(field, 'observed_value') ? { value: field.observed_value } : {}) })) }));
const mapping = read(directory + selected.mapping), mappingManifest = read('infra/mapping/fixtures/vn-mapping-synthetic-v1/manifest.json');
const mappingTruth = mappingManifest.cases.filter(row => row.split === 'held-out').map(row => ({ id: row.id, ...read('infra/mapping/fixtures/vn-mapping-synthetic-v1/' + row.label) }));
const answers = read(directory + selected.answers); assert.equal(answers.plannedCases, 6); assert.equal(answers.truth.length, answers.plannedCases);
const report = { issue: 63, recordedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  inputs: Object.fromEntries(Object.entries(selected).map(([name, file]) => [name, { path: directory + file, sha256: blobOrWorking(file) }])),
  metrics: {
    digitalOcr: { score: scoreFields(digitalTruth, digital.predictions), distinctDocuments: digitalTruth.length, sourceVerification: { recordedAdapterHash: digital.evidence.adapter_source_sha256, currentAdapterHash: blobHash('apps/api/src/ai/extraction/gemini-extraction.provider.ts'), interpretation: 'Historical digital-only provider run; the adapter subsequently changed for multimodal intake' } },
    reviewedOcr: { score: scoreFields(reviewedTruth, reviewedObserved), distinctDocuments: reviewedTruth.length, sourceVerification: sourceVerification(reviewed) },
    mapping: { score: scoreMappings(mappingTruth, mapping.cases.filter(row => row.split === 'held-out')), distinctDocuments: mappingTruth.length, sourceVerification: sourceVerification(mapping) },
    adversarialAnswers: { score: scoreAnswers(answers.truth, answers.observed), distinctDocuments: answers.plannedCases, sourceVerification: sourceVerification(answers), budget: answers.providerBudget },
  },
  limitations: ['Small team-authored synthetic corpora, no independent production accuracy/annotation or calibrated confidence', 'Older held-out results were already observed and are regression evidence; repeated runs are never pooled',
    'First six-case adversarial answer run was frozen before actual model calls; later reruns are regression only', 'Historical mismatched source hashes require retesting before an exact-head production claim',
    '#44 browser correction/IDOR, #43 production tenancy, #50 owner decisions and #59 production SDK remain gates', 'Actual bill unknown; reservations and HTTP attempts are not billed cost', 'No aggregate overall accuracy across incomparable tasks'],
};
function blobOrWorking(file) { return sha(fs.readFileSync(path.join(root, directory, file))); }
const output = path.join(root, directory, 'issue63-quality-summary-' + new Date().toISOString().replace(/\D/g, '') + '.json');
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ output: path.relative(root, output), metrics: Object.fromEntries(Object.entries(report.metrics).map(([key, value]) => [key, { score: value.score, distinctDocuments: value.distinctDocuments }])) }, null, 2));
