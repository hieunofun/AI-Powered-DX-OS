/* SPDX-License-Identifier: MIT */
'use strict';
const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto'), { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..'), baseline = '14e6e89530e390b2ee6882f1ec1843855a4f8583';
const target = path.join(__dirname, 'core-baseline.json'), manifestOnly = process.argv.includes('--manifest-only');
if (fs.existsSync(target) && !manifestOnly) throw new Error('Preserve the original baseline/timing; use --manifest-only for a reviewed manifest revision');
if (manifestOnly && !fs.existsSync(target)) throw new Error('A preserved original core baseline is required');
const sha = bytes => createHash('sha256').update(bytes).digest('hex'), workflow = { id: 'b88c1f34-5bd9-4db4-8551-9c15432e1801', version: '1.0.0', sha256: sha(fs.readFileSync(path.join(__dirname, 'access-review.bpmn'))) };
const manifest = { pack_id: 'onboarding', version: '1.0.0', publisher: 'OpenDX contributors', license: 'MIT', compatible_core: '^1.0.0',
  permissions: ['onboarding.case.create', 'onboarding.case.read', 'onboarding.checklist.record', 'onboarding.access.request', 'onboarding.access.decide', 'onboarding.workflow.process', 'onboarding.workflow.reconcile'],
  entity_schema_ids: ['onboarding.case.v1', 'onboarding.access-request.v1'], workflow_refs: [workflow],
  published_events: ['onboarding.case.created.v1', 'onboarding.checklist.recorded.v1', 'onboarding.access.requested.v1', 'onboarding.access.decided.v1', 'onboarding.case.completed.v1'], consumed_events: [],
  evidence_schema_ids: ['onboarding.checklist-evidence.v1'], migration_policy: 'FORWARD_ONLY' };
const sourceDirectory = path.join(root, 'apps/api/src/packs/onboarding'); fs.mkdirSync(sourceDirectory, { recursive: true });
fs.writeFileSync(path.join(sourceDirectory, 'onboarding.manifest.ts'), '/* SPDX-License-Identifier: MIT */\n// Generated from the versioned pack definition by infra/onboarding/prepare-pack.cjs.\nexport const ONBOARDING_MANIFEST = ' + JSON.stringify(manifest, null, 2) + ' as const;\n');
fs.writeFileSync(path.join(__dirname, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
if (manifestOnly) { console.log(JSON.stringify({ manifestUpdated: true, baselinePreserved: true })); process.exit(0); }
const coreFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', baseline, 'apps/api/src/platform'], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
const core = { baselineCommit: baseline, upstreamCoreCommit: 'a4df50a7d9dd6d7093bc2df90e364222b6d319e6', evidenceParent: '93db77c0d0fc22a37a200d0415bf93a1bb3f98dc',
  preparationStartedAt: execFileSync('git', ['show', '-s', '--format=%cI', '0939ec5'], { cwd: root, encoding: 'utf8' }).trim(),
  packImplementationStartedAt: new Date().toISOString(),
  files: Object.fromEntries(coreFiles.map(file => [file, sha(execFileSync('git', ['show', baseline + ':' + file], { cwd: root }))])) };
fs.writeFileSync(target, JSON.stringify(core, null, 2) + '\n');
console.log(JSON.stringify({ pack: manifest.pack_id, version: manifest.version, workflow: workflow.sha256, coreBaseline: baseline, coreFiles: coreFiles.length }));
