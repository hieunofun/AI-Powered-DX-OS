/* SPDX-License-Identifier: MIT */
'use strict';
// Docker-only no-network dependency/runtime check; the caller mounts fictional source bytes.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { inspectPdf } = require('/app/apps/api/dist/platform/extraction/media-inspection.js');
(async () => {
  const text = await inspectPdf(fs.readFileSync('/fixtures/dev-digital.pdf'));
  const scanned = await inspectPdf(fs.readFileSync('/fixtures/held-scanned.pdf'));
  assert.equal(text.pages.length, 1); assert.ok(text.pages[0].text.length > 100);
  assert.equal(scanned.pages.length, 1); assert.equal(scanned.pages[0].text.length, 0);
  assert.equal(fs.readdirSync('/app/licenses/issue26-pdfjs').length, 12);
  console.log(JSON.stringify({ node: process.version, textPages: text.pages.length, textCharacters: text.pages[0].text.length,
    scannedPages: scanned.pages.length, scannedTextCharacters: scanned.pages[0].text.length, preservedNotices: 12, network: 'disabled by caller' }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
