/* SPDX-License-Identifier: MIT */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

function validateDataset(root = path.join(__dirname, 'datasets', 'vn-synthetic-v1')) {
  const base = fs.realpathSync(root);
  function read(relative) {
    assert(typeof relative === 'string' && !path.isAbsolute(relative), 'Dataset path must be relative.');
    const file = fs.realpathSync(path.resolve(base, relative));
    assert(file.startsWith(base + path.sep), 'Dataset path escapes the version directory.');
    return fs.readFileSync(file);
  }
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.version, 'vn-synthetic-v1');
  assert.equal(manifest.synthetic, true);
  const fieldPaths = manifest.fields.map(field => field.path);
  assert.equal(new Set(fieldPaths).size, fieldPaths.length, 'Duplicate field path.');
  const ids = new Set(), texts = new Set();
  let development = 0, heldOut = 0;
  for (const item of manifest.cases) {
    assert(!ids.has(item.id), 'Duplicate case.'); ids.add(item.id);
    assert(['dev', 'held-out'].includes(item.split), 'Unknown split.');
    item.split === 'dev' ? development++ : heldOut++;
    const source = read(item.source);
    assert(source.subarray(0, 5).toString('ascii') === '%PDF-', 'Expected a real PDF source.');
    assert.equal(createHash('sha256').update(source).digest('hex'), item.source_sha256, 'Source checksum mismatch.');
    const text = read(item.text_source).toString('utf8');
    assert(!texts.has(text), 'Duplicate development/held-out source.'); texts.add(text);
    const label = JSON.parse(read(item.labels));
    assert.equal(label.case_id, item.id);
    assert.deepEqual(label.fields.map(field => field.path).sort(), [...fieldPaths].sort());
    for (const field of label.fields) {
      assert(['EXTRACTED', 'MISSING'].includes(field.status));
      if (field.status === 'MISSING') assert(!Object.prototype.hasOwnProperty.call(field, 'value'));
      else assert(typeof field.value === 'string' && field.value.length > 0);
    }
  }
  assert(development > 0 && heldOut > 0, 'Both splits must be nonempty.');
  return { manifest, summary: { version: manifest.version, cases: ids.size, development, heldOut,
    fieldsPerCase: fieldPaths.length, sourceChecksums: 'verified', providerCalls: 0 } };
}
module.exports = { validateDataset };
if (require.main === module) {
  try { console.log(JSON.stringify(validateDataset().summary, null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
