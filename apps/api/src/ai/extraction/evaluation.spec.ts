/* SPDX-License-Identifier: MIT */
import { scoreExtractions } from './evaluation';
const truth = [{ id: 'a', fields: [{ path: '/amount', status: 'EXTRACTED' as const, value: '9007199254740993.00' },
  { path: '/missing', status: 'MISSING' as const }] },
{ id: 'b', fields: [{ path: '/amount', status: 'EXTRACTED' as const, value: '100.00' }] }];
describe('evaluation denominators', () => {
  it('counts failed and omitted cases against the denominator and preserves exact large decimals', () => {
    const result = scoreExtractions(truth, [{ id: 'a', fields: truth[0].fields }]);
    expect(result.fields).toEqual({ correct: 2, total: 3, exactAccuracy: 2 / 3 });
    expect(result.failedCases).toBe(1);
    expect(result.perField['/amount']).toEqual({ correct: 1, total: 2, exactAccuracy: 0.5 });
  });
  it('does not accept an invented missing value or round/normalize decimals', () => {
    const result = scoreExtractions(truth, [{ id: 'a', fields: [{ path: '/amount', status: 'EXTRACTED', value: '9007199254740992.00' },
      { path: '/missing', status: 'MISSING', value: '' }] }, { id: 'b', error: 'TIMEOUT' }]);
    expect(result.fields.correct).toBe(0);
    expect(result.fields.total).toBe(3);
  });
  it('rejects unknown/duplicate cases and fields that would contaminate evaluation', () => {
    expect(() => scoreExtractions(truth, [{ id: 'other', fields: [] }])).toThrow('case');
    expect(() => scoreExtractions(truth, [{ id: 'a', fields: [] }, { id: 'a', fields: [] }])).toThrow('case');
    expect(() => scoreExtractions(truth, [{ id: 'a', fields: [{ path: '/other', status: 'MISSING' }] }])).toThrow('field');
    expect(() => scoreExtractions(truth, [{ id: 'a', fields: [truth[0].fields[0], truth[0].fields[0]] }])).toThrow('field');
  });
});
