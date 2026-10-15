/* SPDX-License-Identifier: MIT */
'use strict';
const assert = require('node:assert/strict'), { execFileSync } = require('node:child_process'), path = require('node:path');
const root = path.resolve(__dirname, '../..'), docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
const resolved = JSON.parse(execFileSync(docker, ['compose', '-f', path.join(__dirname, 'compose.yaml'), 'config', '--format', 'json'], { cwd: root, encoding: 'utf8', timeout: 30000 }));
for (const [name, published, database] of [['postgres', '15457', 'history_hot_issue57'], ['restore', '15466', 'restore_control_issue66']]) {
  const service = resolved.services[name]; assert.ok(service); assert.equal(service.environment.POSTGRES_DB, database);
  assert.deepEqual(service.ports.map(port => ({ host: port.host_ip, published: String(port.published), target: port.target })), [{ host: '127.0.0.1', published, target: 5432 }]);
}
console.log(JSON.stringify({ project: resolved.name, isolatedSourcePort: 15457, isolatedRestorePort: 15466, validatedResolvedMappings: true }));
