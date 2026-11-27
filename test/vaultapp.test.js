'use strict';
const os = require('os'); const path = require('path'); const fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mesimot-vaultapp-'));
process.env.MESIMOT_FILES = path.join(TMP, 'files'); process.env.MESIMOT_DB_KEY_FILE = path.join(TMP, 'db.key'); process.env.MESIMOT_TMP = path.join(TMP, 'shm'); process.env.MESIMOT_SEMANTIC = '0'; process.env.MESIMOT_NO_BG = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { build } = require('../lib/server');
const vault = require('../lib/vault');
const WORD = 'ערבות-בנקאית-ייחודית-לבדיקה';

function multipart(name, mime, content) {
  const b = 'XBOUNDARYX';
  const body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`), content, Buffer.from(`\r\n--${b}--\r\n`)]);
  return { body, headers: { authorization: 'Bearer t', 'content-type': `multipart/form-data; boundary=${b}` } };
}

test('an uploaded file is stored encrypted, still indexed (text extraction), downloadable in plain, and its text is not on disk', async () => {
  const db = open(':memory:'); const app = build({ db, token: 't', loginDelayMs: 0 });
  const content = Buffer.from(`מכתב לדוגמה\n${WORD} על סך חמישים אלף שקלים. `.repeat(40));
  const m = multipart('מכתב.txt', 'text/plain', content);
  const up = await app.inject({ method: 'POST', url: '/api/files', payload: m.body, headers: m.headers });
  assert.equal(up.statusCode, 201, up.body); const f = up.json()[0];
  const row = db.prepare('SELECT * FROM files WHERE id=?').get(f.id);
  assert.ok(vault.isEncrypted(row.path), 'the stored file is encrypted'); assert.ok(!fs.readFileSync(row.path).includes(Buffer.from(WORD)), 'no readable text on disk');
  assert.equal(row.size, content.length); assert.equal(vault.plainSize(row.path), content.length);
  assert.ok(db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_id=?').get(f.id).c >= 1, 'text was extracted from the encrypted file');
  const dl = await app.inject({ method: 'GET', url: `/api/files/${f.id}/download`, headers: { authorization: 'Bearer t' } });
  assert.equal(dl.statusCode, 200); assert.deepEqual(dl.rawPayload, content); assert.equal(+dl.headers['content-length'], content.length);
  assert.deepEqual(fs.readdirSync(vault.tmpRoot()).filter((d) => d !== 'view'), [], 'no plaintext temp left');
  // a file that is still plain (not migrated yet) is served the same way
  const plain = path.join(TMP, 'files', 'plain.txt'); fs.writeFileSync(plain, 'plain old file'); db.prepare('UPDATE files SET path=? WHERE id=?').run(plain, f.id);
  const dl2 = await app.inject({ method: 'GET', url: `/api/files/${f.id}/download`, headers: { authorization: 'Bearer t' } }); assert.equal(dl2.body, 'plain old file');
});

test('a scanned image the assistant has to look at is shown through a decrypted private copy in the temp dir', async () => {
  const db = open(':memory:'); const app = build({ db, token: 't', loginDelayMs: 0 });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const m = multipart('scan.png', 'image/png', png);
  const up = await app.inject({ method: 'POST', url: '/api/files', payload: m.body, headers: m.headers }); const f = up.json()[0];
  const show = (await app.inject({ method: 'GET', url: `/api/files/${f.id}/show`, headers: { authorization: 'Bearer t' } })).json();
  assert.ok(show.view_path, 'poor text: a view path is given'); assert.ok(show.view_path.startsWith(vault.viewRoot()), 'in the private temp dir'); assert.deepEqual(fs.readFileSync(show.view_path), png);
  assert.ok(vault.sweepViews() >= 1); assert.ok(!fs.existsSync(show.view_path));
});
