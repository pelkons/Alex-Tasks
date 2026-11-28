'use strict';
// A small JSON-schema subset validator for the MCP tools: type (one or several, "null" allowed), required, enum, pattern, minimum / maximum,
// minLength / maxLength, items, minItems / maxItems, additionalProperties:false, plus a few coercions a language model needs:
//   "104" -> 104 for an integer, "true" -> true, a JSON text -> an array / object, "5,6" -> [5, 6] for a list of ids.
// Extra keywords: `expect` (the noun used in the message, e.g. "a date YYYY-MM-DD") and `lookup` (checked against the lookups passed in ctx).
// Every error names the field and shows a correct example.

class ValidationError extends Error {}

const short = (v) => { let s; try { s = JSON.stringify(v); } catch { s = String(v); } if (s === undefined) s = 'undefined'; return s.length > 60 ? s.slice(0, 57) + '...' : s; };
const typesOf = (s) => (Array.isArray(s.type) ? s.type : s.type ? [s.type] : []);
const NOUN = { string: 'a string', integer: 'an integer', number: 'a number', boolean: 'true or false', array: 'a list', object: 'an object', null: 'null' };

function fits(type, v) {
  switch (type) {
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'null': return v === null;
    default: return true;
  }
}
// try to turn a wrong-typed value into one of the wanted types; undefined = not possible
function coerce(types, v) {
  if (typeof v === 'string') {
    const t = v.trim();
    if (types.includes('integer') && /^-?\d+$/.test(t)) return Number(t);
    if (types.includes('number') && /^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    if (types.includes('boolean') && /^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
    if (types.includes('null') && /^(null|none)$/i.test(t)) return null;
    if ((types.includes('array') && t.startsWith('[')) || (types.includes('object') && t.startsWith('{'))) { try { return JSON.parse(t); } catch { /* not json */ } }
    if (types.includes('array') && !types.includes('string')) return t === '' ? [] : t.split(',').map((x) => x.trim()).filter(Boolean);
  }
  if (typeof v === 'number' && types.includes('boolean') && (v === 0 || v === 1)) return v === 1;
  if (typeof v === 'number' && types.includes('string') && !types.includes('integer') && !types.includes('number')) return String(v);
  if (!Array.isArray(v) && v !== null && v !== undefined && types.includes('array') && !types.includes('string') && !types.includes('object')) return [v];
  return undefined;
}

// returns the coerced value; throws ValidationError('"path" problem') on the first problem
function check(schema, v, p, ctx) {
  const fail = (msg) => { throw new ValidationError(`"${p}" ${msg}`); };
  const types = typesOf(schema);
  if (types.includes('null') && typeof v === 'string' && /^(null|none)$/i.test(v.trim())) v = null; // "none" clears a field, as in the CLI
  if (types.length && !types.some((t) => fits(t, v))) {
    const c = coerce(types, v);
    if (c === undefined || !types.some((t) => fits(t, c))) fail(`must be ${schema.expect || types.map((t) => NOUN[t] || t).join(' or ')}, got ${short(v)}`);
    v = c;
  }
  if (typeof v === 'string') {
    if (schema.minLength !== undefined && v.trim().length < schema.minLength) fail(schema.minLength === 1 ? 'must not be empty' : `must have at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && v.length > schema.maxLength) fail(`must have at most ${schema.maxLength} characters, got ${v.length}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) fail(`must be ${schema.expect || `in the form ${schema.pattern}`}, got ${short(v)}`);
  }
  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) fail(`must be at least ${schema.minimum}, got ${v}`);
    if (schema.maximum !== undefined && v > schema.maximum) fail(`must be at most ${schema.maximum}, got ${v}`);
  }
  if (schema.enum && v !== null && !schema.enum.includes(v)) fail(`must be one of ${schema.enum.join(', ')}, got ${short(v)}`);
  if (schema.lookup && v !== null && ctx?.lookups?.[schema.lookup]) {
    const rows = ctx.lookups[schema.lookup];
    const s = String(v).trim();
    const hit = rows.some((r) => String(r.id) === s || String(r.name_he).toLowerCase() === s.toLowerCase());
    if (!hit) fail(`must be one of ${rows.map((r) => r.name_he).join(', ')}, got ${short(v)}`);
  }
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) fail(`needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && v.length > schema.maxItems) fail(`takes at most ${schema.maxItems} item(s), got ${v.length}`);
    if (schema.items) v = v.map((x, i) => check(schema.items, x, `${p}[${i}]`, ctx));
  }
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && (schema.properties || schema.required)) {
    const out = {};
    const props = schema.properties || {};
    for (const k of schema.required || []) if (v[k] === undefined || v[k] === null && !typesOf(props[k] || {}).includes('null')) throw new ValidationError(`"${p ? p + '.' : ''}${k}" is required`);
    for (const k of Object.keys(v)) {
      if (props[k]) { if (v[k] !== undefined) out[k] = check(props[k], v[k], p ? `${p}.${k}` : k, ctx); }
      else if (schema.additionalProperties === false) throw new ValidationError(`unknown field "${p ? p + '.' : ''}${k}". Allowed: ${Object.keys(props).join(', ')}`);
      else out[k] = v[k];
    }
    v = out;
  }
  return v;
}

// validate the arguments of one tool; the message starts with the tool name and ends with a correct example
function validateArgs(tool, args, ctx = {}) {
  const input = args === undefined || args === null ? {} : args;
  try {
    if (typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('the arguments must be an object');
    return { ok: true, value: check({ type: 'object', ...tool.schema }, input, '', ctx) };
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    const ex = tool.example ? ` Example: ${JSON.stringify(tool.example)}` : '';
    return { ok: false, error: `${tool.name}: ${e.message.replace(/^"" /, '')}.${ex}` };
  }
}

module.exports = { validateArgs, check, ValidationError };
