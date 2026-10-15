/* SPDX-License-Identifier: MIT */
export interface GroundTruth { id: string; fields: { path: string; status: 'EXTRACTED' | 'MISSING'; value?: string }[]; }
export interface Prediction {
  id: string;
  fields?: { path: string; status: 'EXTRACTED' | 'MISSING'; value?: string }[];
  error?: string;
}
export function scoreExtractions(truth: GroundTruth[], predictions: Prediction[]) {
  const expectedIds = new Set(truth.map(item => item.id));
  if (!truth.length || expectedIds.size !== truth.length) throw new Error('Ground truth must be nonempty and duplicate-free.');
  const byId = new Map<string, Prediction>();
  for (const prediction of predictions) {
    if (!expectedIds.has(prediction.id) || byId.has(prediction.id)) throw new Error('Unexpected or duplicate prediction case.');
    if (prediction.error && prediction.fields) throw new Error('A failed case cannot also contain successful predictions.');
    byId.set(prediction.id, prediction);
  }
  const byField = new Map<string, { correct: number; total: number }>();
  let completeCases = 0, failedCases = 0, correct = 0, total = 0;
  for (const sample of truth) {
    const predicted = byId.get(sample.id);
    if (!predicted || predicted.error || !predicted.fields) failedCases++;
    const fields = new Map<string, NonNullable<Prediction['fields']>[number]>();
    for (const field of predicted?.fields || []) {
      if (fields.has(field.path) || !sample.fields.some(expected => expected.path === field.path)) {
        throw new Error('Unexpected or duplicate predicted field.');
      }
      fields.set(field.path, field);
    }
    let allCorrect = Boolean(predicted && !predicted.error && predicted.fields);
    for (const expected of sample.fields) {
      const field = fields.get(expected.path);
      const matches = Boolean(field && field.status === expected.status &&
        (expected.status === 'MISSING' ? !Object.prototype.hasOwnProperty.call(field, 'value') : field.value === expected.value));
      const counts = byField.get(expected.path) || { correct: 0, total: 0 };
      counts.total++; total++;
      if (matches) { counts.correct++; correct++; } else allCorrect = false;
      byField.set(expected.path, counts);
    }
    if (allCorrect) completeCases++;
  }
  return { cases: truth.length, completeCases, failedCases, fields: { correct, total, exactAccuracy: correct / total },
    perField: Object.fromEntries([...byField].map(([name, counts]) => [name, { ...counts, exactAccuracy: counts.correct / counts.total }])),
    confidenceCalibration: 'NOT_EVALUATED', metric: 'strict status and exact string match; failed/missing cases count against every field' };
}
