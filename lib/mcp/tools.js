'use strict';
// The MCP tool table: ONE place for every tool the assistant gets (docs/MCP.md). Each entry: name, one-line description, schema, example (shown in
// validation errors), profiles, call(args, api). A tool only maps its arguments to one or two calls of the local HTTP API: no rule lives here, the
// server keeps every gate, confirmation, audit entry and undo. Argument names follow the CLI (bin/mesimot) with "-" written as "_".
const { ToolError } = require('./api');

const PROFILES = ['full', 'import', 'apply_only'];
const enc = encodeURIComponent;

// ---- schema helpers
const DATE = '^(\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[/.]\\d{1,2}[/.]\\d{4})$';
const DATETIME = '^(\\d{4}-\\d{2}-\\d{2}([T ]\\d{2}:\\d{2}(:\\d{2})?(Z|[+-]\\d{2}:?\\d{2})?)?|\\d{1,2}[/.]\\d{1,2}[/.]\\d{4}( \\d{1,2}:\\d{2})?)$';
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const text = (description) => ({ type: 'string', minLength: 1, description });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const bool = (description) => ({ type: 'boolean', description });
const date = (description, nullable = false) => ({ type: nullable ? ['string', 'null'] : 'string', pattern: DATE, expect: 'a date YYYY-MM-DD (DD/MM/YYYY also works)', description });
const datetime = (description, nullable = false) => ({ type: nullable ? ['string', 'null'] : 'string', pattern: DATETIME, expect: 'a date-time like 2026-11-29 11:00 (Jerusalem time) or 29/11/2026 11:00', description });
const ref = (description, nullable = false) => ({ type: nullable ? ['string', 'integer', 'null'] : ['string', 'integer'], description }); // a name or an id
const ids = (description) => ({ type: 'array', items: { type: 'integer' }, description });
const list = (description) => ({ type: ['string', 'array'], items: { type: ['string', 'integer'] }, description });
const obj = (properties, required = []) => ({ properties, required, additionalProperties: false });

// ---- helpers for calls
const take = (args, keys) => { const b = {}; for (const k of keys) if (args[k] !== undefined) b[k] = args[k]; return b; };
const noneToNull = (b, keys) => { for (const k of keys) if (b[k] === 'none' || b[k] === '') b[k] = null; return b; };
const csv = (v) => (Array.isArray(v) ? v.join(',') : v);
const mailArchive = { type: 'string', enum: ['0', '1', 'only'], description: '0 = without the old Outlook mail archive, only = only the archive; default: included' };
const bad = (tool, msg, example) => new ToolError('validation', `${tool}: ${msg}.${example ? ' Example: ' + JSON.stringify(example) : ''}`);

const SHOW_URL = {
  task: (id) => `/api/tasks/${id}`, email: (id) => `/api/emails/${id}`, email_thread: (id) => `/api/emails/${id}/thread`, file: (id) => `/api/files/${id}/show`,
  chunk: (id) => `/api/chunks/${id}`, knowledge: (id) => `/api/knowledge/${id}`, protocol: (id) => `/api/protocols/${id}`,
  project: (id) => `/api/projects/${enc(id)}/show`, person: (id) => `/api/people/${enc(id)}`,
};
const TASK_FIELDS = { title: text('Title'), project: ref('Project name or id'), assignee: ref('Person name or id (null = nobody)', true), requester: ref('Person name or id (null = nobody)', true), status: { type: 'string', lookup: 'statuses', description: 'Status name' }, priority: { type: 'string', lookup: 'priorities', description: 'Priority name' }, due: date('Due date', true), source_date: datetime('When it was asked (mail date)', true), due_source: { type: 'string', enum: ['explicit', 'estimated', 'manual'], description: 'explicit = written in the source, estimated = your guess' }, desc: str('Description'), parent: int('Parent task id', { type: ['integer', 'null'] }), email: int('Source or linked email id') };
const TASK_KEYS = ['title', 'project', 'assignee', 'requester', 'status', 'priority', 'due', 'source_date', 'due_source', 'desc', 'parent', 'email'];
const PERSON_FIELDS = { name: text('Hebrew name'), name_en: str('Latin name'), role: str('contact | boss | team (default contact)'), emails: list('Email address(es)'), notes: str('Notes'), status: { type: 'string', enum: ['full', 'partial'], description: 'partial = not yet identified' }, company: str('Company'), role_text: str('Job title in words') };
const PERSON_KEYS = ['name', 'role', 'emails', 'notes', 'status', 'company', 'name_en', 'role_text'];
const OUTBOX_FIELDS = { kind: { type: 'string', enum: ['new', 'reply', 'reply_all', 'forward'], description: 'Default new' }, to: list('Recipients: "a@x.example" or "Name (a@x.example)"'), cc: list('Cc'), bcc: list('Bcc'), subject: str('Subject'), body: str('Mail text, in the owner\'s style (see style_for)'), attach: list('File ids to attach'), task: int('Related task id'), reply_email: int('Email id being answered (fills recipients and subject)'), long: bool('Only when the owner asked for a long mail') };
const OUTBOX_KEYS = ['kind', 'to', 'cc', 'bcc', 'subject', 'body', 'attach', 'task', 'reply_email', 'long'];

const APPLY_KEYS = {
  email: int('Email id the decisions come from'),
  decisions: { type: 'array', description: 'One per related task: {task, action: close|advance|update|no_change, reason (Hebrew), changes?}' },
  new_tasks: { type: 'array', description: '{title, project, assignee, requester, priority, due, due_source, source_date, description}' },
  knowledge: { type: 'array', description: '{project, kind, title, body}' },
  facts: { type: 'array', description: 'Project card facts {project, key, value, unit?, as_of, topic?, source?}' },
  profile: { type: 'array', description: 'Project passport values {project, <field>, as_of, source}' },
  statuses: { type: 'array', description: 'Latest status per process {project, process, text, as_of, source}' },
  fact_topics: { type: 'array', description: '{topic, ids:[fact ids]}' },
  profile_checked: bool('Nothing new for the passport'),
  facts_checked: {}, attention: { type: 'array', description: '{kind: reminder|question|suggestion, text, task?}' },
  people: { type: 'array', description: 'Hebrew names {id, name, name_en}' },
  drafts: { type: 'array', description: 'Reply drafts {task, text}' },
  fact_merges: { type: 'array', description: 'Curator: {project, from_key, into_key}' },
  projects: { type: 'array', description: 'Curator: {project, summary}' },
  merge_people: { type: 'array', description: 'Curator: {from, into}' },
  resolutions: { type: 'array', description: 'Verdicts on partial people / vague projects {type, id, action, ...}' },
  mentions: { type: 'array', description: 'Names noticed {type, id, source_type, source_id, surface}' },
  protocols: { type: 'array', description: 'Meeting minutes with their items' },
  calendar: { type: 'array', description: 'Calendar items to add' },
  outbox: { type: 'array', description: 'Mail drafts {op: draft|update|cancel, ...}' },
  files: { type: 'array', description: 'File classification {id, project, summary, facts_checked}' },
  chat_message: str('Short Hebrew reply to the owner'), chat_tasks: {}, chat_files: {}, dismiss_names: {}, dup_checks: {},
  summary: str('One Hebrew line about what was done'),
};

const T = [];
const tool = (t) => { T.push(t); return t; };
const READ = PROFILES; // every profile

// ---------------- read
tool({ name: 'show', profiles: READ, textWindow: true,
  description: 'Open one item in full: task, email, email_thread, file, chunk, knowledge, protocol, project or person. Long text: use offset and max_chars.',
  schema: obj({ kind: { type: 'string', enum: Object.keys(SHOW_URL) }, id: ref('Id (project and person: a name also works)'), offset: int('Start at this character', { minimum: 0 }), max_chars: int('Return at most this many characters', { minimum: 1, maximum: 20000 }) }, ['kind', 'id']),
  example: { kind: 'task', id: 104 },
  async call(a, api) {
    if (!['project', 'person'].includes(a.kind) && !/^\d+$/.test(String(a.id))) throw bad('show', `"id" must be a number for kind "${a.kind}", got ${JSON.stringify(a.id)}`, { kind: a.kind, id: 104 });
    return api.get(SHOW_URL[a.kind](a.id));
  } });
tool({ name: 'task_list', profiles: READ,
  description: 'List tasks. Filters: open, project, assignee, requester, status, priority, person, q (text), stale_days, overdue, include_hidden, closed (the archive), from/to (last change date), limit.',
  schema: obj({ open: bool('Only open tasks'), closed: bool('Archive: done and cancelled tasks'), project: ref('Project name or id (comma list ok)'), assignee: str('Person, or none'), requester: str('Person, or none'), status: str('Status name'), priority: str('Priority name'), person: str('Requester or assignee'), q: str('Words in the title, description or project'), stale_days: int('Open and not touched for N days', { minimum: 0 }), overdue: bool('Open and past due'), include_hidden: bool('Also hidden statuses'), from: date('Changed or closed on/after'), to: date('Changed or closed on/before'), limit: int('Max rows', { minimum: 1, maximum: 1000 }) }),
  example: { open: true, project: 'Example Tower' },
  call: (a, api) => api.get('/api/tasks', a) });
tool({ name: 'search', profiles: READ,
  description: 'Search tasks, notes, mail, files and knowledge (keyword, semantic or hybrid).',
  schema: obj({ q: text('Words to search'), project: ref('Project'), person: str('Person'), kind: str('Result kind'), from: date('From date'), to: date('To date'), limit: int('Max results', { minimum: 1, maximum: 200 }), mode: { type: 'string', enum: ['keyword', 'semantic', 'hybrid'] }, archive: bool('Include closed tasks'), mail_archive: mailArchive }, ['q']),
  example: { q: 'concrete pour', project: 'Example Tower' },
  call: (a, api) => api.get('/api/search', a) });
tool({ name: 'ask', profiles: READ,
  description: 'Answer a question from the knowledge base (synonyms, keyword and semantic retrieval, with file and page).',
  schema: obj({ q: text('The question'), project: ref('Project'), limit: int('Max passages', { minimum: 1, maximum: 50 }), mail_archive: mailArchive }, ['q']),
  example: { q: 'when is the next meeting about the permit?', project: 'Example Tower' },
  call: (a, api) => api.get('/api/ask', a) });
tool({ name: 'project_list', profiles: ['full', 'import'],
  description: 'List projects, or find one by name or alias with "find".',
  schema: obj({ find: str('Part of a name or alias') }),
  example: { find: 'tower' },
  async call(a, api) {
    const all = await api.get('/api/projects');
    if (!a.find) return all;
    const needle = String(a.find).toLowerCase();
    return all.filter((x) => [x.name_he, ...(x.aliases || [])].filter(Boolean).join(' ').toLowerCase().includes(needle)).slice(0, 10).map((x) => ({ id: x.id, name_he: x.name_he, aliases: x.aliases, open_count: x.open_count }));
  } });
tool({ name: 'person_find', profiles: ['full', 'import'],
  description: 'Find people by name, email or company.',
  schema: obj({ query: text('Part of a name, email or company') }, ['query']),
  example: { query: 'dana' },
  async call(a, api) {
    const needle = String(a.query).toLowerCase();
    const all = await api.get('/api/people');
    return all.filter((x) => [x.name_he, x.name_en, x.company, x.role_text, ...(x.emails || [])].filter(Boolean).join(' ').toLowerCase().includes(needle)).slice(0, 15).map((x) => ({ id: x.id, name_he: x.name_he, name_en: x.name_en, role: x.role, company: x.company, role_text: x.role_text, emails: x.emails, status: x.status }));
  } });
tool({ name: 'file_list', profiles: READ, description: 'List stored files, optionally of one project.',
  schema: obj({ project: ref('Project') }), example: { project: 'Example Tower' }, call: (a, api) => api.get('/api/files', a) });
tool({ name: 'chat_list', profiles: ['full'], description: 'Recent chat messages with the owner.',
  schema: obj({ limit: int('How many (default 20)', { minimum: 1, maximum: 200 }) }), example: { limit: 20 }, call: (a, api) => api.get('/api/chat', { limit: a.limit || 20 }) });
tool({ name: 'pending', profiles: ['full'], description: 'Events and mail waiting for you.', schema: obj({}), example: {}, call: (a, api) => api.get('/api/pending') });
tool({ name: 'attention_list', profiles: ['full'], description: 'Reminders, questions and suggestions for the owner.',
  schema: obj({ status: { type: 'string', enum: ['open', 'accepted', 'dismissed', 'all'] } }), example: { status: 'open' }, call: (a, api) => api.get('/api/attention', a) });
tool({ name: 'calendar_list', profiles: ['full'], description: 'Calendar items (including the Outlook mirror) in a date range.',
  schema: obj({ from: date('From'), to: date('To'), q: str('Words in the title') }), example: { from: '2026-11-29', to: '2026-12-05' }, call: (a, api) => api.get('/api/calendar', a) });
tool({ name: 'outbox_list', profiles: ['full'], description: 'Mail drafts and their status; with id, one draft in full.',
  schema: obj({ id: int('Show this draft'), status: str('Filter by status'), limit: int('Max rows', { minimum: 1, maximum: 200 }) }), example: { status: 'pending' },
  call: (a, api) => (a.id ? api.get(`/api/outbox/${a.id}`) : api.get('/api/outbox', a)) });
tool({ name: 'trash_list', profiles: ['full'], description: 'The recycle bin: what can be restored.',
  schema: obj({ kind: { type: 'string', enum: ['task', 'project', 'person', 'protocol', 'calendar', 'chat', 'filter', 'email'] }, limit: int('Max rows', { minimum: 1, maximum: 200 }) }), example: { kind: 'task' }, call: (a, api) => api.get('/api/trash', a) });
tool({ name: 'style_for', profiles: ['full'], description: 'The owner\'s writing style for these recipients. Call it BEFORE any mail draft.',
  schema: obj({ to: str('Addresses or names'), cc: str('Cc'), reply_email: int('Email id being answered'), task: int('Task id') }), example: { to: 'dana@exconstruct.example' },
  async call(a, api) {
    if (!a.to && !a.reply_email && !a.task) throw bad('style_for', 'give "to", "reply_email" or "task"', { to: 'dana@exconstruct.example' });
    return api.get('/api/styles/for', a);
  } });

// ---------------- write
tool({ name: 'apply', profiles: READ, description: 'The structured answer: decisions, new_tasks, facts, resolutions, chat_message, summary... in ONE call. dry=true only validates.',
  schema: { properties: { dry: bool('Only validate, change nothing'), ...APPLY_KEYS }, additionalProperties: false },
  example: { email: 7, decisions: [{ task: 1, action: 'no_change', reason: 'not related' }], summary: 'checked' },
  call: (a, api) => { const { dry, ...body } = a; return api.post('/api/apply', body, { dry: dry ? '1' : undefined }); } });
tool({ name: 'run_summary', profiles: READ, description: 'End every run with one short Hebrew line about what you did.',
  schema: obj({ text: text('One short Hebrew line') }, ['text']), example: { text: 'עדכנתי משימה אחת' }, call: (a, api) => api.post('/api/run-summary', { text: a.text }) });
tool({ name: 'task_create', profiles: ['full'], description: 'Create a task. Dates YYYY-MM-DD; status and priority by name.',
  schema: obj(TASK_FIELDS, ['title']), example: { title: 'Send the plans', project: 'Example Tower', due: '2026-11-29' },
  call: (a, api) => api.post('/api/tasks', noneToNull(take(a, TASK_KEYS), ['assignee', 'requester', 'due', 'source_date', 'parent'])) });
tool({ name: 'task_update', profiles: ['full'], description: 'Change fields of a task (only the ones you give). null clears assignee, requester, due, source_date or parent.',
  schema: obj({ id: int('Task id'), ...TASK_FIELDS, relation: { type: 'string', enum: ['created', 'updated', 'closed', 'info'], description: 'How "email" is linked' } }, ['id']), example: { id: 104, due: '2026-11-29' },
  call: (a, api) => api.patch(`/api/tasks/${a.id}`, noneToNull(take(a, [...TASK_KEYS, 'relation']), ['assignee', 'requester', 'due', 'source_date', 'parent'])) });
tool({ name: 'note_add', profiles: ['full'], description: 'Add a note to a task or a project.',
  schema: obj({ task: int('Task id'), project: ref('Project'), text: text('The note'), kind: { type: 'string', enum: ['text', 'voice', 'summary'] } }, ['text']), example: { task: 104, text: 'The contractor confirmed by phone' },
  async call(a, api) { if (!a.task && !a.project) throw bad('note_add', 'give "task" or "project"', { task: 104, text: '...' }); return api.post('/api/notes', take(a, ['task', 'project', 'text', 'kind'])); } });
tool({ name: 'draft_add', profiles: ['full'], description: 'Add a reply draft (text for the owner to copy) to a task. Never sent.',
  schema: obj({ task: int('Task id'), text: text('The draft'), long: bool('Only when a long text was asked for') }, ['task', 'text']), example: { task: 104, text: 'שלום דנה, ...' },
  call: (a, api) => api.post(`/api/tasks/${a.task}/drafts`, { text: a.text, ...(a.long ? { long: true } : {}) }) });
tool({ name: 'chat_send', profiles: ['full'], description: 'Send ONE message to the owner (web chat and Telegram). file sends documents.',
  schema: obj({ text: str('The message, in Hebrew'), task: list('Task ids the message is about'), file: list('File ids to send'), task_scope: str('Task id (or 0) to post in a task thread'), entity_scope: str('Entity ref or 0'), main: bool('Post in the main chat from a scoped run (short, once)') }), example: { text: 'עדכנתי את המשימה', task: [104] },
  async call(a, api) {
    if (!String(a.text ?? '').trim() && !a.file) throw bad('chat_send', '"text" is required (or "file")', { text: 'עדכנתי את המשימה' });
    const b = take(a, ['text']);
    if (a.task !== undefined) b.task = csv(a.task); if (a.file !== undefined) b.file = csv(a.file);
    if (a.task_scope !== undefined) b.task_scope = a.task_scope; if (a.entity_scope !== undefined) b.entity_scope = a.entity_scope; if (a.main) b.main = true;
    return api.post('/api/chat', b);
  } });
tool({ name: 'person_add', profiles: ['full'], description: 'Add a person (status partial when only a name is known).',
  schema: obj(PERSON_FIELDS, ['name']), example: { name: 'דנה לוי', emails: 'dana@exconstruct.example', company: 'Example Construction' },
  call: (a, api) => api.post('/api/people', take(a, PERSON_KEYS)) });
tool({ name: 'person_update', profiles: ['full'], description: 'Change a person (only the fields you give).',
  schema: obj({ person: ref('Person name or id'), ...PERSON_FIELDS, name: str('Hebrew name') }, ['person']), example: { person: 12, company: 'Example Construction' },
  call: (a, api) => api.patch(`/api/people/${enc(a.person)}`, take(a, PERSON_KEYS)) });
tool({ name: 'person_merge', profiles: ['full'], description: 'Merge a duplicate person into another (cannot be undone: be certain).',
  schema: obj({ from: ref('The duplicate'), into: ref('The person to keep') }, ['from', 'into']), example: { from: 14, into: 9 },
  call: (a, api) => api.post(`/api/people/${enc(a.from)}/merge`, { into: a.into }) });
tool({ name: 'project_propose', profiles: ['full'], description: 'Propose a new project; the owner approves it. You cannot create one.',
  schema: obj({ name: text('Project name'), aliases: list('Other names'), from: str('Source: email:ID, chat:ID or protocol:ID'), context: str('One line why'), description: str('Description'), attach: list('Items to attach, e.g. task:12,email:5') }, ['name']), example: { name: 'Example Park', from: 'email:5', context: 'new plot mentioned' },
  call: (a, api) => api.post('/api/projects/propose', take(a, ['name', 'aliases', 'from', 'context', 'description', 'attach'])) });
tool({ name: 'project_update', profiles: ['full'], description: 'Change a project: name (the old one becomes an alias), aliases, description, status, color, summary.',
  schema: obj({ project: ref('Project name or id'), name: str('New name'), aliases: list('Aliases'), description: str('Description'), status: str('Status'), color: str('Color'), summary: str('Summary'), partial: bool('Not fully identified') }, ['project']), example: { project: 'Example Tower', summary: '...' },
  call: (a, api) => api.patch(`/api/projects/${enc(a.project)}`, take(a, ['name', 'aliases', 'description', 'status', 'color', 'summary', 'partial'])) });
tool({ name: 'calendar_add', profiles: ['full'], description: 'Add a calendar item (Jerusalem time).',
  schema: obj({ title: text('Title'), start: datetime('Start'), end: datetime('End'), location: str('Place'), description: str('Details'), task: int('Link to this task'), project: ref('Link to this project'), email: int('Link to this email') }, ['title', 'start']), example: { title: 'Site meeting', start: '2026-11-29 11:00', task: 104 },
  call: (a, api) => api.post('/api/calendar/items', take(a, ['title', 'start', 'end', 'location', 'description', 'task', 'project', 'email'])) });
tool({ name: 'calendar_update', profiles: ['full'], description: 'Move or change a calendar item.',
  schema: obj({ id: int('Item id'), title: str('Title'), start: datetime('Start'), end: datetime('End'), location: str('Place'), description: str('Details') }, ['id']), example: { id: 3, start: '2026-11-30 09:00' },
  call: (a, api) => api.patch(`/api/calendar/items/${a.id}`, take(a, ['title', 'start', 'end', 'location', 'description'])) });
tool({ name: 'calendar_delete', profiles: ['full'], description: 'Delete a calendar item (goes to the recycle bin).',
  schema: obj({ id: int('Item id') }, ['id']), example: { id: 3 }, call: (a, api) => api.del(`/api/calendar/items/${a.id}`) });
tool({ name: 'attention_add', profiles: ['full'], description: 'Add a reminder, question or suggestion for the owner.',
  schema: obj({ kind: { type: 'string', enum: ['reminder', 'question', 'suggestion'] }, text: text('Text, in Hebrew'), task: int('Related task id') }, ['kind', 'text']), example: { kind: 'question', text: 'האם לסגור את המשימה?', task: 104 },
  call: (a, api) => api.post('/api/attention', take(a, ['kind', 'text', 'task'])) });
tool({ name: 'attention_update', profiles: ['full'], description: 'Set the status of an attention item.',
  schema: obj({ id: int('Item id'), status: { type: 'string', enum: ['open', 'accepted', 'dismissed'] } }, ['id', 'status']), example: { id: 5, status: 'dismissed' },
  call: (a, api) => api.patch(`/api/attention/${a.id}`, { status: a.status }) });
tool({ name: 'ack', profiles: ['full'], description: 'Mark events as handled. The runner normally does this; rarely needed.',
  schema: obj({ ids: ids('Event ids') }, ['ids']), example: { ids: [1, 2] }, call: (a, api) => api.post('/api/ack', { ids: a.ids }) });
tool({ name: 'outbox_draft', profiles: ['full'], description: 'Prepare a mail DRAFT as a card; the owner approves with a button. Run style_for first.',
  schema: obj(OUTBOX_FIELDS), example: { to: 'dana@exconstruct.example', subject: 'Plans', body: 'Hi Dana, ...' },
  call: (a, api) => api.post('/api/outbox', take(a, OUTBOX_KEYS)) });
tool({ name: 'outbox_update', profiles: ['full'], description: 'Change a draft (creates a new card and cancels the old approval).',
  schema: obj({ id: int('Draft id'), ...OUTBOX_FIELDS }, ['id']), example: { id: 4, body: 'Hi Dana, ...' },
  call: (a, api) => api.patch(`/api/outbox/${a.id}`, take(a, OUTBOX_KEYS)) });
tool({ name: 'outbox_cancel', profiles: ['full'], description: 'Cancel a draft.', schema: obj({ id: int('Draft id') }, ['id']), example: { id: 4 }, call: (a, api) => api.post(`/api/outbox/${a.id}/cancel`, {}) });
tool({ name: 'style_check', profiles: ['full'], description: 'Check a mail text against the owner\'s style rules without saving it.',
  schema: obj({ to: str('Recipients'), cc: str('Cc'), task: int('Task id'), reply_email: int('Email id'), body: text('The text'), long: bool('Long text allowed') }, ['body']), example: { to: 'dana@exconstruct.example', body: 'Hi Dana, ...' },
  call: (a, api) => api.post('/api/styles/check', take(a, ['to', 'cc', 'task', 'reply_email', 'body', 'long'])) });
tool({ name: 'confirm', profiles: ['full'], description: 'ASK the owner to confirm a deletion. Nothing is deleted until he presses yes; then it goes to the recycle bin (trash_delete and trash_empty are permanent).',
  schema: obj({ kind: { type: 'string', enum: ['task_delete', 'project_delete', 'person_delete', 'protocol_delete', 'trash_delete', 'trash_empty'] }, id: ref('Task, project, person, protocol or trash id'), tasks: str('project_delete only: move:<project> | unassign | delete'), facts: str('project_delete only'), protocols: str('project_delete only') }, ['kind']), example: { kind: 'task_delete', id: 104 },
  async call(a, api) {
    if (a.kind !== 'trash_empty' && (a.id === undefined || a.id === '')) throw bad('confirm', `"id" is required for kind "${a.kind}"`, { kind: a.kind, id: 104 });
    if (a.kind === 'project_delete') return api.post('/api/confirm', { kind: a.kind, id: a.id, payload: { tasks: a.tasks || 'unassign', ...(a.facts ? { facts: a.facts } : {}), ...(a.protocols ? { protocols: a.protocols } : {}) } });
    return api.post('/api/confirm', a.kind === 'trash_empty' ? { kind: a.kind } : { kind: a.kind, id: a.id });
  } });
tool({ name: 'trash_restore', profiles: ['full'], description: 'Restore an item from the recycle bin with everything it held.',
  schema: obj({ id: int('Trash id (from trash_list)') }, ['id']), example: { id: 7 }, call: (a, api) => api.post(`/api/trash/${a.id}/restore`, {}) });

// profiles: `full` = every tool; `import` = the read tools, apply, run_summary, person_find, project_list; `apply_only` = the read tools, apply, run_summary
for (const t of T) { for (const p of t.profiles) if (!PROFILES.includes(p)) throw new Error(`tool ${t.name}: unknown profile ${p}`); if (!t.profiles.includes('full')) throw new Error(`tool ${t.name} must be in the full profile`); }
const inProfile = (t, profile) => t.profiles.includes(profile);
function forProfile(profile) { return T.filter((t) => inProfile(t, profile)); }

module.exports = { TOOLS: T, PROFILES, forProfile, inProfile };
