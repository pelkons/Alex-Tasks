'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Fastify = require('fastify');
const { open } = require('./db');
const vault = require('./vault');
const auth = require('./auth');
const { createStore, HttpError } = require('./store');
const { createKnowledge } = require('./knowledge');
const { createChat } = require('./chat');
const { createSearch } = require('./search');
const { createUndo } = require('./undo');
const { createSemantic } = require('./semantic');
const { createTelegram } = require('./telegram');
const { createThreads } = require('./threads');
const { createApply } = require('./apply');
const { createProtocols } = require('./protocols');
const { createCalendar } = require('./calendar');
const { createNotify } = require('./notify');
const { createHousekeeping } = require('./housekeeping');
const { createWatchdog } = require('./watchdog');
const { createEntities } = require('./entities');
const { createGate } = require('./gate');
const { createTrace } = require('./trace');
const { createAsk } = require('./ask');
const { createUploads } = require('./uploads');
const agents = require('./agents');

const PUBLIC = path.join(__dirname, '..', 'public');
const ENV_FILE = process.env.MESIMOT_ENV_FILE || path.join(os.homedir(), '.config', 'mesimot', 'env');

function readEnvFile(file = ENV_FILE) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* missing file */ }
  return out;
}

const he = {
  needLogin: 'יש להתחבר כדי להמשיך',
  notFound: 'הדף לא נמצא',
  server: 'אירעה שגיאה. נסו שוב',
  wrongPassword: 'הסיסמה שגויה',
  noPassword: 'לא הוגדרה סיסמה לאתר',
  locked: (m) => `יותר מדי ניסיונות כושלים. נסו שוב בעוד ${m} דקות`,
  badRequest: 'הבקשה אינה תקינה',
};

function build(opts = {}) {
  let { db, dbPath, token, loginDelayMs = 400 } = opts;
  db = db || open(dbPath);
  token = token ?? process.env.MESIMOT_TOKEN ?? readEnvFile().MESIMOT_TOKEN ?? '';
  const store = createStore(db);
  const knowledge = createKnowledge(db, store);
  const chat = createChat(db, store, knowledge);
  const undoForChat = createUndo(db, store, knowledge);
  const chatEdit = require('./chatedit').createChatEdit({ db, store, chat, undo: undoForChat, tgDelete: require('./telegram').deleter(db) });
  const importer = require('./importer').createImporter({ db, store, knowledge, chat });
  store.hooks.importIntake = importer.intake; store.hooks.importProgress = importer.progress;
  const searcher = createSearch(db);
  const threads = createThreads(db, store, knowledge);
  const calendar = createCalendar(db, store);
  const notify = createNotify(db, store, { sendEmail: async () => { throw new Error('mail is sent by the runner'); } });
  store.hooks.attention = notify.onAttention; // the runner sends the queued mail
  const protocols = createProtocols(db, store, knowledge, calendar);
  const entities = createEntities(db, store);
  const gate = createGate({ db, store, knowledge, entities });
  const trace = createTrace(db);
  const usageApi = require('./usage').createUsage(db);
  const applier = createApply(db, store, knowledge, chat, protocols, calendar, entities);
  const undo = createUndo(db, store, knowledge);
  const uploads = createUploads(db, store, knowledge, { dir: process.env.MESIMOT_UPLOADS, root: require('path').join(__dirname, '..') });
  const semantic = createSemantic(db, { embedder: opts.embedder });
  const asker = createAsk({ db, store, knowledge, searcher, semantic, trace });
  const app = Fastify({ logger: process.env.MESIMOT_LOG ? { level: 'info' } : false, bodyLimit: 1024 * 1024 });
  app.register(require('@fastify/cookie'));
  app.register(require('@fastify/multipart'), { limits: { fileSize: 50 * 1024 * 1024, files: 10 }, defParamCharset: 'utf8' });

  const clientOf = (req) => req.headers['cf-connecting-ip'] || req.ip;

  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cache-Control', 'no-transform'); // Cloudflare must not rewrite what we send (e-mail obfuscation turned addresses into "[email protected]"); routes that set their own Cache-Control add no-transform too
    reply.header('Referrer-Policy', 'same-origin');
    const url = req.url.split('?')[0];
    const isApi = url.startsWith('/api/');
    const open = url === '/login' || url === '/api/login' || url === '/healthz' || url === '/sw.js'
      || url === '/manifest.webmanifest' || url === '/' || url === '/robots.txt' || url.startsWith('/assets/') || url.startsWith('/cal/');
    req.actor = null;
    // token auth: the CLI, acts as the assistant
    const h = req.headers.authorization;
    if (h && token && h.startsWith('Bearer ') && auth.eq(h.slice(7), token)) req.actor = store.assistantId();
    else if (req.cookies[auth.COOKIE] && auth.readSession(db, req.cookies[auth.COOKIE])) {
      req.actor = store.ownerId();
      req.viaCookie = true;
      if (isApi && !['GET', 'HEAD'].includes(req.method) && req.headers['x-mesimot'] !== '1') {
        return reply.code(403).send({ error: he.badRequest });
      }
    }
    if (open || req.actor) return;
    if (isApi) return reply.code(401).send({ error: he.needLogin });
    // after signing in, the login page returns to the page that was asked for (a notification's link, a bookmark)
    return reply.redirect(req.method === 'GET' && /^\/[\w\-/]*$/.test(url) && url.length < 200 ? `/login?next=${encodeURIComponent(url)}` : '/login');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ ...(err.extra || {}), error: err.message });
    if (err.validation || err.statusCode === 400 || err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || err.statusCode === 415) {
      return reply.code(400).send({ error: he.badRequest });
    }
    if (err.code && String(err.code).startsWith('SQLITE_')) req.log.error(err);
    else req.log.error(err);
    return reply.code(500).send({ error: he.server });
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: he.notFound });
    return reply.code(404).type('text/plain; charset=utf-8').send(he.notFound);
  });

  // ---- static + pages
  app.register(require('@fastify/static'), { root: path.join(PUBLIC, 'assets'), prefix: '/assets/', maxAge: 0 });

  // Cache busting: Cloudflare gives static files a 4h browser TTL, so every app asset URL in index.html carries a
  // content version (?v=...), recomputed when the files change. New deploys are picked up on the next page load.
  const crypto = require('crypto');
  let indexCache = { key: '', html: '' };
  function indexHtml() {
    const files = ['app.css', 'app.js', 'layout.js', 'sha256.js', 'push.js'].map((f) => path.join(PUBLIC, 'assets', f));
    const key = [path.join(PUBLIC, 'index.html'), ...files].map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join('|');
    if (indexCache.key === key) return indexCache.html;
    const ver = crypto.createHash('sha1').update(files.map((f) => { try { return fs.readFileSync(f); } catch { return ''; } }).join('')).digest('hex').slice(0, 10);
    const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace(/(\/assets\/(?:app\.css|app\.js|layout\.js|sha256\.js|push\.js))(?=["'])/g, `$1?v=${ver}`);
    indexCache = { key, html };
    return html;
  }

  const sendFile = (name, type) => (req, reply) => reply.type(type).send(fs.readFileSync(path.join(PUBLIC, name)));
  app.get('/login', async (req, reply) => {
    if (req.actor) { const n = String((req.query || {}).next || '/'); return reply.redirect(/^\/(?![/\\])[\w\-/]*$/.test(n) ? n : '/'); }
    return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(fs.readFileSync(path.join(PUBLIC, 'login.html')));
  });
  // `/`: the app for a signed-in owner, a static public landing page (no personal data, no trackers) for everyone else
  app.get('/', async (req, reply) => {
    if (req.actor) return reply.type('text/html; charset=utf-8').header('Vary', 'Cookie').header('Cache-Control', 'no-cache').send(indexHtml());
    return reply.type('text/html; charset=utf-8').header('Vary', 'Cookie').header('Cache-Control', 'public, max-age=300').send(fs.readFileSync(path.join(PUBLIC, 'landing.html')));
  });
  app.get('/robots.txt', async (req, reply) => reply.type('text/plain; charset=utf-8').header('Cache-Control', 'public, max-age=3600').send('User-agent: *\nAllow: /$\nDisallow: /\nDisallow: /api\nDisallow: /cal\nDisallow: /login\nDisallow: /files\n'));
  const page = async (req, reply) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(indexHtml());
  for (const r of ['/chat', '/search', '/archive', '/projects', '/projects/:id', '/people', '/activity', '/protocols', '/protocols/:id', '/calendar', '/settings', '/trash', '/task/:id', '/email/:id', '/mail']) app.get(r, page);
  app.get('/sw.js', async (req, reply) => reply.type('text/javascript; charset=utf-8').header('Cache-Control', 'no-cache').header('Service-Worker-Allowed', '/').send(fs.readFileSync(path.join(PUBLIC, 'sw.js'))));
  app.get('/manifest.webmanifest', sendFile('manifest.webmanifest', 'application/manifest+json; charset=utf-8'));
  app.get('/healthz', async () => ({ ok: true }));

  // ---- auth
  app.post('/api/login', async (req, reply) => {
    const client = clientOf(req);
    const left = auth.lockedFor(client);
    if (left) return reply.code(429).send({ error: he.locked(Math.ceil(left / 60000)) });
    if (!auth.getAuth(db)) return reply.code(503).send({ error: he.noPassword });
    const ok = auth.checkPassword(db, req.body?.password, client);
    if (!ok) {
      if (loginDelayMs) await new Promise((r) => setTimeout(r, loginDelayMs));
      const l2 = auth.lockedFor(client);
      if (l2) return reply.code(429).send({ error: he.locked(Math.ceil(l2 / 60000)) });
      return reply.code(401).send({ error: he.wrongPassword });
    }
    reply.setCookie(auth.COOKIE, auth.makeSession(db), {
      httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: auth.SESSION_DAYS * 86400,
    });
    return { ok: true };
  });
  app.post('/api/logout', async (req, reply) => {
    reply.clearCookie(auth.COOKIE, { path: '/' });
    return { ok: true };
  });

  // ---- api
  const A = (fn) => async (req, reply) => fn(req, reply);
  const mailview = require('./mailview').createMailView(db);
  // an email for the screens: the real attachments only (the pictures that sit inside the body are not attachments), and whether the original HTML view exists
  async function emailForView(id) {
    const e = knowledge.emailShow(id); await mailview.ensure(id); const names = mailview.inlineNames(id); const hide = (n) => names.has(n);
    return { ...e, ...mailview.info(id), attachments: e.attachments.filter((a) => !hide(a.filename)), files: e.files.filter((f) => f.id !== e.file_id && !(hide(f.original_name) && /^image\//i.test(f.mime || ''))) };
  }
  const num = (v) => { const n = +v; if (!Number.isInteger(n) || n < 1) throw new HttpError(404, 'הפריט לא נמצא'); return n; };

  app.get('/api/me', A((req) => ({ actor_id: req.actor, via: req.viaCookie ? 'web' : 'token' })));
  app.get('/api/bootstrap', A(() => ({ ...store.lookups(), archive_total: db.prepare('SELECT COUNT(*) n FROM tasks t JOIN statuses s ON s.id=t.status_id WHERE s.is_closed=1').get().n, trash_total: db.prepare('SELECT COUNT(*) n FROM trash').get().n, trash_days: trash.days(), urls: { main: require('./config').get().site_url, mirror: require('./config').get().mirror_url } })));

  app.get('/api/tasks', A((req) => store.listTasks(req.query)));
  app.post('/api/tasks', A((req, reply) => reply.code(201).send(store.createTask(req.actor, req.body || {}))));
  app.get('/api/tasks/:id', A(async (req) => {
    const d = store.taskDetail(num(req.params.id));
    d.correspondence = threads.taskCorrespondence(d.id);
    d.thread = chat.taskThread(d.id);
    d.protocol = protocols.forTask(d.id);
    d.feedback_given = !!db.prepare("SELECT 1 FROM feedback WHERE item_type='task' AND item_id=? LIMIT 1").get(d.id); // the 👍/👎 question is asked once
    if (d.source_email_id) { const e = await emailForView(d.source_email_id); d.email = { has_html: e.has_html, remote_images: e.remote_images, id: e.id, subject: e.subject, original_subject: e.original_subject, from: e.forwarded_from, date: e.forwarded_date, received_at: e.received_at, body: e.body_text, body_clean: require('./textclean').readable(e.body_text), attachments: e.attachments, thread: e.thread, participants: e.participants, people: e.people }; }
    return d;
  }));
  app.patch('/api/tasks/:id', A((req) => store.updateTask(req.actor, num(req.params.id), req.body || {})));
  app.post('/api/tasks/:id/notes', A((req, reply) => reply.code(201).send(store.addNote(req.actor, { ...(req.body || {}), task: num(req.params.id) }))));
  app.post('/api/tasks/:id/drafts', A((req, reply) => reply.code(201).send(store.addDraft(req.actor, num(req.params.id), req.body?.text, { long: !!req.body?.long }))));
  app.post('/api/notes', A((req, reply) => reply.code(201).send(store.addNote(req.actor, req.body || {}))));

  app.get('/api/projects', A(() => store.listProjects()));
  // the owner creates directly; the assistant's request becomes a question to the owner (lib/projectask.js), answered 202 pending_approval
  app.post('/api/projects', A((req, reply) => {
    if (req.actor !== store.assistantId()) return reply.code(201).send(store.createProject(req.actor, req.body || {}));
    const b = req.body || {}; const r = proposals.projectAsk().propose(req.actor, { name: b.name ?? b.name_he, aliases: b.aliases, description: b.description, from: b.from ?? b.source });
    return reply.code(r.status === 'pending_approval' ? 202 : 200).send(r);
  }));
  app.post('/api/projects/propose', A((req, reply) => { const b = req.body || {}; const r = proposals.projectAsk().propose(req.actor, b); return reply.code(r.status === 'pending_approval' ? 202 : 200).send(r); }));
  app.get('/api/project-proposals', A((req) => ({ proposals: proposals.projectAsk().list(req.query.status), rejected: proposals.projectAsk().rejectedNames() })));
  app.patch('/api/projects/:id', A((req) => store.updateProject(req.actor, req.params.id, req.body || {})));
  app.post('/api/projects/:id/merge', A((req) => entities.resolveProject(req.actor, req.params.id, { into: req.body?.into })));
  app.post('/api/projects/:id/resolve', A((req) => entities.resolveProject(req.actor, req.params.id, req.body || {})));

  app.get('/api/people', A(() => store.listPeople()));
  app.post('/api/people', A((req, reply) => reply.code(201).send(store.createPerson(req.actor, req.body || {}))));
  app.post('/api/people/:id/merge', A((req) => entities.resolvePerson(req.actor, req.params.id, { into: req.body?.into }).person));
  app.post('/api/people/:id/resolve', A((req) => entities.resolvePerson(req.actor, req.params.id, req.body || {})));
  // created / last updated, shown in small muted text at the bottom of every entity page (the full event log stays for the activity screen and undo)
  const stamps = (entity, table, id) => { const created = db.prepare(`SELECT created_at FROM ${table} WHERE id=?`).get(id)?.created_at || null; return { created_at: created, updated_at: db.prepare("SELECT MAX(created_at) m FROM events WHERE entity=? AND entity_id=? AND action<>'undo'").get(entity, id).m || created }; };
  app.get('/api/people/:id', A((req) => { const id = store.findPerson(req.params.id).id; return { ...entities.personCard(id), stamps: stamps('person', 'people', id) }; }));
  app.patch('/api/people/:id', A((req) => store.updatePerson(req.actor, req.params.id, req.body || {})));

  app.get('/api/attention', A((req) => store.listAttention(req.query.status)));
  app.post('/api/attention', A((req, reply) => reply.code(201).send(store.addAttention(req.actor, req.body || {}))));
  app.patch('/api/attention/:id', A((req) => store.updateAttention(req.actor, num(req.params.id), req.body || {})));

  // chat and status
  const mailFilters = require('./filters').createFilters({ db, store });
  app.get('/api/filters', A(() => mailFilters.list()));
  app.post('/api/filters', A((req, reply) => { ownerOnly0(req); return reply.code(201).send(mailFilters.add(req.actor, req.body || {})); }));
  app.post('/api/filters/preview', A((req) => mailFilters.preview(req.body || {}, +(req.body || {}).days || 30)));
  app.patch('/api/filters/:id', A((req) => mailFilters.update(req.actor, num(req.params.id), req.body || {})));
  app.delete('/api/filters/:id', A((req) => mailFilters.remove(req.actor, num(req.params.id))));
  const trash = require('./trash').createTrash({ db, store });
  const taskdel = require('./taskdel').createTaskDelete({ db, store, trash });
  const confirmations = require('./confirm').createConfirm({ db, store, chat, taskdel, trash, purge: require('./purge').createPurge({ db, store, trash }) });
  store.hooks.confirmView = confirmations.get;
  // deleting = moving to the recycle bin: the owner's own action in the web app, or the assistant asking for a confirmation that only the owner can answer
  app.delete('/api/tasks/:id', A((req) => { if (!req.viaCookie) throw new HttpError(403, 'מחיקה דורשת אישור של הבעלים: יש להשתמש ב-mesimot confirm task-delete'); return taskdel.purge(req.actor, num(req.params.id)); }));
  app.post('/api/purge/undo', A((req) => { ownerOnly(req); return taskdel.restore(req.actor, String((req.body || {}).token || '')); }));
  // the recycle bin: listing and restoring are free (the owner and the assistant); PERMANENT deletion only by the owner in the web app or through his confirmation
  app.get('/api/trash', A((req) => trash.list(req.query)));
  app.post('/api/trash/:id/restore', A((req) => trash.restore(req.actor, num(req.params.id))));
  app.delete('/api/trash/:id', A((req) => { if (!req.viaCookie) throw new HttpError(403, 'מחיקה סופית דורשת אישור של הבעלים: יש להשתמש ב-mesimot trash delete'); return trash.destroy(req.actor, num(req.params.id)); }));
  app.post('/api/trash/empty', A((req) => { if (!req.viaCookie) throw new HttpError(403, 'ריקון הסל דורש אישור של הבעלים: יש להשתמש ב-mesimot trash empty'); return trash.empty(req.actor); }));
  app.post('/api/confirm', A((req) => { const b = req.body || {}; const kind = String(b.kind || ''); const tid = kind === 'project_delete' ? store.findProject(b.id).id : kind === 'person_delete' ? store.findPerson(b.id).id : kind === 'trash_empty' ? 0 : num(b.id); return confirmations.ask(req.actor, kind, tid, b); }));
  app.post('/api/confirm/:id/answer', A((req) => { ownerOnly(req); return confirmations.answer(req.actor, num(req.params.id), !!(req.body || {}).yes); }));
  const proposals = require('./proposals').createProposals({ db, store, chat });
  store.hooks.pendingProject = proposals.projectAsk().pendingByName;
  const feedback = require('./feedback').createFeedback({ db, store, proposals });
  app.post('/api/feedback', A((req, reply) => reply.code(201).send(feedback.record(req.actor, req.body || {}))));
  app.get('/api/feedback/stats', A((req) => ({ ...feedback.stats(Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365)), reasons_list: feedback.REASONS })));
  app.post('/api/tasks/:id/fix', A((req) => { const b = req.body || {}; const msg = feedback.fix(req.actor, num(req.params.id), b.kind, b.value); if (b.feedback_id) feedback.fixNote(+b.feedback_id, b.kind); return { ok: true, message: msg }; }));
  app.get('/api/proposals/:batch', A((req) => proposals.batch(num(req.params.batch))));
  app.post('/api/proposals/item/:id', A((req) => { ownerOnly(req); const r = proposals.decide(num(req.params.id), (req.body || {}).action === 'reject' ? 'reject' : 'approve', { project: (req.body || {}).project }); return r; }));
  app.post('/api/proposals/:batch/approve', A((req) => { ownerOnly(req); const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(Number) : null; proposals.approveBatch(num(req.params.batch), ids); return proposals.batch(num(req.params.batch)); }));
  app.patch('/api/chat/:id', A((req) => { ownerOnly(req); return chatEdit.edit(req.actor, num(req.params.id), (req.body || {}).text); }));
  app.delete('/api/chat/:id', A((req) => { ownerOnly(req); return chatEdit.remove(req.actor, num(req.params.id), { undoActions: req.query.undo === '1' }); }));
  app.get('/api/chat', A((req) => { if (!req.viaCookie) trace.log('chat_list', JSON.stringify(req.query)); return chat.listChat(req.query); }));
  app.get('/api/chat/scope/:type/:id', A((req) => chat.scopeThread(`${req.params.type}:${req.params.id}`)));
  app.post('/api/chat', A((req, reply) => reply.code(201).send(chat.sendChat(req.actor, req.body || {}, req.viaCookie ? null : { agent: true }))));
  app.get('/api/status', A(() => chat.status()));
  app.post('/api/run-summary', A((req) => chat.setRunSummary(req.body?.text)));
  app.get('/api/runs', A((req) => chat.listRuns(Math.min(+req.query.limit || 30, 200))));

  app.post('/api/apply', A((req) => { if (req.viaCookie) throw new HttpError(403, 'הפעולה זמינה רק לעוזר'); return applier.apply(req.actor, req.body, { dry: req.query.dry === '1' }); }));

  // calendar: the screen and items need a login; the .ics feed is public behind its secret token
  app.get('/cal/:file', async (req, reply) => {
    const m = /^([\w-]+)\.ics$/.exec(req.params.file);
    if (!m || !calendar.tokenOk(m[1])) return reply.code(404).type('text/plain; charset=utf-8').send('לא נמצא');
    const only = ['tasks', 'meetings'].includes(req.query.only) ? req.query.only : null;
    return reply.type('text/calendar; charset=utf-8').header('Cache-Control', 'private, max-age=300').send(calendar.ics(only));
  });
  app.get('/api/calendar', A((req) => calendar.range(req.query.from || '0000-01-01', req.query.to || '9999-12-31', req.query.q || '')));
  app.get('/api/calendar/info', A(() => ({ ...calendar.token(false) })));
  app.post('/api/calendar/token', A((req) => { if (!req.viaCookie && !req.actor) throw new HttpError(403, 'אין הרשאה'); return calendar.token(true); }));
  app.post('/api/calendar/items', A((req, reply) => reply.code(201).send(calendar.addItem(req.actor, req.body || {}))));
  app.patch('/api/calendar/items/:id', A((req) => calendar.updateItem(req.actor, num(req.params.id), req.body || {})));
  app.delete('/api/calendar/items/:id', A((req) => calendar.deleteItem(req.actor, num(req.params.id))));

  const tgToken = () => process.env.TELEGRAM_BOT_TOKEN || readEnvFile().TELEGRAM_BOT_TOKEN || '';
  const tgSetting = (k) => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value ?? null;
  // settings
  app.get('/api/settings', A(() => ({
    ...notify.settings(),
    agent: agents.describe(db),
    urls: { main: require('./config').get().site_url, mirror: require('./config').get().mirror_url },
    daily_budget_usd: +(db.prepare("SELECT value FROM settings WHERE key='daily_budget_usd'").get()?.value || 0), spent_today_usd: +usageApi.todaySpend().toFixed(2),
    links_use_mirror: db.prepare("SELECT value FROM settings WHERE key='links_use_mirror'").get()?.value === '1',
    max_file_mb: Math.round(knowledge.maxFileBytes() / 1048576),
    telegram_max_mb: (process.env.TELEGRAM_API_BASE || readEnvFile().TELEGRAM_API_BASE) ? 2000 : 20,
    mailbox_keep_days: parseInt(db.prepare("SELECT value FROM settings WHERE key='mailbox_keep_days'").get()?.value || '30', 10),
    trash_days: trash.days(),
    email_allowlist: JSON.parse(db.prepare("SELECT value FROM settings WHERE key='email_allowlist'").get()?.value || '[]'),
    calendar_url: calendar.token(false).url,
    telegram: { configured: !!tgToken(), bound: !!tgSetting('telegram_chat_id') },
    statuses: db.prepare('SELECT id, name_he, color, is_done, is_closed, hidden_default FROM statuses ORDER BY sort').all(),
    priorities: db.prepare('SELECT id, name_he, color FROM priorities ORDER BY sort').all(),
  })));
  app.patch('/api/settings', A((req) => {
    const b = req.body || {};
    if (b.email_allowlist !== undefined) {
      const list = [...new Set((Array.isArray(b.email_allowlist) ? b.email_allowlist : String(b.email_allowlist).split(/[\s,;]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
      if (list.some((x) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x))) throw new HttpError(400, 'כתובת דוא״ל לא תקינה ברשימה');
      if (!list.length) throw new HttpError(400, 'הרשימה חייבת להכיל לפחות כתובת אחת');
      db.prepare("INSERT INTO settings (key,value) VALUES ('email_allowlist',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(list));
    }
    if (b.agent_provider !== undefined) {
      if (b.agent_provider !== '' && !agents.NAMES.includes(b.agent_provider)) throw new HttpError(400, 'סוכן לא מוכר. האפשרויות: ' + agents.NAMES.join(', '));
      db.prepare("INSERT INTO settings (key,value) VALUES ('agent_provider',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(b.agent_provider);
    }
    if (b.daily_budget_usd !== undefined) { const v = Math.max(0, +b.daily_budget_usd || 0); db.prepare("INSERT INTO settings (key,value) VALUES ('daily_budget_usd',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(v)); }
    if (b.links_use_mirror !== undefined) db.prepare("INSERT INTO settings (key,value) VALUES ('links_use_mirror',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(b.links_use_mirror ? '1' : '0');
    if (b.agent_models !== undefined) {
      const c = agents.configured(db);
      require('./agents/models').saveOverrides(db, c.name, b.agent_models || {});
    }
    if (b.agent_model !== undefined) db.prepare("INSERT INTO settings (key,value) VALUES ('agent_model',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(b.agent_model).trim().slice(0, 80));
    if (b.max_file_mb !== undefined) {
      const n = parseInt(b.max_file_mb, 10);
      if (!(n >= 1 && n <= 4096)) throw new HttpError(400, 'הגודל המרבי לקובץ חייב להיות בין 1 ל־4096 מגה־בייט');
      db.prepare("INSERT INTO settings (key,value) VALUES ('max_file_mb',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(n));
    }
    if (b.mailbox_keep_days !== undefined) {
      const n = parseInt(b.mailbox_keep_days, 10);
      if (!(n >= 1 && n <= 3650)) throw new HttpError(400, 'מספר הימים חייב להיות בין 1 ל־3650');
      db.prepare("INSERT INTO settings (key,value) VALUES ('mailbox_keep_days',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(n));
    }
    if (b.trash_days !== undefined) trash.setDays(b.trash_days);
    try { notify.saveSettings(b); } catch { throw new HttpError(400, 'שעה לא תקינה. הפורמט: 22:00'); }
    return { ok: true };
  }));
  // ---- web push to the installed web app (lib/push.js, docs/PUSH.md): the owner's browser session only
  const push = require('./push').createPush(db, { notify, sender: opts.pushSender || null, log: (...a) => app.log.info(a.join(' ')) }); // opts.pushSender: tests (never a real push service)
  const pushOwner = (req) => { if (!req.viaCookie) throw new HttpError(403, 'רק מהדפדפן של הבעלים'); };
  const pushErr = (fn) => A(async (req) => { pushOwner(req); try { return await fn(req); } catch (e) { if (e.status === 400) throw new HttpError(400, 'המנוי של הדפדפן אינו תקין'); throw e; } });
  app.get('/api/push/key', pushErr(() => ({ key: push.publicKey() })));
  app.get('/api/push/status', pushErr((req) => push.status(req.query.endpoint || null)));
  app.post('/api/push/subscribe', pushErr((req) => push.subscribe((req.body || {}).subscription || req.body, req.headers['user-agent'])));
  app.post('/api/push/unsubscribe', pushErr((req) => push.unsubscribe((req.body || {}).endpoint)));
  app.post('/api/push/test', pushErr(async () => { const r = await push.test(); if (!r.devices) throw new HttpError(400, 'אין מכשיר רשום להתראות'); return r; }));
  app.post('/api/push/settings', pushErr((req) => push.saveSettings(req.body || {})));
  app.post('/api/push/seen', pushErr(() => { push.seen(); return { ok: true }; })); // a visible page: Alex's chat replies are not pushed while the site is open
  const renamer = (table) => A((req) => {
    const id = num(req.params.id);
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    if (!row) throw new HttpError(404, 'הפריט לא נמצא');
    const name = String(req.body?.name_he ?? row.name_he).trim();
    if (!name) throw new HttpError(400, 'יש להזין שם');
    if (db.prepare(`SELECT 1 FROM ${table} WHERE name_he=? AND id<>?`).get(name, id)) throw new HttpError(400, 'כבר קיים פריט בשם הזה');
    const color = req.body?.color !== undefined ? String(req.body.color) : row.color;
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new HttpError(400, 'צבע לא תקין');
    db.prepare(`UPDATE ${table} SET name_he=?, color=? WHERE id=?`).run(name, color, id);
    store.logEvent(req.actor, 'setting', id, 'update', table, row.name_he, name);
    return { ok: true };
  });
  let storageCache = null;
  app.get('/api/storage', A(() => { if (!storageCache || Date.now() - storageCache.t > 60000) storageCache = { t: Date.now(), v: createHousekeeping(db, store, { am: async () => ({}), base: '' }).storage() }; return storageCache.v; }));
  // system status card (read-only version of the watchdog's checks)
  let healthCache = null;
  app.get('/api/health', A(async () => {
    if (!healthCache || Date.now() - healthCache.t > 20000) {
      const comps = await createWatchdog(db, store).check();
      healthCache = { t: Date.now(), v: { checked_at: new Date().toISOString(), components: comps.map(({ id, label, ok, detail }) => ({ id, label, ok, detail })) } };
    }
    return healthCache.v;
  }));
  app.patch('/api/statuses/:id', renamer('statuses'));
  app.patch('/api/priorities/:id', renamer('priorities'));
  app.post('/api/password', A(async (req, reply) => {
    if (!req.viaCookie) throw new HttpError(403, 'שינוי סיסמה אפשרי רק מהאתר');
    const { old_password: oldP, new_password: newP } = req.body || {};
    const client = clientOf(req);
    if (auth.lockedFor(client)) throw new HttpError(429, 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות');
    if (!auth.checkPassword(db, oldP, client)) throw new HttpError(401, 'הסיסמה הנוכחית שגויה');
    if (typeof newP !== 'string' || newP.length < 12) throw new HttpError(400, 'הסיסמה החדשה חייבת להכיל לפחות 12 תווים');
    auth.setPassword(db, newP); // rotates the session secret: every other device is logged out
    reply.setCookie(auth.COOKIE, auth.makeSession(db), { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: auth.SESSION_DAYS * 86400 });
    return { ok: true };
  }));
  app.patch('/api/drafts/:id', A((req) => {
    const id = num(req.params.id);
    const st = req.body?.status;
    if (!['חדש', 'הועתק', 'בוטל'].includes(st)) throw new HttpError(400, 'סטטוס טיוטה לא תקין');
    const d = db.prepare('SELECT * FROM drafts WHERE id=?').get(id);
    if (!d) throw new HttpError(404, 'הטיוטה לא נמצאה');
    db.prepare('UPDATE drafts SET status=? WHERE id=?').run(st, id);
    store.logEvent(req.actor, 'task', d.task_id, 'draft_status', 'draft', d.status, st, { draft_id: id });
    return db.prepare('SELECT * FROM drafts WHERE id=?').get(id);
  }));

  // meeting minutes
  app.get('/api/protocols', A((req) => protocols.list(req.query)));
  app.post('/api/protocols', A((req, reply) => reply.code(201).send(protocols.addProtocol(req.actor, req.body || {}))));
  app.get('/api/protocols/:id', A((req) => ({ ...protocols.show(num(req.params.id)), stamps: stamps('protocol', 'protocols', num(req.params.id)) })));
  app.post('/api/protocols/:id/items', A((req, reply) => reply.code(201).send(protocols.addItem(req.actor, num(req.params.id), req.body || {}))));
  app.patch('/api/protocol-items/:id', A((req) => protocols.updateItem(req.actor, num(req.params.id), req.body || {})));
  app.post('/api/protocol-items/:id/promote', A((req) => protocols.promote(req.actor, num(req.params.id))));
  app.post('/api/protocol-items/:id/done', A((req) => protocols.done(req.actor, num(req.params.id))));
  app.post('/api/protocol-items/:id/dismiss', A((req) => protocols.dismiss(req.actor, num(req.params.id))));
  app.post('/api/protocols/promote', A((req) => protocols.promoteMany(req.actor, Array.isArray(req.body?.ids) ? req.body.ids : [])));

  // activity and undo (undo is a human action: it needs the owner's session)
  const ownerOnly0 = () => {}; // the CLI (the assistant, on the owner's request in the chat) may add rules too
  const ownerOnly = (req) => { if (!req.viaCookie) throw new HttpError(403, 'רק הבעלים יכול לבטל פעולות'); };
  app.get('/api/imports/:id', A((req) => importer.progress(num(req.params.id)) || (() => { throw new HttpError(404, 'הייבוא לא נמצא'); })()));
  app.get('/api/usage', A((req) => usageApi.summary({ days: Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90), by: req.query.by === 'model' ? 'model' : 'kind' })));
  app.get('/api/activity', A((req) => ({ ...undo.activity(req.query.limit), gate_stats: gate.stats(30), security: db.prepare("SELECT created_at, new_value FROM events WHERE entity='security' ORDER BY id DESC LIMIT 10").all(), outbox: store.hooks.outbox ? store.hooks.outbox.audit(40) : null })));
  app.post('/api/tasks/:id/reviewed', A((req) => { const t = store.getTask(+req.params.id); db.prepare('UPDATE tasks SET needs_review=0 WHERE id=?').run(t.id); store.logEvent(req.actor, 'task', t.id, 'update', 'needs_review', '1', '0'); return { ok: true }; }));
  app.post('/api/events/:id/undo', A((req) => { ownerOnly(req); return undo.undoEvent(req.actor, num(req.params.id)); }));
  app.post('/api/runs/:id/undo', A((req) => { ownerOnly(req); return undo.undoRun(req.actor, num(req.params.id)); }));

  // Telegram: binding the bot to the owner's chat (the bot itself runs inside the runner)
  app.get('/api/telegram/status', A(() => ({ configured: !!tgToken(), bound: !!tgSetting('telegram_chat_id') })));
  app.post('/api/telegram/bind', A(async () => {
    if (!tgToken()) throw new HttpError(400, 'לא הוגדר טוקן לבוט הטלגרם');
    const tg = createTelegram({ db, store, knowledge, chat, token: tgToken(), fetchImpl: opts.telegramFetch || fetch });
    let me;
    try { me = await tg.me(); } catch { throw new HttpError(400, 'הטוקן של בוט הטלגרם אינו תקין'); }
    const code = tg.createBindCode();
    return { code, bot: me.username, link: `https://t.me/${me.username}?start=${code}`, expires_in_minutes: 10 };
  }));
  app.post('/api/telegram/unbind', A((req) => {
    if (!req.viaCookie) throw new HttpError(403, 'רק הבעלים יכול לנתק את הטלגרם');
    db.prepare("DELETE FROM settings WHERE key IN ('telegram_chat_id','telegram_bind')").run();
    return { ok: true };
  }));

  // search, knowledge, files
  // current items by default; archive=1 adds closed (done / cancelled) tasks and their notes
  const closedTaskIds = () => new Set(db.prepare('SELECT t.id FROM tasks t JOIN statuses s ON s.id=t.status_id WHERE s.is_closed=1').all().map((r) => r.id));
  app.get('/api/search', A(async (req) => {
    if (!req.viaCookie) trace.log('search', req.query.q);
    const r = await searcher.searchHybrid(req.query, semantic);
    if (req.query.archive === '1') return r;
    const closed = closedTaskIds();
    const keep = r.results.filter((x) => !((x.kind === 'task' && closed.has(x.id)) || (x.kind === 'note' && x.task_id && closed.has(x.task_id)) || (x.kind === 'knowledge' && false)));
    return { ...r, results: keep, count: keep.length, archived_hidden: r.results.length - keep.length };
  }));
  app.get('/api/archive', A((req) => { const f = { ...req.query, closed: '1' }; const items = store.listTasks(f); const total = store.listTasks({ ...f, limit: 1000, offset: 0 }).length; return { items, total }; }));
  app.get('/api/ask', A((req) => asker.ask({ q: req.query.q, project: req.query.project || null, limit: req.query.limit, mail_archive: req.query.mail_archive })));
  app.get('/api/semantic/status', A(() => semantic.status()));
  app.get('/api/facts', A((req) => { if (!req.viaCookie) trace.log('fact_list', req.query.project || ''); return (req.query.key ? knowledge.factHistory(store.findProject(req.query.project).id, req.query.key) : knowledge.listFacts(req.query)); }));
  app.post('/api/facts', A((req, reply) => reply.code(201).send(knowledge.setFact(req.actor, { source: req.viaCookie ? 'manual' : undefined, ...(req.body || {}) }))));
  app.get('/api/knowledge', A((req) => knowledge.listKnowledge(req.query)));
  app.post('/api/knowledge', A((req, reply) => reply.code(201).send(knowledge.addKnowledge(req.actor, { source: req.viaCookie ? 'manual' : 'chat', ...(req.body || {}) }))));
  app.get('/api/knowledge/:id', A((req) => knowledge.getKnowledge(num(req.params.id))));
  app.patch('/api/knowledge/:id', A((req) => knowledge.updateKnowledge(req.actor, num(req.params.id), req.body || {})));
  app.post('/api/knowledge/:id/supersede', A((req) => knowledge.supersede(req.actor, num(req.params.id), req.body || {})));
  app.get('/api/projects/:id/show', A((req) => { if (!req.viaCookie) trace.log('project_show', req.params.id); return knowledge.projectShow(req.params.id); }));
  // the project passport and the latest status per process (lib/profile.js): the owner's edit on the site is marked and wins; the assistant must give a source and a date
  app.get('/api/projects/:id/profile', A((req) => { if (!req.viaCookie) trace.log('project_profile', req.params.id); return knowledge.profile.getProfile(req.params.id, { history: req.query.history === '1' }); }));
  app.get('/api/projects/:id/profile/history', A((req) => knowledge.profile.history(req.params.id, req.query.kind === 'status' ? 'status' : 'field', req.query.key)));
  app.post('/api/projects/:id/profile', A((req) => knowledge.profile.setProfile(req.actor, { ...(req.body || {}), project: req.params.id, ...(req.viaCookie ? { source: 'manual', as_of: req.body?.as_of } : {}) })));
  app.post('/api/projects/:id/status', A((req) => knowledge.profile.setStatus(req.actor, { ...(req.body || {}), project: req.params.id, ...(req.viaCookie ? { source: 'manual', as_of: req.body?.as_of } : {}) })));
  app.post('/api/facts/topic', A((req) => knowledge.profile.setFactTopic(req.actor, req.body || {})));
  app.get('/api/projects/:id/page', A((req) => { const pg = knowledge.projectPage(req.params.id); pg.protocols = protocols.forProject(pg.project.id); pg.stamps = stamps('project', 'projects', pg.project.id); return pg; }));
  app.get('/api/emails/:id', A((req) => { if (!req.viaCookie) trace.log('open_email', req.params.id); return emailForView(num(req.params.id)); }));
  // the original HTML of the email: sanitized, pictures from the message shown, outside pictures blocked unless ?remote=1; meant for a sandboxed iframe (no scripts)
  app.get('/api/emails/:id/view', async (req, reply) => {
    const v = await mailview.view(num(req.params.id), { remote: req.query.remote === '1' });
    if (!v) return reply.code(404).type('text/plain; charset=utf-8').send('אין תצוגה מקורית למייל הזה');
    return reply.header('Content-Security-Policy', v.csp).header('X-Frame-Options', 'SAMEORIGIN').header('Cache-Control', 'private, max-age=60, no-transform').type('text/html; charset=utf-8').send(v.page);
  });
  app.get('/api/emails/:id/thread', A((req) => threads.emailThread(num(req.params.id))));
  // the "דואר" tab: every email (live, forwarded, imported, archive; inbox and sent), newest first, keyset pagination, filters, hybrid search. Read-only; the owner's session or the API token.
  const maillist = require('./maillist').createMailList({ db, store, searcher, semantic });
  app.get('/api/mail', A((req) => { if (!req.viaCookie && req.query.q) trace.log('search', req.query.q); return maillist.list(req.query); }));
  app.get('/api/mail/people', A((req) => maillist.suggestPeople(req.query.q)));
  app.get('/api/mail/visit', A(() => maillist.visit({ touch: false })));
  app.post('/api/mail/visit', A((req) => maillist.visit({ touch: !!req.viaCookie })));   // only the owner's own visit moves the marker
  app.get('/api/mail/thread/:id', A((req) => maillist.thread(num(req.params.id), req.query)));
  app.get('/api/chunks/:id', A((req) => { if (!req.viaCookie) trace.log('open_chunk', req.params.id); return knowledge.getChunk(num(req.params.id)); }));
  app.get('/api/files', A((req) => knowledge.listFiles(req.query)));
  app.get('/api/files/:id', A((req) => knowledge.getFile(num(req.params.id))));
  app.get('/api/files/:id/show', A((req) => { if (!req.viaCookie) trace.log('open_file', req.params.id); return knowledge.showFile(num(req.params.id)); }));
  app.patch('/api/files/:id', A((req) => knowledge.classifyFile(req.actor, num(req.params.id), req.body || {})));
  app.get('/api/files/:id/download', async (req, reply) => {
    const f = knowledge.getFile(num(req.params.id));
    if (f.discarded) throw new HttpError(404, 'הקובץ נמצא רק ב-Outlook');
    if (!f.path || !fs.existsSync(f.path)) throw new HttpError(404, 'הקובץ לא נמצא');
    const safe = encodeURIComponent(f.original_name);
    const inline = req.query.inline === '1' && /^(image\/|application\/pdf|text\/plain)/.test(f.mime || '');
    return reply.type(f.mime || 'application/octet-stream').header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${safe}`).header('Content-Length', vault.plainSize(f.path)).send(vault.createReadStream(f.path));
  });
  // chunked, resumable uploads (see lib/uploads.js)
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 48 * 1024 * 1024 }, (req, body, done) => done(null, body));
  app.post('/api/uploads', A((req) => uploads.start(req.actor, req.body || {})));
  app.get('/api/uploads/:id', A((req) => uploads.status(req.params.id)));
  app.put('/api/uploads/:id/:index', { bodyLimit: 48 * 1024 * 1024 }, A((req) => uploads.putChunk(req.params.id, req.params.index, req.body, req.headers['x-chunk-sha256'])));
  app.post('/api/uploads/:id/complete', A(async (req, reply) => reply.code(201).send(await uploads.complete(req.actor, req.params.id, req.body?.sha256))));
  app.post('/api/files', async (req, reply) => {
    const out = [];
    const fields = {};
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer();
        if (part.file.truncated) throw new HttpError(400, 'הקובץ גדול מדי להעלאה בבקשה אחת. הדפדפן מעלה קבצים גדולים בחלקים');
        out.push({ name: part.filename, mime: part.mimetype, buffer });
      } else fields[part.fieldname] = part.value;
    }
    if (!out.length) throw new HttpError(400, 'לא נבחר קובץ');
    const saved = [];
    for (const f of out) saved.push(await knowledge.saveUpload(req.actor, { ...f, project: fields.project || undefined, task: fields.task || undefined, source: 'web' }));
    return reply.code(201).send(saved);
  });

  app.get('/api/pending', A(() => store.pending()));
  app.post('/api/ack', A((req) => store.ack(req.body?.ids)));
  app.get('/api/events', A((req) => {
    const lim = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    return db.prepare('SELECT e.*, p.name_he AS actor FROM events e LEFT JOIN people p ON p.id=e.actor_id ORDER BY e.id DESC LIMIT ?').all(lim);
  }));

  app.decorate('uploads', uploads);
  app.decorate('db', db);
  app.decorate('store', store);
  app.decorate('knowledge', knowledge);
  app.decorate('chat', chat);
  app.decorate('undo', undo);
  app.decorate('protocols', protocols);
  app.decorate('calendar', calendar);
  app.decorate('notify', notify);
  app.decorate('threads', threads);
  app.decorate('semantic', semantic);
  // live Outlook ingest: the storage side lives here; the listener is a separate instance on the Tailscale address only (bin/mesimot-server)
  const sysHealth = require('./health').createHealth(db, store);
  app.get('/api/system-health', A(() => ({ checks: sysHealth.status(), summary: sysHealth.summary() })));
  // outbound email: the owner's approval is the only way to send (lib/outbox.js). The approval route below accepts ONLY the owner's web session, never the assistant's token.
  const styles = require('./writingstyle').createStyles({ db, store }); try { styles.ensureSeed(); } catch (e) { console.warn('writing styles seed:', e.message); }
  store.hooks.styles = styles; app.styles = styles;
  const outbox = require('./outbox').createOutbox({ db, store, styles });
  store.hooks.outboxView = outbox.cardView; store.hooks.outbox = outbox; app.outbox = outbox;
  store.hooks.reply = require('./replyto').createReply({ db, store, chat, proposals, outbox }); // replies to cards (the owner's swipe-reply / web quote)
  if (!process.env.MESIMOT_NO_OUTBOX_KEY) { try { outbox.key(); } catch (e) { console.warn('outbox signing key not created:', e.message); } } // the file exists from the first start (mode 600, outside agent/ and files/)
  const ownerSession = (req) => { if (!req.viaCookie) throw new HttpError(403, 'אישור שליחה אפשרי רק מהאתר (או מהטלגרם של הבעלים), לא דרך העוזר'); };
  app.get('/api/outbox', A((req) => outbox.list({ status: req.query.status, limit: req.query.limit })));
  app.get('/api/outbox/settings', A(() => outbox.settings()));
  app.post('/api/outbox/settings', A((req) => { ownerSession(req); return outbox.setSettings(req.body || {}); }));
  app.get('/api/outbox/:id', A((req) => outbox.get(num(req.params.id))));
  app.post('/api/outbox', A((req, reply) => reply.code(201).send(outbox.create(req.actor, req.body || {}))));
  app.patch('/api/outbox/:id', A((req) => outbox.update(req.actor, num(req.params.id), req.body || {})));
  app.post('/api/outbox/:id/submit', A((req) => outbox.submit(req.actor, num(req.params.id))));
  app.post('/api/outbox/:id/resend', A((req) => outbox.resend(req.actor, num(req.params.id)))); // a NEW draft and a new card; never approved here
  app.post('/api/outbox/:id/cancel', A((req) => outbox.cancel(req.actor, num(req.params.id))));
  app.post('/api/outbox/:id/approve', A((req) => { ownerSession(req); return outbox.approve(req.actor, num(req.params.id), String((req.body || {}).hash || ''), 'web'); }));
  // WRITING STYLES (lib/writingstyle.js): reading and `style for` are open to the assistant; rules, assignments and suggestions change ONLY from the owner's web session
  // (the assistant's change request becomes a suggestion that he accepts or dismisses)
  const ownerWeb = (req) => { if (!req.viaCookie) throw new HttpError(403, 'רק הבעלים משנה סגנונות כתיבה (בהגדרות)'); };
  const styleCtx = (src) => ({ to: src.to, cc: src.cc, reply_email: src.reply_email || src['reply-email'] || undefined, task: src.task || undefined });
  app.get('/api/styles', A(() => ({ styles: styles.list(), suggestions: styles.suggestions(), groups: styles.groups(), roles: styles.ROLES })));
  app.get('/api/styles/for', A((req) => styles.styleFor(styleCtx(req.query || {}))));
  app.post('/api/styles/check', A((req) => { const b = req.body || {}; const r = styles.resolve(styleCtx(b)); if (!r.style) return { ok: true, style_key: null }; const v = styles.validate(b.body, r.style, { to_names: r.to.map((x) => x.first_name).filter(Boolean), to_count: r.to.length || 1, reply_email: b.reply_email, task: b.task, long: !!b.long }); return { ok: !v.violations.length, style_key: r.style.key, style_name: r.style.name_he, chosen_by: r.via, note: r.note_he, violations: v.violations, warnings: v.warnings, metrics: v.metrics }; }));
  app.get('/api/styles/feedback', A((req) => { const r = styles.resolve(styleCtx(req.query || {})); const em = [...r.to, ...r.cc].map((x) => x.email).filter(Boolean); return { recipients: r.recipients, edits: styles.feedbackFor(em, +req.query.limit || 10) }; }));
  app.get('/api/styles/:id', A((req) => styles.get(req.params.id)));
  app.post('/api/styles', A((req, reply) => { ownerWeb(req); return reply.code(201).send(styles.create(req.actor, { ...(req.body || {}), status: (req.body || {}).status || 'active' })); }));
  app.patch('/api/styles/:id', A((req, reply) => { const r = styles.update(req.actor, req.params.id, req.body || {}, { owner: !!req.viaCookie }); if (r.suggested) reply.code(202); return r; }));
  app.post('/api/styles/:id/assign', A((req) => { ownerWeb(req); return styles.assign(req.actor, req.params.id, req.body || {}, { owner: true }); }));
  app.delete('/api/styles/:id/assign/:aid', A((req) => { ownerWeb(req); return styles.unassign(req.actor, req.params.id, num(req.params.aid)); }));
  app.post('/api/styles/group-member', A((req) => { ownerWeb(req); const b = req.body || {}; return styles.setGroup(req.actor, b.person, b.group || null); }));
  app.post('/api/style-suggestions/:id/:action', A((req) => { ownerWeb(req); if (!['accept', 'dismiss'].includes(req.params.action)) throw new HttpError(404, 'לא נמצא'); return styles.decideSuggestion(req.actor, num(req.params.id), req.params.action === 'accept'); }));
  const archive = require('./archive').createArchive({ db, store, knowledge });
  app.archive = archive;
  const ingest = require('./ingest').createIngest({ db, store, knowledge, importer, calendar, archive, version: require('../package.json').version });
  app.ingest = ingest;
  const connector = require('./connector').createConnector({ db, outboxKey: () => outbox.key(), host: () => require('./ingest').tailscaleAddr() });
  app.connector = connector;
  app.presence = require('./presence').createPresence({ db, store, trash, confirm: confirmations }); // POST /ingest/mail-presence: mail deleted in Outlook goes to the recycle bin
  app.get('/api/connector/devices', A(() => connector.list()));
  app.post('/api/connector/pair-code', A((req) => { ownerSession(req); return connector.newCode(); }));
  app.post('/api/connector/devices/:id/revoke', A((req) => { ownerSession(req); return connector.revoke(num(req.params.id)); }));
  app.post('/api/connector/devices/:id/activate', A((req) => { ownerSession(req); return connector.activateById(num(req.params.id)); }));
  app.get('/api/connector/download', A((req, reply) => { const f = connector.installer(); return reply.header('Content-Type', 'application/octet-stream').header('Content-Length', f.size).header('Content-Disposition', `attachment; filename="${f.name}"`).send(require('fs').createReadStream(f.path)); }));
  app.get('/api/connector/latest', A(() => connector.latestPublic()));
  app.get('/api/ingest/status', A(() => ingest.status()));
  app.get('/api/mail-archive/status', A(() => archive.status()));
  app.get('/api/mail-archive/failed', A(() => archive.failed()));
  app.post('/api/mail-archive/retry', A(() => ({ requeued: archive.retryFailed() })));
  app.get('/api/mail-archive/estimate', A((req) => archive.estimate({ emails: +req.query.emails || 20000, fullShare: req.query.full_share !== undefined ? +req.query.full_share : undefined }))); // the Outlook mail archive (old mail, text only beyond a year): `mesimot archive status`, the Settings line
  // ---- backup and encryption card (Settings). The key is shown only to the owner's web session after the web password is entered again; never to the assistant's token.
  const offsite = require('./offsite');
  app.get('/api/backup/status', A(() => {
    const st = offsite.readStatus(db) || {}; const v = offsite.verdict(offsite.readStatus(db));
    return { local: offsite.localBackupInfo(process.env.MESIMOT_BACKUPS || path.join(__dirname, '..', 'backups')),
      offsite: { configured: !!offsite.readStatus(db), last_run_at: st.last_run_at || null, last_ok: st.last_ok ?? null, last_error: st.last_error || null, last_success_at: st.last_success_at || null,
        copies: st.db?.copies ?? null, last_db_bytes: st.db?.bytes ?? null, remote_bytes: st.remote_bytes ?? null, free_bytes: st.free_bytes ?? null, files_uploaded_last: st.files_uploaded_last ?? null, verdict: v } };
  }));
  app.post('/api/backup/key', A(async (req, reply) => {
    ownerSession(req); // web session only
    const client = clientOf(req); const left = auth.lockedFor(client);
    reply.header('Cache-Control', 'no-store, no-transform').header('Pragma', 'no-cache');
    if (left) return reply.code(429).send({ error: he.locked(Math.ceil(left / 60000)) });
    const ok = auth.checkPassword(db, req.body?.password, client);
    if (!ok) {
      if (loginDelayMs) await new Promise((r) => setTimeout(r, loginDelayMs));
      const l2 = auth.lockedFor(client);
      if (l2) return reply.code(429).send({ error: he.locked(Math.ceil(l2 / 60000)) });
      return reply.code(403).send({ error: he.wrongPassword }); // not 401: the page would take that for an expired session and go to the login screen
    }
    const key = require('./dbkey').loadKey({ file: process.env.MESIMOT_DB || null });
    if (!key) return reply.code(404).send({ error: 'אין מפתח הצפנה בשרת' });
    const id = store.logEvent(req.actor, 'security', 0, 'key_view', null, null, 'המפתח הוצג'); db.prepare('UPDATE events SET processed_at=? WHERE id=?').run(new Date().toISOString(), id); // the text only, never the key
    return { key };
  }));
  return app;
}

async function main() {
  const port = +(process.env.MESIMOT_PORT || 8110);
  const app = build({ dbPath: process.env.MESIMOT_DB });
  if (!process.env.MESIMOT_TOKEN && !readEnvFile().MESIMOT_TOKEN) console.warn('warning: no API token configured');
  await app.listen({ host: '127.0.0.1', port });
  console.log(`mesimot listening on 127.0.0.1:${port}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { build, readEnvFile, ENV_FILE };
