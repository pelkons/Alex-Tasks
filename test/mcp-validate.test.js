'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateArgs } = require('../lib/mcp/validate');

const tool = (schema, example) => ({ name: 'demo', schema: { properties: {}, ...schema }, example });
const v = (t, args, ctx) => validateArgs(t, args, ctx);

test('required: a missing or null field is named, with an example', () => {
  const t = tool({ properties: { id: { type: 'integer' } }, required: ['id'] }, { id: 104 });
  const r = v(t, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /^demo: "id" is required\. Example: \{"id":104\}$/);
  assert.equal(v(t, { id: null }).ok, false);
});

test('type errors say what was expected and what came', () => {
  const t = tool({ properties: { n: { type: 'integer' }, s: { type: 'string' }, b: { type: 'boolean' } } });
  assert.match(v(t, { n: 'abc' }).error, /"n" must be an integer, got "abc"/);
  assert.match(v(t, { n: 1.5 }).error, /"n" must be an integer, got 1.5/);
  assert.match(v(t, { s: { a: 1 } }).error, /"s" must be a string/);
  assert.match(v(t, { b: 'maybe' }).error, /"b" must be true or false/);
});

test('coercion: numeric strings, booleans, JSON text and id lists', () => {
  const t = tool({ properties: { id: { type: 'integer' }, ok: { type: 'boolean' }, list: { type: 'array', items: { type: 'integer' } }, arr: { type: 'array' }, o: { type: 'object' }, s: { type: 'string' } } });
  assert.deepEqual(v(t, { id: '104', ok: 'true', list: '5,6', arr: '[1,2]', o: '{"a":1}', s: 7 }).value, { id: 104, ok: true, list: [5, 6], arr: [1, 2], o: { a: 1 }, s: '7' });
  assert.deepEqual(v(t, { list: 5 }).value, { list: [5] });
  assert.equal(v(t, { id: '12x' }).ok, false);
});

test('enum, pattern, ranges and lengths', () => {
  const t = tool({ properties: { k: { type: 'string', enum: ['a', 'b'] }, d: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', expect: 'a date YYYY-MM-DD' }, n: { type: 'integer', minimum: 1, maximum: 5 }, s: { type: 'string', minLength: 1, maxLength: 3 }, a: { type: 'array', minItems: 1, maxItems: 2 } } });
  assert.match(v(t, { k: 'c' }).error, /"k" must be one of a, b, got "c"/);
  assert.match(v(t, { d: '29/11' }).error, /"d" must be a date YYYY-MM-DD, got "29\/11"/);
  assert.match(v(t, { n: 0 }).error, /"n" must be at least 1, got 0/);
  assert.match(v(t, { n: 9 }).error, /"n" must be at most 5, got 9/);
  assert.match(v(t, { s: '  ' }).error, /"s" must not be empty/);
  assert.match(v(t, { s: 'abcd' }).error, /at most 3 characters, got 4/);
  assert.match(v(t, { a: [] }).error, /at least 1 item/);
  assert.match(v(t, { a: [1, 2, 3] }).error, /at most 2 item/);
  assert.equal(v(t, { k: 'a', d: '2026-11-29', n: 3, s: 'ab', a: [1] }).ok, true);
});

test('nullable types accept null and "none"', () => {
  const t = tool({ properties: { due: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' } } });
  assert.deepEqual(v(t, { due: null }).value, { due: null });
  assert.equal(v(t, { due: '2026-11-29' }).ok, true);
  assert.equal(v(t, { due: 'soon' }).ok, false);
});

test('items and nested objects are checked with their path; additionalProperties:false lists the allowed names', () => {
  const t = tool({ properties: { rows: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false } } }, additionalProperties: false });
  assert.match(v(t, { rows: [{ id: 'x' }] }).error, /"rows\[0\]\.id" must be an integer/);
  assert.match(v(t, { rows: [{}] }).error, /"rows\[0\]\.id" is required/);
  assert.match(v(t, { rows: [{ id: 1, z: 1 }] }).error, /unknown field "rows\[0\]\.z"\. Allowed: id/);
  assert.match(v(t, { nope: 1 }).error, /unknown field "nope"\. Allowed: rows/);
  assert.deepEqual(v(t, { rows: [{ id: '2' }] }).value, { rows: [{ id: 2 }] });
});

test('lookup: names or ids of the current statuses are accepted, anything else lists the names; no lookups = no check', () => {
  const t = tool({ properties: { status: { type: 'string', lookup: 'statuses' } } });
  const ctx = { lookups: { statuses: [{ id: 1, name_he: 'פתוח' }, { id: 2, name_he: 'בטיפול' }] } };
  assert.equal(v(t, { status: 'בטיפול' }, ctx).ok, true);
  assert.equal(v(t, { status: 2 }, ctx).ok, true);
  assert.match(v(t, { status: 'סגור' }, ctx).error, /"status" must be one of פתוח, בטיפול, got "סגור"/);
  assert.equal(v(t, { status: 'whatever' }).ok, true);
});

test('arguments must be an object; missing arguments count as {}', () => {
  const t = tool({ properties: { a: { type: 'string' } } });
  assert.match(v(t, [1]).error, /must be an object/);
  assert.match(v(t, 'x').error, /must be an object/);
  assert.deepEqual(v(t, undefined).value, {});
  assert.deepEqual(v(t, null).value, {});
});
