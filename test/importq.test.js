'use strict';
process.env.MESIMOT_SEMANTIC = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../lib/db');
const { createStore } = require('../lib/store');
const { createKnowledge } = require('../lib/knowledge');
const { createChat } = require('../lib/chat');
const { createImporter } = require('../lib/importer');

test('questions raised inside an import run become ONE digest line, not attention items; outside an import run they stay attention items', () => {
  const db = open(':memory:'); const store = createStore(db); const knowledge = createKnowledge(db, store); const chat = createChat(db, store, knowledge); const importer = createImporter({ db, store, knowledge, chat });
  const a = store.assistantId(); const imp = importer.liveBatch().id;
  const run = chat.startRun('import', 1); db.prepare('UPDATE claude_runs SET import_id=? WHERE id=?').run(imp, run);
  for (let i = 0; i < 7; i++) store.addAttention(a, { kind: 'question', text: `שאלה מהייבוא מספר ${i}` });
  store.addAttention(a, { kind: 'reminder', text: 'תזכורת רגילה' });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM attention WHERE status='open'").get().c, 1, 'only the reminder is an attention item');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM import_questions').get().c, 7);
  const d = importer.liveDigest(new Date(Date.now() - 3600000).toISOString());
  assert.match(d.text, /שאלות אליך \(7\)/); assert.match(d.text, /ועוד 2/);
  assert.equal(importer.liveDigest(new Date(Date.now() - 3600000).toISOString()).text.includes('שאלות אליך'), false, 'each question is reported once');
  db.prepare('UPDATE claude_runs SET finished_at=? WHERE id=?').run(new Date().toISOString(), run);
  store.addAttention(a, { kind: 'question', text: 'שאלה רגילה' });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM attention WHERE status='open' AND kind='question'").get().c, 1);
});
