/* SPDX-License-Identifier: MIT */
import { validateDataset } from '../../../../../infra/ai/validate-dataset.cjs';
describe('versioned Vietnamese synthetic evaluation corpus', () => {
  it('has disjoint development/held-out documents, ground-truth paths and verified PDF hashes', () => {
    expect(validateDataset().summary).toMatchObject({ version: 'vn-synthetic-v1', development: 4, heldOut: 4,
      cases: 8, fieldsPerCase: 9, sourceChecksums: 'verified', providerCalls: 0 });
  });
});
