const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { checkSource, checkRepository, platformRoot } = require('./check-boundaries.cjs');
const probe = path.join(platformRoot, 'identity/probe.ts');

test('working platform has no domain imports or vocabulary', () => {
  assert.ok(checkRepository().platformFiles > 10);
});
test('neutral identity/data ports and framework imports resolve', () => {
  assert.deepEqual(checkSource(probe, "import { Injectable } from '@nestjs/common'; export { DatabaseService } from '../data/database.service';"), []);
});
test('imports, type imports, re-exports and require cannot reach legacy domain code', () => {
  for (const code of [
    "import { PurchaseOrdersService } from '../../purchase-orders/purchase-orders.service';",
    "export * from '../../database/database.service';",
    "type Store = import('../../database/database.service').DatabaseService;",
    "const load = require('../../database/database.service');",
    "const load = import('../../database/database.service');",
  ]) assert.ok(checkSource(probe, code).some(error => error.includes('crosses its boundary')), code);
});
test('computed/unresolved module loading and embedded business fields fail', () => {
  for (const code of ["require(target)", "import(target)", "import './missing';", "const payload = { invoice_id: 'synthetic' };", "const kind = 'Employee';"]) {
    assert.ok(checkSource(probe, code).length > 0, code);
  }
});
