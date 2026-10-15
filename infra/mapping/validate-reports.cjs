/* SPDX-License-Identifier: MIT */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..'), directory = path.join(root, 'docs/ai/evidence');
const Ajv = require('ajv'), ajv = new Ajv({ allErrors: true });
const base = require(path.join(root, 'packages/contracts/opendx/v1/schemas/platform.schema.json')), schema = require(path.join(root, 'packages/contracts/opendx/proposed/issue25-mapping.schema.json'));
ajv.addSchema(base); ajv.addSchema(schema);
const files = fs.readdirSync(directory).filter(file => file.startsWith('issue25-mapping-evaluation-')).sort(); assert.ok(files.length);
const report = require(path.join(directory, files.at(-1))), validate = ajv.getSchema(schema.$id + '#/definitions/Suggestion');
assert.equal(report.cases.length, 10); assert.equal(report.checks[0].status, 'PASS');
for (const sample of report.cases) assert.equal(validate(sample.result), true, 'Recorded suggestion violates proposed schema: ' + sample.id);
for (const [file, expected] of Object.entries(report.sourceHashes)) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'), expected, 'Implementation changed since evaluation: ' + file);
const timing = report.cases.filter(sample => sample.result.method === 'GEMINI').map(sample => sample.durationMs).sort((a, b) => a - b);
console.log(JSON.stringify({ report: files.at(-1), suggestionsValidated: report.cases.length, scores: report.scores, actualGeminiSamples: timing.length,
  nearestRankP95Ms: timing[Math.ceil(timing.length * .95) - 1], budget: report.environment.budget, sourceHashesMatch: true }, null, 2));
