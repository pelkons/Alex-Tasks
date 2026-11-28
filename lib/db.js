'use strict';
const { openRaw } = require('./dbkey');
const fs = require('fs');
const path = require('path');

const OWNER_LABEL = String(require('./config').get().owner.name_he).replace(/'/g, "''");
const ASSISTANT_LABEL = String(require('./config').get().assistant.name_he).replace(/'/g, "''");
const DEFAULT_DB = process.env.MESIMOT_DB || path.join(__dirname, '..', 'data', 'mesimot.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  name_he TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','pm','assistant','contact')),
  emails TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS statuses (
  id INTEGER PRIMARY KEY,
  name_he TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL,
  is_done INTEGER NOT NULL DEFAULT 0,
  is_closed INTEGER NOT NULL DEFAULT 0,
  hidden_default INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS priorities (
  id INTEGER PRIMARY KEY,
  name_he TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL,
  color TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name_he TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'פעיל',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES people(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY,
  message_id TEXT UNIQUE,
  from_addr TEXT,
  to_addr TEXT,
  subject TEXT,
  received_at TEXT,
  body_text TEXT,
  forwarded_from TEXT,
  attachments TEXT NOT NULL DEFAULT '[]',
  project_id INTEGER REFERENCES projects(id),
  processed_at TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  project_id INTEGER NOT NULL REFERENCES projects(id),
  assignee_id INTEGER REFERENCES people(id),
  status_id INTEGER NOT NULL REFERENCES statuses(id),
  priority_id INTEGER NOT NULL REFERENCES priorities(id),
  due_date TEXT,
  source_email_id INTEGER REFERENCES emails(id),
  parent_task_id INTEGER REFERENCES tasks(id),
  created_by INTEGER REFERENCES people(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status_id);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  task_id INTEGER REFERENCES tasks(id),
  project_id INTEGER REFERENCES projects(id),
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','voice','summary')),
  author_id INTEGER REFERENCES people(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_task ON notes(task_id);
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'חדש',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attention (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('reminder','question','suggestion')),
  text TEXT NOT NULL,
  task_id INTEGER REFERENCES tasks(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','dismissed')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER REFERENCES people(id),
  entity TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  field TEXT,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_events_pending ON events(processed_at);
CREATE TABLE IF NOT EXISTS claude_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  trigger TEXT,
  events_count INTEGER NOT NULL DEFAULT 0,
  summary_he TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY,
  author TEXT NOT NULL CHECK (author IN ('owner','claude')),
  channel TEXT NOT NULL CHECK (channel IN ('telegram','web')),
  text TEXT NOT NULL DEFAULT '',
  voice_file TEXT,
  transcript TEXT,
  file_ids TEXT NOT NULL DEFAULT '[]',
  task_id INTEGER REFERENCES tasks(id),
  telegram_message_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  original_name TEXT NOT NULL,
  path TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  text_path TEXT,
  task_id INTEGER REFERENCES tasks(id),
  project_id INTEGER REFERENCES projects(id),
  source TEXT NOT NULL CHECK (source IN ('telegram','web','email')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Latin spellings of the configured people (matching in emails): from config, nothing hardcoded
function seedNames() {
  const cfg = require('./config').get();
  return [[cfg.owner.name_he, cfg.owner.name_en], ...cfg.team.map((p) => [p.name_he, p.name_en]), ...cfg.bosses.map((p) => [p.name_he, p.name_en])].filter(([h, e]) => h && e);
}
const PROJECT_COLORS = ['#2563eb', '#0d9488', '#d97706', '#9333ea', '#db2777', '#16a34a', '#0891b2', '#dc6b2f', '#6366f1', '#65a30d'];
const now = () => new Date().toISOString();

function seed(db) {
  if (db.prepare("SELECT 1 FROM settings WHERE key='seeded'").get()) return;
  const t = now();
  const tx = db.transaction(() => {
    const ip = db.prepare('INSERT INTO people (name_he, role, emails, created_at) VALUES (?,?,?,?)');
    const cfg = require('./config').get();
    ip.run(cfg.owner.name_he, 'owner', JSON.stringify(cfg.owner.emails), t);
    for (const p of cfg.team) ip.run(p.name_he, p.role === 'contact' ? 'contact' : 'pm', JSON.stringify(p.emails || []), t);
    ip.run(cfg.assistant.name_he, 'assistant', '[]', t);
    const ib = db.prepare('INSERT INTO people (name_he, role, emails, notes, created_at) VALUES (?,?,?,?,?)');
    for (const p of cfg.bosses) ib.run(p.name_he, 'contact', JSON.stringify(p.emails || []), `הממונה של ${cfg.owner.name_he}`, t);

    const is = db.prepare('INSERT INTO statuses (name_he, sort, is_done, is_closed, hidden_default, color) VALUES (?,?,?,?,?,?)');
    is.run('חדש', 1, 0, 0, 0, '#2563eb');
    is.run('בטיפול', 2, 0, 0, 0, '#d97706');
    is.run('ממתין', 3, 0, 0, 0, '#7c3aed');
    is.run('הושלם', 4, 1, 1, 0, '#16a34a');
    is.run('בוטל', 5, 0, 1, 1, '#6b7280');

    const ipr = db.prepare('INSERT INTO priorities (name_he, sort, color) VALUES (?,?,?)');
    ipr.run('דחוף', 1, '#dc2626');
    ipr.run('רגיל', 2, '#2563eb');
    ipr.run('נמוך', 3, '#6b7280');

    db.prepare('INSERT INTO projects (name_he, is_default, created_by, created_at) VALUES (?,?,?,?)')
      .run('לא משויך', 1, 1, t);

    const st = db.prepare('INSERT INTO settings (key, value) VALUES (?,?)');
    st.run('email_allowlist', JSON.stringify(require('./config').get().allowlist));
    st.run('seeded', t);
  });
  tx();
}

// ADD COLUMN that survives a race: the site and the runner often start together, both see the column missing and both ALTER; the loser must not crash
function alterAdd(db, table, column, ddl) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`); }
  catch (e) { if (!/duplicate column name/i.test(String(e.message))) throw e; }
}
const migrationRace = (e) => /duplicate column name|already exists|UNIQUE constraint failed|database is locked|SQLITE_BUSY/i.test(String(e && e.message));

function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  const add = (name, ddl) => { if (!cols.includes(name)) alterAdd(db, 'tasks', name, ddl); };
  add('requester_id', 'INTEGER REFERENCES people(id)');
  add('source_date', 'TEXT');
  add('due_source', "TEXT CHECK (due_source IN ('explicit','estimated','manual'))");
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_requester ON tasks(requester_id)');
  const pcols = db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
  if (!pcols.includes('color')) db.exec("ALTER TABLE projects ADD COLUMN color TEXT NOT NULL DEFAULT ''");
  for (const p of db.prepare("SELECT id FROM projects WHERE color='' AND is_default=0").all()) {
    db.prepare('UPDATE projects SET color=? WHERE id=?').run(PROJECT_COLORS[p.id % PROJECT_COLORS.length], p.id);
  }
}

// Triggers that keep the live search index current. ARCHIVE mail (archived = 1: old Outlook mail indexed by lib/archive.js) is NOT written to `search_index`: it has its own index
// (`search_archive`, same layout) so the live index, the live embedding queue and live search stay small and fast however large the archive grows.
const LIVE_INDEX_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS si_emails_ai AFTER INSERT ON emails WHEN new.archived = 0 BEGIN
  INSERT INTO search_index (title, body, kind, ref_id, project_id, ts, person)
  VALUES (COALESCE(new.subject, ''), COALESCE(new.body_text, ''), 'email', new.id, new.project_id,
    COALESCE(new.forwarded_date, new.received_at), COALESCE(new.forwarded_from, new.from_addr, ''));
END;

CREATE TRIGGER IF NOT EXISTS si_emails_au AFTER UPDATE ON emails WHEN new.archived = 0 BEGIN
  DELETE FROM search_index WHERE kind = 'email' AND ref_id = old.id;
  INSERT INTO search_index (title, body, kind, ref_id, project_id, ts, person)
  VALUES (COALESCE(new.subject, ''), COALESCE(new.body_text, ''), 'email', new.id, new.project_id,
    COALESCE(new.forwarded_date, new.received_at), COALESCE(new.forwarded_from, new.from_addr, ''));
END;

CREATE TRIGGER IF NOT EXISTS si_files_ai AFTER INSERT ON files WHEN new.archived = 0 BEGIN
  INSERT INTO search_index (title, body, kind, ref_id, project_id, ts, person)
  VALUES (new.original_name, COALESCE(new.summary, ''), 'file', new.id, new.project_id, new.created_at, '');
END;

CREATE TRIGGER IF NOT EXISTS si_files_au AFTER UPDATE ON files WHEN new.archived = 0 BEGIN
  DELETE FROM search_index WHERE kind = 'file' AND ref_id = old.id;
  INSERT INTO search_index (title, body, kind, ref_id, project_id, ts, person)
  VALUES (new.original_name, COALESCE(new.summary, ''), 'file', new.id, new.project_id, new.created_at, '');
  UPDATE search_index SET project_id = new.project_id WHERE kind = 'chunk' AND ref_id IN (SELECT id FROM chunks WHERE file_id = new.id);
END;

CREATE TRIGGER IF NOT EXISTS si_chunks_ai AFTER INSERT ON chunks WHEN new.archived = 0 BEGIN
  INSERT INTO search_index (title, body, kind, ref_id, project_id, ts, person)
  VALUES ((SELECT original_name FROM files WHERE id = new.file_id) || ' (עמוד ' || COALESCE(new.page, 1) || ')', new.text, 'chunk', new.id,
    (SELECT project_id FROM files WHERE id = new.file_id), (SELECT created_at FROM files WHERE id = new.file_id), '');
END;
`;

const FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  title, body, kind UNINDEXED, ref_id UNINDEXED, project_id UNINDEXED, ts UNINDEXED, person,
  tokenize = 'trigram'
);
-- tasks
CREATE TRIGGER IF NOT EXISTS si_tasks_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO search_index (title, body, kind, ref_id, project_id, ts, person)
  VALUES (new.title, new.description, 'task', new.id, new.project_id, COALESCE(new.source_date, new.created_at),
    COALESCE((SELECT name_he FROM people WHERE id = new.requester_id), '') || ' ' || COALESCE((SELECT name_he FROM people WHERE id = new.assignee_id), ''));
END;
CREATE TRIGGER IF NOT EXISTS si_tasks_au AFTER UPDATE ON tasks BEGIN
  DELETE FROM search_index WHERE kind = 'task' AND ref_id = old.id;
  INSERT INTO search_index (title, body, kind, ref_id, project_id, ts, person)
  VALUES (new.title, new.description, 'task', new.id, new.project_id, COALESCE(new.source_date, new.created_at),
    COALESCE((SELECT name_he FROM people WHERE id = new.requester_id), '') || ' ' || COALESCE((SELECT name_he FROM people WHERE id = new.assignee_id), ''));
END;
CREATE TRIGGER IF NOT EXISTS si_tasks_ad AFTER DELETE ON tasks BEGIN
  DELETE FROM search_index WHERE kind = 'task' AND ref_id = old.id;
END;
-- notes (on tasks or projects)
CREATE TRIGGER IF NOT EXISTS si_notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO search_index (title, body, kind, ref_id, project_id, ts, person)
  VALUES ('', new.text, 'note', new.id,
    COALESCE(new.project_id, (SELECT project_id FROM tasks WHERE id = new.task_id)), new.created_at,
    COALESCE((SELECT name_he FROM people WHERE id = new.author_id), ''));
END;
CREATE TRIGGER IF NOT EXISTS si_notes_ad AFTER DELETE ON notes BEGIN
  DELETE FROM search_index WHERE kind = 'note' AND ref_id = old.id;
END;
-- emails
CREATE TRIGGER IF NOT EXISTS si_emails_ad AFTER DELETE ON emails BEGIN
  DELETE FROM search_index WHERE kind = 'email' AND ref_id = old.id;
END;
-- chat
CREATE TRIGGER IF NOT EXISTS si_chat_ai AFTER INSERT ON chat_messages BEGIN
  INSERT INTO search_index (title, body, kind, ref_id, project_id, ts, person)
  VALUES ('', new.text || ' ' || COALESCE(new.transcript, ''), 'chat', new.id, NULL, new.created_at,
    CASE new.author WHEN 'owner' THEN '${OWNER_LABEL}' ELSE '${ASSISTANT_LABEL}' END);
END;
CREATE TRIGGER IF NOT EXISTS si_chat_ad AFTER DELETE ON chat_messages BEGIN
  DELETE FROM search_index WHERE kind = 'chat' AND ref_id = old.id;
END;
-- files: name and summary (full text lives in chunks)
CREATE TRIGGER IF NOT EXISTS si_files_ad AFTER DELETE ON files BEGIN
  DELETE FROM search_index WHERE kind = 'file' AND ref_id = old.id;
END;
-- document chunks
CREATE TRIGGER IF NOT EXISTS si_chunks_ad AFTER DELETE ON chunks BEGIN
  DELETE FROM search_index WHERE kind = 'chunk' AND ref_id = old.id;
END;
-- project facts (only the current value of each key is searchable)
CREATE TRIGGER IF NOT EXISTS si_facts_ai AFTER INSERT ON project_facts WHEN new.superseded_by IS NULL BEGIN
  INSERT INTO search_index (title, body, kind, ref_id, project_id, ts, person)
  VALUES (new.key, new.value || ' ' || new.unit || ' (נכון ל־' || new.as_of_date || ')', 'fact', new.id, new.project_id, new.as_of_date, '');
END;
CREATE TRIGGER IF NOT EXISTS si_facts_au AFTER UPDATE ON project_facts BEGIN
  DELETE FROM search_index WHERE kind = 'fact' AND ref_id = old.id;
  INSERT INTO search_index (title, body, kind, ref_id, project_id, ts, person)
  SELECT new.key, new.value || ' ' || new.unit || ' (נכון ל־' || new.as_of_date || ')', 'fact', new.id, new.project_id, new.as_of_date, '' WHERE new.superseded_by IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS si_facts_ad AFTER DELETE ON project_facts BEGIN
  DELETE FROM search_index WHERE kind = 'fact' AND ref_id = old.id;
END;
-- protocols and their items
CREATE TRIGGER IF NOT EXISTS si_protocols_ai AFTER INSERT ON protocols BEGIN
  INSERT INTO search_index (title, body, kind, ref_id, project_id, ts, person)
  VALUES (new.title, new.summary_he || ' ' || new.location, 'protocol', new.id, new.project_id, new.meeting_at, new.participants);
END;
CREATE TRIGGER IF NOT EXISTS si_protocols_au AFTER UPDATE ON protocols BEGIN
  DELETE FROM search_index WHERE kind = 'protocol' AND ref_id = old.id;
  INSERT INTO search_index (title, body, kind, ref_id, project_id, ts, person)
  VALUES (new.title, new.summary_he || ' ' || new.location, 'protocol', new.id, new.project_id, new.meeting_at, new.participants);
END;
CREATE TRIGGER IF NOT EXISTS si_protocols_ad AFTER DELETE ON protocols BEGIN
  DELETE FROM search_index WHERE kind = 'protocol' AND ref_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS si_pitems_ai AFTER INSERT ON protocol_items BEGIN
  INSERT INTO search_index (title, body, kind, ref_id, project_id, ts, person)
  VALUES ((SELECT title FROM protocols WHERE id = new.protocol_id), new.text, 'protocol_item', new.id,
    (SELECT project_id FROM protocols WHERE id = new.protocol_id), (SELECT meeting_at FROM protocols WHERE id = new.protocol_id), COALESCE(new.owner_name, ''));
END;
CREATE TRIGGER IF NOT EXISTS si_pitems_au AFTER UPDATE ON protocol_items BEGIN
  DELETE FROM search_index WHERE kind = 'protocol_item' AND ref_id = old.id;
  INSERT INTO search_index (title, body, kind, ref_id, project_id, ts, person)
  VALUES ((SELECT title FROM protocols WHERE id = new.protocol_id), new.text, 'protocol_item', new.id,
    (SELECT project_id FROM protocols WHERE id = new.protocol_id), (SELECT meeting_at FROM protocols WHERE id = new.protocol_id), COALESCE(new.owner_name, ''));
END;
CREATE TRIGGER IF NOT EXISTS si_pitems_ad AFTER DELETE ON protocol_items BEGIN
  DELETE FROM search_index WHERE kind = 'protocol_item' AND ref_id = old.id;
END;
-- knowledge (superseded items are not searchable)
CREATE TRIGGER IF NOT EXISTS si_knowledge_ai AFTER INSERT ON knowledge WHEN new.superseded_by IS NULL BEGIN
  INSERT INTO search_index (title, body, kind, ref_id, project_id, ts, person)
  VALUES (new.title, new.body, 'knowledge', new.id, new.project_id, new.updated_at, '');
END;
CREATE TRIGGER IF NOT EXISTS si_knowledge_au AFTER UPDATE ON knowledge BEGIN
  DELETE FROM search_index WHERE kind = 'knowledge' AND ref_id = old.id;
  INSERT INTO search_index (title, body, kind, ref_id, project_id, ts, person)
  SELECT new.title, new.body, 'knowledge', new.id, new.project_id, new.updated_at, '' WHERE new.superseded_by IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS si_knowledge_ad AFTER DELETE ON knowledge BEGIN
  DELETE FROM search_index WHERE kind = 'knowledge' AND ref_id = old.id;
END;
`;

const STAGE2_TABLES = `
CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),
  kind TEXT NOT NULL DEFAULT 'fact' CHECK (kind IN ('fact','decision','contact','note','doc')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('chat','email','file','manual')),
  source_ref TEXT,
  created_by INTEGER REFERENCES people(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  superseded_by INTEGER REFERENCES knowledge(id)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge(project_id);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  page INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
`;

function migrateStage2(db) {
  const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
  const add = (t, c, ddl) => { if (!has(t, c)) alterAdd(db, t, c, ddl); };
  db.exec(STAGE2_TABLES);
  db.exec(`CREATE TABLE IF NOT EXISTS calendar_items (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, start TEXT NOT NULL, end TEXT, all_day INTEGER NOT NULL DEFAULT 0, location TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
    task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL, project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, source_email_id INTEGER REFERENCES emails(id) ON DELETE SET NULL,
    created_by INTEGER REFERENCES people(id), created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_cal_start ON calendar_items(start);`);
  db.exec(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY, channel TEXT NOT NULL DEFAULT 'email', urgency TEXT NOT NULL DEFAULT 'digest' CHECK (urgency IN ('digest','urgent')),
    title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', link TEXT, dedupe_key TEXT, created_at TEXT NOT NULL, sent_at TEXT);
    CREATE INDEX IF NOT EXISTS idx_notif_pending ON notifications(sent_at);`);
  add('people', 'name_en', 'TEXT');
  db.prepare("UPDATE people SET name_he='אלכס', name_en='Claude' WHERE role='assistant' AND name_he='Claude'").run();
    for (const [he, en] of seedNames()) {
    db.prepare('UPDATE people SET name_en=? WHERE name_he=? AND name_en IS NULL').run(en, he);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS protocols (
    id INTEGER PRIMARY KEY, project_id INTEGER REFERENCES projects(id), meeting_at TEXT NOT NULL, title TEXT NOT NULL, location TEXT NOT NULL DEFAULT '',
    participants TEXT NOT NULL DEFAULT '[]', summary_he TEXT NOT NULL DEFAULT '', source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('email','file','chat','manual')),
    source_id INTEGER, next_meeting_at TEXT, created_by INTEGER REFERENCES people(id), created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_protocols_project ON protocols(project_id, meeting_at);
    CREATE TABLE IF NOT EXISTS protocol_items (
    id INTEGER PRIMARY KEY, protocol_id INTEGER NOT NULL REFERENCES protocols(id) ON DELETE CASCADE, idx INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'action' CHECK (kind IN ('action','decision','info')), text TEXT NOT NULL, owner_name TEXT, owner_person_id INTEGER REFERENCES people(id),
    party TEXT NOT NULL DEFAULT 'internal' CHECK (party IN ('internal','external')), due_date TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','promoted','dismissed')), recommended INTEGER NOT NULL DEFAULT 0,
    task_id INTEGER REFERENCES tasks(id), created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_pitems_protocol ON protocol_items(protocol_id, idx);
    CREATE INDEX IF NOT EXISTS idx_pitems_task ON protocol_items(task_id);`);
  db.exec(`CREATE TABLE IF NOT EXISTS project_facts (
    id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key TEXT NOT NULL, value TEXT NOT NULL, unit TEXT NOT NULL DEFAULT '', as_of_date TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('email','chat','file','manual')), source_id INTEGER,
    created_by INTEGER REFERENCES people(id), created_at TEXT NOT NULL, superseded_by INTEGER REFERENCES project_facts(id));
    CREATE INDEX IF NOT EXISTS idx_facts_project ON project_facts(project_id, key);`);
  add('projects', 'summary_he', "TEXT NOT NULL DEFAULT ''");
  add('files', 'summary', 'TEXT');
  db.exec('CREATE TABLE IF NOT EXISTS email_html (email_id INTEGER PRIMARY KEY, html TEXT, state INTEGER NOT NULL)'); // not a column of emails: an UPDATE there re-indexes the search and the embeddings
  db.exec(`CREATE TABLE IF NOT EXISTS email_inline (id INTEGER PRIMARY KEY, email_id INTEGER NOT NULL, cid TEXT, name TEXT, mime TEXT, size INTEGER, data BLOB, inline INTEGER NOT NULL DEFAULT 1); CREATE INDEX IF NOT EXISTS email_inline_email ON email_inline(email_id)`);
  add('files', 'email_id', 'INTEGER');
  add('files', 'sha256', 'TEXT');
  add('people', 'status', "TEXT NOT NULL DEFAULT 'full'");
  add('people', 'company', 'TEXT');
  add('people', 'role_text', 'TEXT');
  add('projects', 'partial', 'INTEGER NOT NULL DEFAULT 0');
  add('claude_runs', 'required_entities', 'TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS mentions (
    id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL CHECK (entity_type IN ('person','project')), entity_id INTEGER NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('task','chat','note','knowledge','email','protocol_item')), source_id INTEGER NOT NULL,
    surface TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, UNIQUE (entity_type, entity_id, source_type, source_id));
    CREATE INDEX IF NOT EXISTS idx_mentions_entity ON mentions(entity_type, entity_id);
    CREATE TABLE IF NOT EXISTS entity_decisions (
    id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL, identity TEXT NOT NULL, verdict TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL,
    UNIQUE (entity_type, entity_id, identity));`);
  add('tasks', 'unassigned_reason', 'TEXT');
  add('tasks', 'needs_review', 'INTEGER NOT NULL DEFAULT 0');
  add('claude_runs', 'facts_checked', 'INTEGER');
  add('claude_runs', 'model', 'TEXT');
  add('chat_messages', 'kind', 'TEXT');
  add('claude_runs', 'effort', 'TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS gate_log (
    id INTEGER PRIMARY KEY, run_id INTEGER, at TEXT NOT NULL, code TEXT NOT NULL, task_id INTEGER, detail TEXT NOT NULL,
    round INTEGER NOT NULL DEFAULT 0, outcome TEXT NOT NULL CHECK (outcome IN ('raised','resolved','accepted','autofixed')));
    CREATE INDEX IF NOT EXISTS idx_gate_run ON gate_log(run_id);`);
  db.exec(`CREATE TABLE IF NOT EXISTS pulse_log (id INTEGER PRIMARY KEY, day TEXT NOT NULL, item_key TEXT NOT NULL, at TEXT NOT NULL, UNIQUE (day, item_key));
    CREATE TABLE IF NOT EXISTS heartbeat (key TEXT PRIMARY KEY, at TEXT NOT NULL, detail TEXT);
    CREATE TABLE IF NOT EXISTS watchdog_state (service TEXT PRIMARY KEY, failing_since TEXT, restarts INTEGER NOT NULL DEFAULT 0, last_alert_at TEXT, alerted INTEGER NOT NULL DEFAULT 0, detail TEXT);`);
  db.exec(`CREATE TABLE IF NOT EXISTS housekeeping_log (id INTEGER PRIMARY KEY, at TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);`);
  add('files', 'text_status', 'TEXT');
  add('files', 'index_note', 'TEXT');
  add('emails', 'file_id', 'INTEGER');
  add('emails', 'participants', 'TEXT');
  add('emails', 'thread_key', 'TEXT');
  add('emails', 'project_numbers', 'TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS task_emails (
    id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, email_id INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
    relation TEXT NOT NULL DEFAULT 'updated' CHECK (relation IN ('created','updated','closed','info')), created_at TEXT NOT NULL, UNIQUE (task_id, email_id));
    CREATE INDEX IF NOT EXISTS idx_task_emails_email ON task_emails(email_id);
    CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(thread_key);
    INSERT OR IGNORE INTO task_emails (task_id, email_id, relation, created_at) SELECT id, source_email_id, 'created', created_at FROM tasks WHERE source_email_id IS NOT NULL;`);
  add('emails', 'thread', 'TEXT');
  add('emails', 'mail_provider', 'TEXT');
  add('emails', 'forwarded_date', 'TEXT');
  add('emails', 'original_subject', 'TEXT');
  add('emails', 'labels', "TEXT NOT NULL DEFAULT '[]'");
  add('chat_messages', 'lang', 'TEXT');
  add('chat_messages', 'tg_sent', 'INTEGER NOT NULL DEFAULT 1');
  add('chat_messages', 'task_ids', "TEXT NOT NULL DEFAULT '[]'");
  add('files', 'text_content', 'TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS run_trace (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, arg TEXT, extra TEXT);
    CREATE INDEX IF NOT EXISTS idx_trace_run ON run_trace(run_id);`);
  db.exec(`CREATE TABLE IF NOT EXISTS imports (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, finished_at TEXT, file_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'staging',
      stats TEXT NOT NULL DEFAULT '{}', file_ids TEXT NOT NULL DEFAULT '[]', text TEXT, chat_message_id INTEGER, digest_sent INTEGER NOT NULL DEFAULT 0);`);
  add('emails', 'import_id', 'INTEGER'); add('emails', 'container_id', 'INTEGER'); add('emails', 'direction', 'TEXT'); add('emails', 'msgid', 'TEXT'); add('emails', 'in_reply_to', 'TEXT'); add('emails', 'refs', 'TEXT');
  add('emails', 'import_state', 'TEXT'); add('emails', 'triage', 'TEXT'); add('emails', 'noise_reason', 'TEXT'); add('emails', 'dup_of', 'INTEGER'); add('emails', 'thread_no', 'INTEGER'); add('emails', 'mail_date', 'TEXT');
  add('chat_messages', 'deleted_at', 'TEXT'); add('chat_messages', 'edited_at', 'TEXT'); add('chat_messages', 'edited_from', 'TEXT'); add('chat_messages', 'superseded', 'INTEGER NOT NULL DEFAULT 0');
  add('chat_messages', 'run_id', 'INTEGER'); add('chat_messages', 'after_id', 'INTEGER'); add('claude_runs', 'edited_msg_id', 'INTEGER');
  db.exec(`CREATE TABLE IF NOT EXISTS chat_edits (id INTEGER PRIMARY KEY, msg_id INTEGER NOT NULL, old_text TEXT, new_text TEXT, at TEXT NOT NULL, actor_id INTEGER);
    CREATE TABLE IF NOT EXISTS run_messages (run_id INTEGER NOT NULL, msg_id INTEGER NOT NULL, PRIMARY KEY (run_id, msg_id));
    CREATE INDEX IF NOT EXISTS idx_run_messages_msg ON run_messages(msg_id);`);
  add('chat_messages', 'proposal_batch', 'INTEGER'); add('chat_messages', 'confirm_id', 'INTEGER');
  db.exec(`CREATE TABLE IF NOT EXISTS confirmations (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, target_id INTEGER NOT NULL, payload TEXT, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, decided_at TEXT, result TEXT, chat_message_id INTEGER);`);
  db.exec(`CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, item_type TEXT NOT NULL, item_id INTEGER, email_id INTEGER, verdict TEXT NOT NULL CHECK (verdict IN ('up','down')),
      reason TEXT, reason_text TEXT, sender TEXT, domain TEXT, subject_kw TEXT, project_id INTEGER, model TEXT, prompt_version TEXT, run_id INTEGER, fix TEXT);
    CREATE INDEX IF NOT EXISTS idx_feedback_sender ON feedback(sender); CREATE INDEX IF NOT EXISTS idx_feedback_item ON feedback(item_type, item_id);`); add('emails', 'filter_action', 'TEXT'); add('emails', 'filter_rule', 'INTEGER');
  db.exec(`CREATE TABLE IF NOT EXISTS mail_filters (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, pattern TEXT NOT NULL, field TEXT NOT NULL DEFAULT 'any', project_id INTEGER REFERENCES projects(id),
    action TEXT NOT NULL, note TEXT, enabled INTEGER NOT NULL DEFAULT 1, hits INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS proposal_batches (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, chat_message_id INTEGER);
    CREATE TABLE IF NOT EXISTS proposals (id INTEGER PRIMARY KEY, batch INTEGER NOT NULL REFERENCES proposal_batches(id), kind TEXT NOT NULL, target_id INTEGER NOT NULL, other_id INTEGER, text TEXT NOT NULL, reason TEXT,
      status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, decided_at TEXT, result TEXT);
    CREATE INDEX IF NOT EXISTS idx_proposals_batch ON proposals(batch);`);
  add('proposals', 'payload', 'TEXT'); add('proposal_batches', 'tg_sent', 'INTEGER NOT NULL DEFAULT 1'); add('proposal_batches', 'tg_message_id', 'INTEGER'); add('proposals', 'tg_message_id', 'INTEGER');
  add('chat_messages', 'reply_to_id', 'INTEGER'); add('chat_messages', 'reply_proposal_id', 'INTEGER'); add('chat_messages', 'reply_quote', 'TEXT'); add('proposals', 'tg_sent', 'INTEGER NOT NULL DEFAULT 1');
  // NEW PROJECTS are never created by the assistant: it proposes, the owner answers (lib/projectask.js). pending_project_items = what waits for that answer; rejected_project_names = "not a project", never proposed again.
  db.exec(`CREATE TABLE IF NOT EXISTS project_proposals (id INTEGER PRIMARY KEY, name TEXT NOT NULL, norm TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]', source TEXT, context TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open', result_project_id INTEGER, proposal_id INTEGER, attention_id INTEGER, created_by INTEGER, created_at TEXT NOT NULL, decided_at TEXT);
    CREATE INDEX IF NOT EXISTS idx_pp_status ON project_proposals(status);
    CREATE TABLE IF NOT EXISTS pending_project_items (pp_id INTEGER NOT NULL, entity TEXT NOT NULL, entity_id INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (pp_id, entity, entity_id));
    CREATE INDEX IF NOT EXISTS idx_ppi_entity ON pending_project_items(entity, entity_id);
    CREATE TABLE IF NOT EXISTS rejected_project_names (norm TEXT PRIMARY KEY, name TEXT NOT NULL, pp_id INTEGER, created_at TEXT NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS benchmarks (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, config TEXT, results TEXT);`);
  db.exec(`CREATE TABLE IF NOT EXISTS reingest_queue (email_id INTEGER PRIMARY KEY, file_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, done_at TEXT);`);
  db.exec(`CREATE TABLE IF NOT EXISTS health (check_id TEXT PRIMARY KEY, label TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', at TEXT NOT NULL, since TEXT NOT NULL, critical INTEGER NOT NULL DEFAULT 0, ms INTEGER, alerted_at TEXT, alert_status TEXT);`);
  // questions the assistant raises while processing IMPORTED mail never become attention items one by one: they wait here and go into the digest (once)
  db.exec(`CREATE TABLE IF NOT EXISTS import_questions (id INTEGER PRIMARY KEY, import_id INTEGER, run_id INTEGER, kind TEXT NOT NULL, text TEXT NOT NULL, task_id INTEGER, created_at TEXT NOT NULL, digested INTEGER NOT NULL DEFAULT 0);`);
  // OUTBOUND EMAIL: nothing is sent without the owner's approval of the exact content (lib/outbox.js). The connector on the owner's PC sends; the server only signs.
  db.exec(`CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]', bcc_json TEXT NOT NULL DEFAULT '[]',
    subject TEXT NOT NULL DEFAULT '', body_text TEXT NOT NULL DEFAULT '', body_html TEXT NOT NULL DEFAULT '', attachments_json TEXT NOT NULL DEFAULT '[]', reply_to_email_id INTEGER, orig_entry_id TEXT, orig_internet_message_id TEXT,
    task_id INTEGER, status TEXT NOT NULL, content_hash TEXT NOT NULL, submitted_at TEXT, approved_at TEXT, approved_via TEXT, approved_hash TEXT, approval_sig TEXT, claimed_at TEXT, sent_at TEXT, sent_entry_id TEXT, error TEXT,
    created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);`);
  add('outbox', 'resend_of', 'INTEGER'); add('outbox', 'resent_as', 'INTEGER');
  add('chat_messages', 'rich', 'TEXT');
  add('chat_messages', 'tg_edit', 'INTEGER NOT NULL DEFAULT 0');
  add('chat_messages', 'outbox_id', 'INTEGER'); add('chat_messages', 'outbox_hash', 'TEXT');
  // LIVE OUTLOOK INGEST (connector on the owner's PC): every pushed mail is recorded once (entry id and internet message id), calendar items are a read-only mirror
  db.exec(`CREATE TABLE IF NOT EXISTS ingest_mail (id INTEGER PRIMARY KEY, entry_id TEXT NOT NULL UNIQUE, internet_message_id TEXT, store TEXT, folder TEXT, at TEXT, size INTEGER, email_id INTEGER, backfill TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_ingest_msgid ON ingest_mail(internet_message_id);
    CREATE TABLE IF NOT EXISTS ingest_calendar_log (id INTEGER PRIMARY KEY, at TEXT NOT NULL, received INTEGER NOT NULL, upserted INTEGER NOT NULL, deleted INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS live_urgent (task_id INTEGER NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (task_id, reason));`);
  for (const [c, d] of [['source', 'TEXT'], ['ol_key', 'TEXT'], ['ol_entry_id', 'TEXT'], ['ol_gid', 'TEXT'], ['organizer', 'TEXT'], ['attendees', 'TEXT'], ['response_status', 'TEXT'], ['is_recurring', 'INTEGER NOT NULL DEFAULT 0'], ['occurrence', 'TEXT'], ['ol_modified', 'TEXT']]) add('calendar_items', c, d);
  add('ingest_mail', 'reingested_at', 'TEXT'); add('ingest_mail', 'garbled_before', 'INTEGER');
  add('ingest_mail', 'gone_at', 'TEXT'); add('ingest_mail', 'trash_id', 'INTEGER'); add('ingest_mail', 'presence_keep', 'INTEGER NOT NULL DEFAULT 0'); // mail deleted in Outlook (lib/presence.js): moved to the recycle bin
  db.exec('CREATE INDEX IF NOT EXISTS idx_ingest_email ON ingest_mail(email_id)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_cal_olkey ON calendar_items(ol_key) WHERE ol_key IS NOT NULL');
  add('chat_messages', 'scope', 'TEXT'); add('chat_messages', 'scope_ref', 'TEXT'); add('claude_runs', 'pinned_ref', 'TEXT'); add('chat_messages', 'in_main', 'INTEGER'); add('claude_runs', 'pinned_task_id', 'INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_chat_task ON chat_messages(task_id)');
  add('chat_messages', 'import_id', 'INTEGER'); add('claude_runs', 'import_id', 'INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_emails_msgid ON emails(msgid); CREATE INDEX IF NOT EXISTS idx_emails_import ON emails(import_id);');
  db.exec(`CREATE TABLE IF NOT EXISTS run_usage (id INTEGER PRIMARY KEY, run_id INTEGER, at TEXT NOT NULL, job TEXT NOT NULL, adapter TEXT, model TEXT, effort TEXT,
      duration_ms INTEGER, turns INTEGER, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost_usd REAL, error TEXT, rate_limited INTEGER NOT NULL DEFAULT 0, import_id INTEGER);
    CREATE INDEX IF NOT EXISTS idx_usage_at ON run_usage(at);
    CREATE TABLE IF NOT EXISTS usage_events (id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, job TEXT, message TEXT, resume_at TEXT);`);
  for (const c of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']) add('claude_runs', c, 'INTEGER');
  add('claude_runs', 'cost_usd', 'REAL');
  add('files', 'facts_checked', 'INTEGER NOT NULL DEFAULT 0');
  add('events', 'run_id', 'INTEGER');
  add('events', 'meta', 'TEXT');
  add('events', 'undone_at', 'TEXT');
  add('events', 'undone_by', 'INTEGER');
  add('claude_runs', 'required_tasks', 'TEXT');
  add('claude_runs', 'retries', 'INTEGER');
  db.exec(`CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY, run_id INTEGER, task_id INTEGER NOT NULL, action TEXT NOT NULL CHECK (action IN ('close','advance','update','no_change')),
    reason TEXT NOT NULL, email_id INTEGER, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_decisions_run ON decisions(run_id);`);
  add('claude_runs', 'duration_ms', 'INTEGER');
  add('claude_runs', 'num_turns', 'INTEGER');
  add('claude_runs', 'chat_reply_ms', 'INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id)');
  // ARCHIVE of old Outlook mail (lib/archive.js, docs/OUTLOOK-INGEST.md): searchable and askable, but never processed by the assistant. Own search index, own embeddings (flag), own queue.
  add('emails', 'archived', 'INTEGER NOT NULL DEFAULT 0'); add('emails', 'text_only', 'INTEGER NOT NULL DEFAULT 0');
  add('files', 'archived', 'INTEGER NOT NULL DEFAULT 0'); add('files', 'discarded', 'INTEGER NOT NULL DEFAULT 0'); add('chunks', 'archived', 'INTEGER NOT NULL DEFAULT 0');
  add('ingest_mail', 'archive', 'INTEGER NOT NULL DEFAULT 0');
  // the "דואר" tab (lib/maillist.js): newest first by keyset on the mail date, and a conversation's newest mail; covering indexes, so the filters never read the (large) bodies
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mail_date ON emails (COALESCE(forwarded_date, received_at) DESC, id DESC, archived, direction, project_id, dup_of, import_state, thread_key, file_id, from_addr, to_addr, forwarded_from);
    CREATE INDEX IF NOT EXISTS idx_mail_thread ON emails (thread_key, COALESCE(forwarded_date, received_at) DESC, id DESC, archived, direction, project_id, dup_of, import_state);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_emails_archived ON emails(archived) WHERE archived = 1;
    CREATE INDEX IF NOT EXISTS idx_emails_threadkey ON emails(thread_key);
    CREATE INDEX IF NOT EXISTS idx_files_archived ON files(archived) WHERE archived = 1;
    CREATE INDEX IF NOT EXISTS idx_files_email ON files(email_id);
    CREATE TABLE IF NOT EXISTS archive_queue (id INTEGER PRIMARY KEY, entry_id TEXT NOT NULL UNIQUE, internet_message_id TEXT, folder TEXT, at TEXT, size INTEGER NOT NULL DEFAULT 0, path TEXT, backfill TEXT,
      text_only INTEGER, state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, error TEXT, email_id INTEGER, created_at TEXT NOT NULL, started_at TEXT, stored_at TEXT, finished_at TEXT);
    CREATE INDEX IF NOT EXISTS idx_aq_state ON archive_queue(state, id);
    CREATE TABLE IF NOT EXISTS archive_contacts (email TEXT PRIMARY KEY, name TEXT, person_id INTEGER, first_at TEXT, last_at TEXT, n_received INTEGER NOT NULL DEFAULT 0, n_sent INTEGER NOT NULL DEFAULT 0);
    CREATE VIRTUAL TABLE IF NOT EXISTS search_archive USING fts5(title, body, kind UNINDEXED, ref_id UNINDEXED, project_id UNINDEXED, ts UNINDEXED, person, tokenize = 'trigram');`);
  // PROJECT PASSPORT + LATEST STATUS PER PROCESS (lib/profile.js): dated rows with a source and history (never deleted), newer wins, the owner's edit wins and is marked
  db.exec(`CREATE TABLE IF NOT EXISTS project_profile (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, field TEXT NOT NULL, value TEXT NOT NULL,
      as_of_date TEXT NOT NULL, source_type TEXT NOT NULL CHECK (source_type IN ('email','file','protocol','chat','manual')), source_id INTEGER, by_owner INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER, created_at TEXT NOT NULL, superseded_by INTEGER);
    CREATE INDEX IF NOT EXISTS idx_profile_project ON project_profile(project_id, field);
    CREATE TABLE IF NOT EXISTS project_status (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, process TEXT NOT NULL CHECK (process IN ('design','permit','construction','marketing')),
      value TEXT NOT NULL, as_of_date TEXT NOT NULL, source_type TEXT NOT NULL CHECK (source_type IN ('email','file','protocol','chat','manual')), source_id INTEGER, by_owner INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER, created_at TEXT NOT NULL, superseded_by INTEGER);
    CREATE INDEX IF NOT EXISTS idx_pstatus_project ON project_status(project_id, process);`);
  add('project_facts', 'topic', 'TEXT');
  // RECYCLE BIN (lib/trash.js): a snapshot of what was deleted; the purge date is deleted_at + the setting trash_days (computed, so a changed setting applies to all)
  db.exec(`CREATE TABLE IF NOT EXISTS trash (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, entity_id INTEGER, title TEXT NOT NULL DEFAULT '', snapshot TEXT NOT NULL,
      deleted_at TEXT NOT NULL, deleted_by INTEGER, events_upto INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS idx_trash_kind ON trash(kind, deleted_at);`);
  add('claude_runs', 'profile_checked', 'INTEGER');
  // WEB PUSH (lib/push.js): the owner's devices, and the queue every process can write to (the runner delivers it)
  db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (id INTEGER PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, last_ok_at TEXT, last_error TEXT, disabled_at TEXT, fails INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS push_queue (id INTEGER PRIMARY KEY, cat TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '/', tag TEXT NOT NULL,
      dedupe_key TEXT, ref TEXT, bypass_quiet INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, claimed_at TEXT, next_try_at TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      done_subs TEXT NOT NULL DEFAULT '[]', sent_at TEXT, dropped TEXT);
    CREATE INDEX IF NOT EXISTS idx_push_queue_pending ON push_queue(sent_at, dropped, id);
    CREATE INDEX IF NOT EXISTS idx_push_queue_dedupe ON push_queue(dedupe_key, created_at);`);
  const fresh = !db.prepare("SELECT 1 FROM sqlite_master WHERE name='search_index'").get();
  db.exec(FTS);
  // the live-index triggers know about archive mail (archived = 1 is skipped); databases created before that get them replaced once
  const trg = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='si_emails_ai'").get();
  if (!trg || !/archived/.test(trg.sql)) {
    db.exec('BEGIN IMMEDIATE');
    try { for (const n of ['si_emails_ai', 'si_emails_au', 'si_files_ai', 'si_files_au', 'si_chunks_ai']) db.exec(`DROP TRIGGER IF EXISTS ${n}`); db.exec(LIVE_INDEX_TRIGGERS); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  if (fresh) {
    // index rows that existed before the index did
    db.exec(`
      INSERT INTO search_index (title, body, kind, ref_id, project_id, ts, person)
        SELECT t.title, t.description, 'task', t.id, t.project_id, COALESCE(t.source_date, t.created_at),
          COALESCE((SELECT name_he FROM people WHERE id = t.requester_id), '') || ' ' || COALESCE((SELECT name_he FROM people WHERE id = t.assignee_id), '') FROM tasks t;
      INSERT INTO search_index (title, body, kind, ref_id, project_id, ts, person)
        SELECT '', n.text, 'note', n.id, COALESCE(n.project_id, (SELECT project_id FROM tasks WHERE id = n.task_id)), n.created_at, '' FROM notes n;
      INSERT INTO search_index (title, body, kind, ref_id, project_id, ts, person)
        SELECT COALESCE(subject,''), COALESCE(body_text,''), 'email', id, project_id, COALESCE(forwarded_date, received_at), COALESCE(forwarded_from, from_addr, '') FROM emails;
      INSERT INTO search_index (title, body, kind, ref_id, project_id, ts, person)
        SELECT '', text, 'chat', id, NULL, created_at, CASE author WHEN 'owner' THEN '${OWNER_LABEL}' ELSE '${ASSISTANT_LABEL}' END FROM chat_messages;
    `);
  }
}

// Many processes write to one SQLite file (site, runner, ingest listener, health, CLI calls). busy_timeout makes SQLite wait; on top of that every statement and every transaction
// is retried with backoff when SQLite still answers BUSY, so a critical write (chat reply, apply commit, outbox status, heartbeat) is never lost to a lock. Each BUSY is counted (db_lock_events) for the health check.
const isBusy = (e) => !!e && (e.code === 'SQLITE_BUSY' || e.code === 'SQLITE_BUSY_SNAPSHOT' || e.code === 'SQLITE_LOCKED' || /database (table )?is locked/i.test(String(e.message)));
const sleepMs = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no shared memory */ } };
function hardenBusy(db) {
  const rawPrepare = db.prepare.bind(db); const rawTx = db.transaction.bind(db);
  // the BUSY events are written AFTER the lock cleared (they cannot be written while it is held)
  const flush = (label, n) => { try { const ins = rawPrepare('INSERT INTO db_lock_events (at, label) VALUES (?,?)'); for (let i = 0; i < n; i++) ins.run(new Date().toISOString(), label); } catch { /* the log must never fail a write */ } };
  const retrying = (fn, label) => { let delay = 150, hits = 0; for (let i = 0; ; i++) { try { const r = fn(); if (hits) flush(label, hits); return r; } catch (e) { if (!isBusy(e) || i >= 5) { if (hits) { try { console.error(`db: ${label} still busy after ${hits} retries`); } catch { /* ignore */ } } throw e; } hits++; sleepMs(delay + Math.floor(Math.random() * 100)); delay = Math.min(delay * 2, 3000); } } };
  db.prepare = (sql) => { const st = rawPrepare(sql); for (const m of ['run', 'get', 'all']) { const f = st[m].bind(st); st[m] = (...a) => retrying(() => f(...a), m); } return st; };
  db.transaction = (fn) => { const t = rawTx(fn); const w = (...a) => retrying(() => t(...a), 'tx'); for (const k of ['deferred', 'immediate', 'exclusive']) w[k] = (...a) => retrying(() => t[k](...a), 'tx'); return w; };
  db.exec('CREATE TABLE IF NOT EXISTS db_lock_events (id INTEGER PRIMARY KEY, at TEXT NOT NULL, label TEXT)');
}

function open(file = DEFAULT_DB) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = openRaw(file);
  try { require('sqlite-vec').load(db); } catch { /* vector search is optional */ }
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 15000');
  db.pragma('synchronous = NORMAL');
  if (file !== ':memory:') db.pragma('cache_size = -131072'); // 128 MB of decrypted pages: vector search re-reads many pages, decrypting each time would make it 10x slower
  hardenBusy(db);
  db.exec(SCHEMA);
  // migrations are idempotent AND race-safe: a concurrent starter that loses a race simply runs them again (everything is IF NOT EXISTS / column checks)
  for (let i = 0; ; i++) { try { migrate(db); migrateStage2(db); seed(db); break; } catch (e) { if (i >= 3 || !migrationRace(e)) throw e; sleepMs(300 * (i + 1)); } }
  seed(db);
  db.prepare("UPDATE people SET name_en=? WHERE role='assistant' AND name_en IS NULL").run(require('./config').get().assistant.name_en);
    for (const [he, en] of seedNames()) {
    db.prepare('UPDATE people SET name_en=? WHERE name_he=? AND name_en IS NULL').run(en, he);
  }
  return db;
}

module.exports = { alterAdd, open, now, DEFAULT_DB, PROJECT_COLORS };
