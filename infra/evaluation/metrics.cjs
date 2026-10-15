/* SPDX-License-Identifier: MIT */
'use strict';
const assert = require('node:assert/strict');
function indexed(truth, observed) {
  assert.ok(Array.isArray(truth) && truth.length > 0, 'A nonempty fixed evaluation plan is required');
  const ids = new Set(truth.map(row => row.id)); assert.equal(ids.size, truth.length, 'Duplicate planned sample');
  const byId = new Map(); for (const row of observed) { assert.ok(ids.has(row.id), 'Unexpected sample'); assert.ok(!byId.has(row.id), 'Repeated sample cannot increase independent denominator'); byId.set(row.id, row); } return byId;
}
function ratio(correct, total) { assert.ok(Number.isSafeInteger(correct) && Number.isSafeInteger(total) && correct >= 0 && total >= correct);
  return { correct, total, rate: total ? correct / total : null }; }
const sameSet = (left, right) => Array.isArray(left) && new Set(left).size === left.length && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
function scoreFields(truth, observed) {
  const byId = indexed(truth, observed), perField = {}, cases = []; let correct = 0, total = 0;
  for (const expected of truth) {
    assert.ok(Array.isArray(expected.fields) && expected.fields.length); const allowed = new Set(expected.fields.map(field => field.path)); assert.equal(allowed.size, expected.fields.length);
    const prediction = byId.get(expected.id), fields = new Map();
    if (prediction?.error) assert.equal(prediction.fields, undefined, 'Failure cannot also claim successful fields');
    for (const field of prediction?.fields || []) { assert.ok(allowed.has(field.path) && !fields.has(field.path), 'Unknown/duplicate predicted field'); fields.set(field.path, field); }
    let hits = 0;
    for (const gold of expected.fields) {
      assert.ok(['MISSING', 'EXTRACTED'].includes(gold.status)); assert.ok(gold.status === 'MISSING' ? !Object.hasOwn(gold, 'value') : typeof gold.value === 'string');
      const field = fields.get(gold.path), match = !prediction?.error && field?.status === gold.status &&
        (gold.status === 'MISSING' ? !Object.hasOwn(field, 'value') : typeof field.value === 'string' && field.value === gold.value);
      const count = perField[gold.path] || { correct: 0, total: 0 }; count.total++; total++; if (match) { count.correct++; correct++; hits++; } perField[gold.path] = count;
    }
    cases.push({ id: expected.id, correct: hits, total: expected.fields.length, missingOrFailed: !prediction || !!prediction.error });
  }
  return { fields: ratio(correct, total), perField: Object.fromEntries(Object.entries(perField).map(([name, count]) => [name, ratio(count.correct, count.total)])),
    cases: ratio(cases.filter(row => row.correct === row.total).length, truth.length), missingOrFailedCases: cases.filter(row => row.missingOrFailed).length, samples: cases };
}
function scoreMappings(truth, observed) {
  const byId = indexed(truth, observed); let exact = 0, predictedMatches = 0, correctMatches = 0, missingOrFailed = 0; const methods = {};
  for (const expected of truth) {
    const prediction = byId.get(expected.id), result = prediction?.result;
    if (!prediction || prediction.error || !result) { missingOrFailed++; continue; }
    const correct = result.state === 'REVIEW_REQUIRED' && result.resolution === expected.resolution && sameSet(result.candidates?.map(row => row.po_item_id), expected.candidate_ids);
    if (correct) exact++; if (result.resolution === 'MATCH') { predictedMatches++; if (correct) correctMatches++; }
    methods[result.method] = (methods[result.method] || 0) + 1;
  }
  return { exactCases: ratio(exact, truth.length), matchPrecision: ratio(correctMatches, predictedMatches), missingOrFailedCases: missingOrFailed, methods };
}
function scoreAnswers(truth, observed) {
  const byId = indexed(truth, observed); let relevance = 0, missing = 0, citations = 0, statements = 0, unsupported = 0, failed = 0;
  for (const expected of truth) {
    const prediction = byId.get(expected.id); if (!prediction || prediction.error || !prediction.result) { failed++; continue; }
    if (sameSet(prediction.selection?.fact_aliases, expected.fact_aliases)) relevance++;
    if (sameSet(prediction.result.missing_evidence, expected.missing_evidence)) missing++;
    for (const statement of prediction.result.statements || []) {
      statements++; const fact = expected.facts.find(fact => fact.id === statement.fact_id);
      if (!fact || statement.code !== fact.code || statement.label !== fact.label || statement.value !== fact.value) { unsupported++; continue; }
      if (statement.citation?.evidence_id === fact.evidenceId && statement.citation?.sha256 === fact.evidenceHash && statement.citation?.facts_version === fact.factsVersion) citations++;
    }
  }
  return { exactRelevantAliases: ratio(relevance, truth.length), exactServerMissingEvidence: ratio(missing, truth.length),
    sourceBoundCitations: ratio(citations, statements), unsupportedStatements: unsupported, missingOrFailedCases: failed };
}
module.exports = { indexed, ratio, scoreFields, scoreMappings, scoreAnswers };
