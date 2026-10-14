/* SPDX-License-Identifier: MIT */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');
const SwaggerParser = require('@apidevtools/swagger-parser');
const root = path.join(__dirname, 'v1');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);

async function main() {
  const api = read('openapi.json');
  // OAS structural/schema validation and reference resolution, without network reads.
  await SwaggerParser.validate(path.join(root, 'openapi.json'), {
    resolve: { http: false },
  });
  const ajv = new Ajv({ allErrors: true, jsonPointers: true, strictKeywords: true, unknownFormats: 'fail' });
  let definitions = 0;
  for (const file of fs.readdirSync(path.join(root, 'schemas')).filter(f => f.endsWith('.json'))) {
    const schema = read('schemas/' + file);
    assert(ajv.validateSchema(schema), `${file}: ${JSON.stringify(ajv.errors)}`);
    ajv.addSchema(schema, file);
    for (const name of Object.keys(schema.definitions)) {
      assert(ajv.getSchema(file + '#/definitions/' + name), `Cannot compile ${file}/${name}`);
      const prefix = file === 'openresolve.schema.json' ? 'OpenResolve' : '';
      const converted = JSON.parse(JSON.stringify(schema.definitions[name]).replace(/#\/definitions\//g, '#/components/schemas/' + prefix));
      assert.deepEqual(api.components.schemas[prefix + name], converted, `OAS/standalone schema drift: ${name}`);
      definitions++;
    }
  }
  // Reject unresolved references even in unused definitions/examples.
  function refs(value, document) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      assert(value.$ref.startsWith('#/'), 'Only local references are allowed in bundled OpenAPI');
      let result = document;
      for (const token of value.$ref.slice(2).split('/')) {
        result = result?.[token.replace(/~1/g, '/').replace(/~0/g, '~')];
      }
      assert.notEqual(result, undefined, 'Unresolved reference: ' + value.$ref);
    }
    Object.values(value).forEach(child => refs(child, document));
  }
  refs(api, api);
  const manifest = read('fixtures/manifest.json');
  const listed = new Set(manifest.cases.map(c => c.file));
  assert.equal(listed.size, manifest.cases.length, 'Duplicate fixture path');
  const actual = fs.readdirSync(path.join(root, 'fixtures')).filter(f => f.endsWith('.json') && f !== 'manifest.json');
  assert.deepEqual([...listed].sort(), actual.sort(), 'Unregistered fixture');
  let positive = 0, negative = 0;
  for (const test of manifest.cases) {
    assert(!test.file.includes('..'), 'Fixture must remain in fixtures directory');
    const target = test.schema.replace('../schemas/', '');
    const validate = ajv.getSchema(target);
    assert(validate, 'Unknown fixture schema: ' + target);
    const result = validate(read('fixtures/' + test.file));
    assert.equal(result, test.valid, `${test.file}: expected ${test.valid}; ${JSON.stringify(validate.errors)}`);
    test.valid ? positive++ : negative++;
  }
  // Validate every embedded request/response example against its own OAS schema.
  // These contracts deliberately use the shared OAS 3.0/draft-07 schema subset.
  const oasExamples = new Ajv({ allErrors: true, jsonPointers: true, unknownFormats: 'fail' });
  const bundle = { $id: 'urn:opendx:oas-examples', components: { schemas: api.components.schemas } };
  oasExamples.addSchema(bundle);
  let embedded = 0;
  function examples(value) {
    if (!value || typeof value !== 'object') return;
    if (value.schema && Object.hasOwn(value, 'example')) {
      assert(value.schema.$ref, 'Media example requires an explicit schema reference');
      const validate = oasExamples.getSchema('urn:opendx:oas-examples' + value.schema.$ref);
      assert(validate(value.example), 'Embedded example: ' + JSON.stringify(validate.errors));
      embedded++;
    }
    Object.values(value).forEach(examples);
  }
  examples(api.paths);
  const operationIds = new Set();
  let operations = 0;
  for (const [route, item] of Object.entries(api.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!methods.has(method)) continue;
      assert(!operationIds.has(op.operationId), 'Duplicate operationId');
      operationIds.add(op.operationId);
      assert(op['x-contract-stage'], 'Missing contract maturity');
      assert(op['x-required-permission'], 'Missing authorization requirement');
      for (const status of ['400', '401', '403', '404', '409', '422', '429', '503']) {
        assert(op.responses[status], `${op.operationId} missing ${status}`);
      }
      if (['post', 'put', 'patch', 'delete'].includes(method)) {
        assert(op.parameters.some(p => p.$ref === '#/components/parameters/IdempotencyKey'), `${route} mutation missing idempotency`);
      }
      const quotaResponse = op.responses['429'].$ref ? api.components.responses[op.responses['429'].$ref.split('/').at(-1)] : op.responses['429'];
      assert(quotaResponse.headers['Retry-After'], '429 missing Retry-After');
      operations++;
    }
  }
  const core = fs.readFileSync(path.join(root, 'schemas/platform.schema.json'), 'utf8');
  assert(!/\b(?:PO|GRN|Invoice|Employee|Payroll)\b/.test(core), 'Business vocabulary leaked into the core schema');
  console.log(JSON.stringify({ openapi: api.openapi, definitions, operations, positiveFixtures: positive, negativeFixtures: negative, embeddedExamples: embedded, runtimeApiTested: false }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
