/* SPDX-License-Identifier: MIT */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { createHash } = require('node:crypto'), { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..'), baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'core-baseline.json'), 'utf8'));
const changed = execFileSync('git', ['diff', '--name-only', baseline.baselineCommit, '--', 'apps/api/src/platform'], { cwd: root, encoding: 'utf8' }).trim();
const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', 'apps/api/src/platform'], { cwd: root, encoding: 'utf8' }).trim();
assert.equal(changed, '', 'Pack integration changed the pinned generic core'); assert.equal(untracked, '', 'Untracked core additions invalidate zero-core-change proof');
for (const [file, hash] of Object.entries(baseline.files)) assert.equal(createHash('sha256').update(execFileSync('git', ['show', 'HEAD:' + file], { cwd: root })).digest('hex'), hash, 'Pinned core hash mismatch: ' + file);
const checkerDiff = execFileSync('git', ['diff', '--name-only', baseline.upstreamCoreCommit, '--', 'infra/platform/check-boundaries.cjs', 'infra/platform/check-boundaries.test.cjs'], { cwd: root, encoding: 'utf8' }).trim();
assert.equal(checkerDiff, '', 'Owning core boundary checker changed');
execFileSync(process.execPath, ['infra/platform/check-boundaries.cjs'], { cwd: root, stdio: 'pipe' });
console.log(JSON.stringify({ coreBaseline: baseline.baselineCommit, coreFiles: Object.keys(baseline.files).length, coreDiffFiles: 0, checkerUnchanged: true }));
