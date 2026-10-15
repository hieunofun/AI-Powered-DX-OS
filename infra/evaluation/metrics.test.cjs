/* SPDX-License-Identifier: MIT */
'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { scoreFields, scoreMappings, scoreAnswers } = require('./metrics.cjs');
const truth = [{ id: 'one', fields: [{ path: '/amount', status: 'EXTRACTED', value: '9007199254740993.00' }, { path: '/missing', status: 'MISSING' }] }, { id: 'two', fields: [{ path: '/amount', status: 'EXTRACTED', value: '1.00' }] }];
test('omitted and failed OCR samples count against every planned field', () => {
  assert.deepEqual(scoreFields(truth, [{ id: 'one', error: 'TIMEOUT' }]).fields, { correct: 0, total: 3, rate: 0 });
  assert.equal(scoreFields(truth, []).perField['/amount'].total, 2);
});
test('exact decimal strings cannot be replaced by rounded numbers or normalized text', () => {
  const score = scoreFields(truth, [{ id: 'one', fields: [{ path: '/amount', status: 'EXTRACTED', value: 9007199254740992 }, { path: '/missing', status: 'MISSING', value: 'invented' }] }]);
  assert.equal(score.fields.correct, 0);
});
test('missing fields have no fabricated value; equal exact strings and statuses score', () => {
  assert.equal(scoreFields(truth, [{ id: 'one', fields: truth[0].fields }]).fields.correct, 2);
});
test('repeated samples, foreign IDs and duplicate fields cannot inflate denominators', () => {
  assert.throws(() => scoreFields(truth, [{ id: 'one' }, { id: 'one' }])); assert.throws(() => scoreFields(truth, [{ id: 'foreign' }]));
  assert.throws(() => scoreFields(truth, [{ id: 'one', fields: [truth[0].fields[0], truth[0].fields[0]] }]));
});
test('mapping precision and planned exact-match denominator remain distinct on failures', () => {
  const expected = [{ id: 'one', resolution: 'MATCH', candidate_ids: ['a'] }, { id: 'two', resolution: 'NO_MATCH', candidate_ids: [] }];
  const result = scoreMappings(expected, [{ id: 'one', result: { state: 'REVIEW_REQUIRED', resolution: 'MATCH', candidates: [{ po_item_id: 'a' }], method: 'GEMINI' } }]);
  assert.deepEqual(result.exactCases, { correct: 1, total: 2, rate: 0.5 }); assert.deepEqual(result.matchPrecision, { correct: 1, total: 1, rate: 1 });
});
test('mapping has no undefined 100% precision when no match is predicted', () => {
  assert.deepEqual(scoreMappings([{ id: 'one', resolution: 'NO_MATCH', candidate_ids: [] }], []).matchPrecision, { correct: 0, total: 0, rate: null });
});
test('duplicate candidate IDs or an automatically accepted mapping are not exact reviewed results', () => {
  for (const result of [{ state: 'CONFIRMED', resolution: 'MATCH', candidates: [{ po_item_id: 'a' }] }, { state: 'REVIEW_REQUIRED', resolution: 'MATCH', candidates: [{ po_item_id: 'a' }, { po_item_id: 'a' }] }])
    assert.equal(scoreMappings([{ id: 'one', resolution: 'MATCH', candidate_ids: ['a'] }], [{ id: 'one', result }]).exactCases.correct, 0);
});
const fact = { id: 'fact-one', code: 'INVOICE', label: 'Amount', value: '9007199254740993.00', evidenceId: 'evidence-one', evidenceHash: 'a'.repeat(64), factsVersion: 'confirmed-1' };
const answerTruth = [{ id: 'one', fact_aliases: ['F1'], missing_evidence: ['RECEIPT'], facts: [fact] }, { id: 'two', fact_aliases: [], missing_evidence: [], facts: [] }];
const answer = () => ({ id: 'one', selection: { fact_aliases: ['F1'] }, result: { missing_evidence: ['RECEIPT'], statements: [{ fact_id: fact.id, code: fact.code, label: fact.label, value: fact.value,
  citation: { evidence_id: fact.evidenceId, sha256: fact.evidenceHash, facts_version: fact.factsVersion } }] } });
test('grounded answer relevance/missing denominators include provider failures', () => {
  const result = scoreAnswers(answerTruth, [answer()]); assert.equal(result.exactRelevantAliases.total, 2); assert.equal(result.exactRelevantAliases.correct, 1); assert.equal(result.missingOrFailedCases, 1);
  assert.deepEqual(result.sourceBoundCitations, { correct: 1, total: 1, rate: 1 });
});
test('foreign or stale citations cannot count as source-bound even with verbatim values', () => {
  const value = answer(); value.result.statements[0].citation.evidence_id = 'foreign'; assert.equal(scoreAnswers(answerTruth, [value]).sourceBoundCitations.correct, 0);
});
test('unsupported prose/amounts remain explicit failures and empty citations give null precision', () => {
  const value = answer(); value.result.statements[0].value = '0.00'; assert.equal(scoreAnswers(answerTruth, [value]).unsupportedStatements, 1);
  assert.equal(scoreAnswers(answerTruth, []).sourceBoundCitations.rate, null);
});
