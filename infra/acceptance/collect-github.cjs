/* SPDX-License-Identifier: MIT */
'use strict';
// Read-only public repository audit. Optional ephemeral GitHub Actions token stays in headers.
const fs = require('node:fs'), path = require('node:path'), { execFileSync } = require('node:child_process');
const { parsePlan, assess } = require('./assess.cjs');
const root = path.resolve(__dirname, '../..'), repository = 'hieunofun/AI-Powered-DX-OS';
async function api(route) {
  const response = await fetch('https://api.github.com/repos/' + repository + route, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'OpenDX-release-evidence-audit', ...(process.env.GITHUB_TOKEN ? { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN } : {}) }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('GitHub read-only audit HTTP ' + response.status); return response.json();
}
async function main() {
  const plan = parsePlan(fs.readFileSync(path.join(root, 'docs/project4/BRS.md'), 'utf8'));
  const issues = await api('/issues?state=all&per_page=100'), pulls = await api('/pulls?state=all&per_page=100');
  // Current repository fits one page. Refuse silent omission if it grows.
  if (issues.length === 100 || pulls.length === 100) throw new Error('Audit pagination required; cannot qualify an incomplete snapshot');
  const snapshot = { repository, inspectedAt: new Date().toISOString(), issues: issues.filter(issue => !issue.pull_request).map(issue => ({ number: issue.number, title: issue.title, state: issue.state, url: issue.html_url })),
    pullRequests: pulls.map(pr => ({ number: pr.number, author: pr.user.login, state: pr.state, mergedAt: pr.merged_at, draft: pr.draft, head: pr.head.sha, base: pr.base.ref, url: pr.html_url })) };
  const testedGitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), head = process.env.ACCEPTANCE_CANDIDATE_SHA || testedGitCommit;
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('Invalid acceptance candidate commit');
  execFileSync('git', ['merge-base', '--is-ancestor', head, 'HEAD'], { cwd: root });
  // No exact-candidate integrated AT adapter exists yet. Do not turn component reports or legacy CI into full AT results.
  const report = { issue: 66, testedGitCommit, snapshot, assessment: assess(plan, snapshot, head, []),
    integratedRuntimeResults: [], limitations: ['Read-only GitHub state snapshot is not review/behavior/native proof', 'No integrated AT runtime adapter is provided by the missing owning #43/#48/#50/#53/#56/#58/#59/#62/#64/#65/#44/#61 contracts',
      'Component restore and legacy real-stack CI are separate evidence, never automatic AT acceptance', 'Release qualification fails closed until exact-candidate integrated evidence and independent review exist'] };
  const directory = path.join(root, 'docs/acceptance/evidence'); fs.mkdirSync(directory, { recursive: true }); const target = path.join(directory, 'issue66-acceptance-audit-' + new Date().toISOString().replace(/\D/g, '') + '.json');
  fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ report: path.relative(root, target), status: report.assessment.status, passed: report.assessment.passed, required: report.assessment.required }));
  if (process.argv.includes('--require-release') && report.assessment.status !== 'QUALIFIED') process.exitCode = 2;
}
main().catch(error => { console.error('FAIL repository acceptance audit: ' + error.message); process.exitCode = 1; });
