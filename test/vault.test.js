'use strict';
const os = require('os'); const path = require('path'); const fs = require('fs'); const crypto = require('crypto');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-vault-'));
process.env.MESIMOT_DB_KEY_FILE = path.join(TMP, 'k', 'db.key'); process.env.MESIMOT_TMP = path.join(TMP, 'shm');
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../lib/vault');
const K2 = 'cd'.repeat(32), K3 = '12'.repeat(32);
const rnd = (n) => crypto.randomBytes(n);
const sizes = [0, 1, 100, V.CHUNK - 1, V.CHUNK, V.CHUNK + 1, 3 * V.CHUNK, 3 * V.CHUNK + 17];

test('roundtrip for every chunk boundary: buffer, stream, size, sha256; ciphertext hides the content and differs per write', async () => {
  for (const n of sizes) {
    const data = rnd(n); const f = path.join(TMP, `r${n}.bin`);
    V.writeFile(f, data); assert.ok(V.isEncrypted(f));
    assert.deepEqual(V.readFile(f), data, `size ${n}`);
    assert.equal(V.plainSize(f), n);
    const chunks = []; for await (const c of V.createReadStream(f)) chunks.push(c); assert.deepEqual(Buffer.concat(chunks), data);
    assert.equal(await V.sha256(f), crypto.createHash('sha256').update(data).digest('hex'));
    const g = path.join(TMP, `r${n}b.bin`); V.writeFile(g, data); assert.notDeepEqual(fs.readFileSync(f), fs.readFileSync(g), 'fresh salt per file');
  }
  const text = Buffer.from('מסמך סודי מאוד '.repeat(2000)); const f = path.join(TMP, 'text.txt'); V.writeFile(f, text);
  assert.ok(!fs.readFileSync(f).includes(Buffer.from('סודי')), 'no plaintext on disk');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

test('streamed write (writeStream) produces the same format and reports size and hash', async () => {
  const data = rnd(5 * V.CHUNK + 3); const f = path.join(TMP, 'ws.bin');
  const r = await V.writeStream(f, require('stream').Readable.from([data.subarray(0, 1000), data.subarray(1000)]));
  assert.equal(r.size, data.length); assert.equal(r.sha256, crypto.createHash('sha256').update(data).digest('hex')); assert.deepEqual(V.readFile(f), data);
});

test('tampering is detected: flipped byte, truncation (also at a chunk boundary), swapped chunks, changed header, appended data', async () => {
  const data = rnd(3 * V.CHUNK + 5); const f = path.join(TMP, 't.bin'); V.writeFile(f, data); const raw = fs.readFileSync(f);
  const bad = (buf, name) => { const p = path.join(TMP, name); fs.writeFileSync(p, buf); assert.throws(() => V.readFile(p), /EVAULT|damaged|truncated|tampered|authentication/i, name); return p; };
  const flip = Buffer.from(raw); flip[V.HEADER + 100] ^= 1; bad(flip, 'flip');
  bad(raw.subarray(0, raw.length - 3), 'trunc');
  bad(raw.subarray(0, V.HEADER + 2 * (V.CHUNK + 16)), 'truncBoundary');
  const sw = Buffer.from(raw); const c = V.CHUNK + 16; raw.subarray(V.HEADER, V.HEADER + c).copy(sw, V.HEADER + c); raw.subarray(V.HEADER + c, V.HEADER + 2 * c).copy(sw, V.HEADER); bad(sw, 'swap');
  const hd = Buffer.from(raw); hd[20] ^= 1; bad(hd, 'header');
  bad(Buffer.concat([raw, rnd(40)]), 'append');
  const p = bad(flip, 'flip2'); await assert.rejects(async () => { for await (const x of V.createReadStream(p)) void x; }, /damaged|tampered|authentication/i); // the stream form fails too
});

test('a wrong key fails; a keyring with the old key still reads; reseal moves a file to a new key and the old key no longer opens it', async () => {
  const data = rnd(2 * V.CHUNK + 9); const f = path.join(TMP, 'k.bin'); V.writeFile(f, data, { keys: [K2] });
  assert.throws(() => V.readFile(f), /key that is not available/); assert.throws(() => V.readFile(f, { keys: [K3] }), /not available/);
  assert.deepEqual(V.readFile(f, { keys: [K2] }), data);
  assert.equal(await V.reseal(f, K2, K3), true); assert.deepEqual(V.readFile(f, { keys: [K3] }), data); assert.throws(() => V.readFile(f, { keys: [K2] }), /not available/);
  assert.equal(await V.reseal(f, K2, K3), false, 'already on the new key');
  assert.deepEqual(V.readFile(f, { keys: [K3, K2] }), data);
});

test('mixed plain and encrypted files: reads pass plain files through; seal encrypts in place, verified, and wipes the plain bytes', async () => {
  const data = Buffer.from('plain attachment text שלום '.repeat(500)); const f = path.join(TMP, 'plain.txt'); fs.writeFileSync(f, data);
  assert.ok(!V.isEncrypted(f)); assert.deepEqual(V.readFile(f), data); assert.equal(V.plainSize(f), data.length);
  const chunks = []; for await (const c of V.createReadStream(f)) chunks.push(c); assert.deepEqual(Buffer.concat(chunks), data);
  assert.equal(await V.seal(f), crypto.createHash('sha256').update(data).digest('hex')); assert.ok(V.isEncrypted(f)); assert.deepEqual(V.readFile(f), data); assert.equal(await V.seal(f), false);
  assert.ok(!fs.readFileSync(f).includes(Buffer.from('attachment text')));
  assert.deepEqual(fs.readdirSync(TMP).filter((x) => /\.(old|tmp)|vault-\d/.test(x)), [], 'no leftovers');
});

test('temporary plaintext lives in the private temp dir and is removed (also on an error); plain files are used in place', async () => {
  const data = Buffer.from('%PDF-1.4 secret'); const f = path.join(TMP, 'doc.pdf'); V.writeFile(f, data);
  let seen; V.withPlainSync(f, (p) => { seen = p; assert.equal(path.extname(p), '.pdf'); assert.deepEqual(fs.readFileSync(p), data); assert.equal(fs.statSync(path.dirname(p)).mode & 0o777, 0o700); }); assert.ok(!fs.existsSync(seen));
  await V.withPlain(f, async (p) => { seen = p; assert.deepEqual(fs.readFileSync(p), data); }); assert.ok(!fs.existsSync(seen));
  await assert.rejects(V.withPlain(f, async (p) => { seen = p; throw new Error('boom'); }), /boom/); assert.ok(!fs.existsSync(seen));
  assert.throws(() => V.withPlainSync(f, (p) => { seen = p; throw new Error('boom'); }), /boom/); assert.ok(!fs.existsSync(seen));
  const pl = path.join(TMP, 'pl.txt'); fs.writeFileSync(pl, 'x'); V.withPlainSync(pl, (p) => assert.equal(p, pl));
  const v = V.viewCopy(f, 'Plan א.pdf'); assert.ok(fs.existsSync(v)); assert.deepEqual(fs.readFileSync(v), data); assert.ok(V.sweepViews() >= 1); assert.ok(!fs.existsSync(v));
  assert.deepEqual(fs.readdirSync(V.tmpRoot()).filter((d) => d !== 'view'), [], 'nothing left behind');
});
