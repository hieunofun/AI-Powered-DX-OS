/* SPDX-License-Identifier: MIT */
'use strict';
// Component runtime/legacy CI is deliberately insufficient to qualify integrated AT acceptance.
const assert = require('node:assert/strict'), { createHash } = require('node:crypto');
const sha = text => createHash('sha256').update(text).digest('hex');
function parsePlan(markdown) {
  const rows = markdown.split(/\r?\n/).map(line => /^\| (AT-(?:0[1-9]|1[0-2])) \| ([^|]+) \| ([^|]+) \|$/.exec(line)).filter(Boolean)
    .map(row => ({ id: row[1], scenario: row[2].trim(), scenarioHash: sha(row[2].trim()), dependencies: [...new Set([...row[3].matchAll(/#([0-9]+)/g)].map(value => Number(value[1])))], trace: row[3].trim() }));
  assert.equal(rows.length, 12); assert.equal(new Set(rows.map(row => row.id)).size, 12); return rows;
}
function assess(plan, snapshot, candidateSha, integratedResults = []) {
  assert.equal(plan.length, 12, 'All twelve integrated cases are required');
  assert.equal(new Set(plan.map(row => row.id)).size, 12, 'Repeated scenarios cannot qualify');
  assert.ok(plan.every(row => /^AT-(?:0[1-9]|1[0-2])$/.test(row.id)));
  assert.match(candidateSha, /^[a-f0-9]{40}$/); assert.equal(snapshot.repository, 'hieunofun/AI-Powered-DX-OS');
  const cases = plan.map(item => {
    const blockedDependencies = item.dependencies.filter(id => snapshot.issues.find(issue => issue.number === id)?.state !== 'closed');
    const result = integratedResults.find(result => result.id === item.id);
    const qualified = !blockedDependencies.length && result?.scope === 'INTEGRATED_AT' && result.candidateSha === candidateSha && result.scenarioHash === item.scenarioHash &&
      result.status === 'PASS' && result.sourceHashesVerified === true && result.currentOwnerAdapters === true && result.nativeProofsVerified === true && result.scriptedFixture !== true &&
      result.independentApproval?.reviewer && result.independentApproval.reviewer !== result.author && result.independentApproval.commit === candidateSha;
    return { ...item, status: qualified ? 'PASS' : 'BLOCKED', blockedDependencies,
      reasons: qualified ? [] : [...(blockedDependencies.length ? ['Dependencies are open or their state is unverified'] : []), 'Exact-candidate integrated runtime/native proof and independent review are required; component/legacy/fixture checks do not qualify'] };
  });
  return { candidateSha, cases, passed: cases.filter(row => row.status === 'PASS').length, required: 12, status: cases.every(row => row.status === 'PASS') ? 'QUALIFIED' : 'BLOCKED' };
}
module.exports = { parsePlan, assess };
