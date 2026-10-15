/* SPDX-License-Identifier: MIT */
'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { parsePlan, assess } = require('./assess.cjs'), plan = parsePlan(fs.readFileSync(path.resolve(__dirname, '../../docs/project4/BRS.md'), 'utf8'));
const head = 'a'.repeat(40), snapshot = { repository: 'hieunofun/AI-Powered-DX-OS', issues: [...new Set(plan.flatMap(row => row.dependencies))].map(number => ({ number, state: 'closed' })) };
const integrated = () => plan.map(item => ({ id: item.id, candidateSha: head, scenarioHash: item.scenarioHash, scope: 'INTEGRATED_AT', status: 'PASS', sourceHashesVerified: true, currentOwnerAdapters: true, nativeProofsVerified: true, scriptedFixture: false,
  author: 'author-fixture', independentApproval: { reviewer: 'independent-fixture', commit: head } }));
test('BRS defines all twelve distinct acceptance cases', () => assert.equal(plan.length, 12));
test('absence of integrated results cannot be promoted by closed issues', () => assert.equal(assess(plan, snapshot, head).passed, 0));
test('open or absent owner dependency blocks an otherwise qualifying result', () => {
  const state = structuredClone(snapshot); state.issues = []; assert.equal(assess(plan, state, head, integrated()).passed, 0);
});
for (const [name, mutate] of [
  ['component-only proof', value => { value.scope = 'COMPONENT_RESTORE_REHEARSAL'; }], ['old candidate SHA', value => { value.candidateSha = 'b'.repeat(40); }],
  ['different scenario', value => { value.scenarioHash = 'c'.repeat(64); }], ['source hash not verified', value => { value.sourceHashesVerified = false; }],
  ['fixture owner adapters', value => { value.currentOwnerAdapters = false; }], ['native proof absent', value => { value.nativeProofsVerified = false; }],
  ['scripted fixture instead of integrated run', value => { value.scriptedFixture = true; }], ['self review', value => { value.independentApproval.reviewer = value.author; }],
  ['old approval', value => { value.independentApproval.commit = 'b'.repeat(40); }],
]) test(name + ' cannot qualify release acceptance', () => {
  const results = integrated(); results.forEach(mutate); assert.equal(assess(plan, snapshot, head, results).status, 'BLOCKED');
});
test('reducer positive control requires every evidence/owner/review condition (synthetic test only)', () => assert.equal(assess(plan, snapshot, head, integrated()).status, 'QUALIFIED'));
