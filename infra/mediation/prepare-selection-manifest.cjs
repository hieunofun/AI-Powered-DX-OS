/* SPDX-License-Identifier: MIT */
'use strict';
const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto');
const directory = path.join(__dirname, 'fixtures'), sha = file => createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex');
const manifest = { version: 'case-extractive-synthetic-v1', disclosure: 'SYNTHETIC', cases: 8, dev: 4, heldOut: 4,
  sources: { path: 'selection-inputs.json', sha256: sha('selection-inputs.json') }, labels: { path: 'selection-labels.json', sha256: sha('selection-labels.json') },
  limitations: ['Small team-authored fictional corpus, not independent production accuracy', 'Standalone selection evaluation uses explicit authorized-facts fixtures; real SQL/AV/policy/decision acceptance is separate',
    'Exact relevant-alias matching is measured; schema validation alone is not answer relevance', 'No tool, approval or payment can be executed by this runner'] };
fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ version: manifest.version, cases: 8, dev: 4, heldOut: 4 }));
