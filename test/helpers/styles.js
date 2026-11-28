'use strict';
// a server with one active casual style for a fictional colleague and one of the owner's sent mails to him (tests of the writing styles)
const { open } = require('../../lib/db');
const { createStore } = require('../../lib/store');
const { build } = require('../../lib/server');
const TOKEN = 'styles-token-123';
function server() {
  const db = open(':memory:'); const app = build({ db, token: TOKEN, loginDelayMs: 0 }); require('./owner')(app, db);
  const store = app.styles ? null : null; const S = app.styles;
  const st = createStore(db); const ron = st.listPeople().find((p) => p.name_he === 'רון שחר'); st.updatePerson(st.ownerId(), ron.id, { emails: 'ron@exconstruct.example' });
  S.create(st.ownerId(), { key: 'colleague', name_he: 'עמית', status: 'active', rules: { formality: 'casual', greeting: '{first_name}, היי', closing: 'none', max_sentences: 2 }, assignments: [{ kind: 'person', ref: String(ron.id) }] });
  db.prepare("INSERT INTO emails (message_id, from_addr, to_addr, subject, received_at, body_text, direction, participants) VALUES ('s1','Dana <dana@exconstruct.example>','Ron <ron@exconstruct.example>','תוכניות',?,?, 'sent', ?)")
    .run('2026-11-20T08:00:00Z', 'רון, היי\nשלחת כבר את התוכניות?\n\nFrom: Ron\nישן', JSON.stringify([{ role: 'from', email: 'dana@exconstruct.example', msg_index: 0 }, { role: 'to', name: 'Ron', email: 'ron@exconstruct.example', msg_index: 0 }]));
  const t = st.createTask(st.ownerId(), { title: 'לבדוק את התוכניות עם רון' });
  return { app, db, store: st, S, ron, task: t, bearer: { authorization: `Bearer ${TOKEN}` } };
}
module.exports = { server, TOKEN };
