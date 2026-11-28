'use strict';
const TZ = 'Asia/Jerusalem';
const FIELD_LABELS = {
  title: 'הכותרת', description: 'התיאור', status: 'הסטטוס', priority: 'הדחיפות', project: 'הפרויקט',
  assignee: 'האחראי', due_date: 'תאריך היעד', parent_task_id: 'משימת האב',
  requester: 'השולח', email_link: 'קישור למייל', source_date: 'תאריך הקבלה', due_source: 'מקור תאריך היעד',
};

function jerusalemParts(d) {
  const o = {};
  for (const p of new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d)) o[p.type] = p.value;
  return o;
}
const todayISO = () => { const p = jerusalemParts(new Date()); return `${p.year}-${p.month}-${p.day}`; };

// the settings categories (order = the order on the screen) and their icons
const SET_CATS = [
  { id: 'notify', title: 'התראות וטלגרם' }, { id: 'outlook', title: 'מחשב Outlook' }, { id: 'mail', title: 'דואר' },
  { id: 'calendar', title: 'יומן באאוטלוק' }, { id: 'ai', title: 'מודלים ועלויות' }, { id: 'tasks', title: 'סטטוסים ודחיפויות' },
  { id: 'trash', title: 'סל מחזור ושמירה' }, { id: 'backup', title: 'גיבוי והצפנה' }, { id: 'account', title: 'חשבון ואבטחה' }, { id: 'system', title: 'מצב המערכת' },
];
const SET_ICONS = {
  notify: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  outlook: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  ai: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>',
  tasks: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h9"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  backup: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  account: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  system: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
};

function app() {
  return {
    ready: false, boot: { statuses: [], priorities: [], people: [], projects: [], today: '' },
    route: { name: 'home', id: null }, tasks: [], overdue: [], openTasks: [], attention: [], detail: null, detailError: '',
    filters: { q: '', project: null, assignee: null, status: null, requester: null, group: false }, showAttn: false, showFilters: false, 
    quickTitle: '', noteText: '', newProject: '', newPerson: { name: '', email: '', role: 'contact' },
    colors: ['#2563eb', '#0d9488', '#d97706', '#9333ea', '#db2777', '#16a34a', '#0891b2', '#dc6b2f', '#6366f1', '#65a30d'],
    editing: null, form: {}, mergeInto: '', showAllOverdue: false,
    toastMsg: '', toastErr: false, _toastT: null, dlg: null,
    // stage 2
    chatMsgs: [], lastMsgId: 0, chatText: '', chatFiles: [], sending: false, listening: false, awaitingId: 0, status: { working: false, pending_chat: 0, last_run: null, last_message_id: 0 },
    showManual: false, listScroll: null, ed: null, picker: null, noteFocus: false, seenId: 0, nowTick: Date.now(), chatOpen: false, act: null, sem: null, moreOpen: false, storage: null, health: null, dropping: null, chatTask: null, density: 'regular', uploads: [], personCard: null, usage: null, usageDays: 7, fbStats: null, fb: { open: false, reason: '', text: '', sent: null, fixes: false, mergeInto: '', id: null }, fbReasons: ['לא משימה', 'משימה של מישהו אחר', 'פרויקט שגוי', 'תאריך שגוי', 'היה צריך משימה', 'כפילות'], mailFilters: [], fform: { kind: 'sender', pattern: '', action: 'skip', project: '', field: 'any' }, fprev: null, purgeDlg: null, purgeUndo: null, purgeTick: 0, restoredBins: {}, bin: { items: [], counts: {}, total: 0, days: 60, kind: '', loading: false }, proposalCards: {}, propSel: {}, ingest: null, doneUndo: null, enterId: null, replyTo: null, sysHealth: null, cn: { devices: [], code: null, latest: null }, bk: { st: null, ask: false, pw: '', key: null, busy: false, err: '' }, obSet: null, obEdit: null, tcText: '', tcSending: false, sc: { text: '', sending: false, waiting: '' }, msgMenu: null, editing: null, delDlg: null, chatTaskMsgs: true, listeningTask: false, newBelow: 0, calView: 'month', calProject: 'all', calFilterOpen: false, calPopStyle: '', calDate: null, calSel: null, calItems: [], st: null, allowText: '', pw: { old: '', new: '' }, protos: [], proto: null, protoErr: '', protoProject: '', selItems: [],
    sq: { q: '', kind: '', project: '', person: '', from: '', to: '', archive: false, mailArchive: true }, arc: { q: '', project: '', person: '', from: '', to: '', items: [], total: 0, loading: false },  sres: null, sErr: '',
    emailView: null, emailErr: '', mailThreadOpen: null, _emailTpl: null,
    mail: { f: { q: '', folder: 'all', project: '', person: '', personName: '', from: '', to: '', att: false, linked: '', archive: '1', noise: '', mode: 'threads' }, range: '', pq: '', sug: [], showF: false, items: [], next: null, total: null, newCount: 0, since: null, capped: false, loading: false, loaded: false, err: '', openId: null, open: {}, sub: {}, seq: 0, urlKey: null, visited: false, scroll: 0 },
    pp: null, ppErr: '', ppSearch: { q: '', results: [] }, pjSumOpen: false, pjEdit: null, pjAddProc: false, pjFq: '', pjHist: false, pjMore: {}, pjClosedMap: (() => { try { return JSON.parse(localStorage.getItem('pjClosed') || '{}'); } catch (e) { return {}; } })(), projQ: '', showNewProj: false, kNote: '', menuOpen: false,

    async init() {
      // one malformed row or value must never blank a screen: the pure render helpers return a harmless default instead of throwing
      for (const [k, d] of [['pc', '#6b7280'], ['pcol', '#6b7280'], ['pname', ''], ['fmtReceived', ''], ['fmtDate', ''], ['fmtDateTime', ''], ['dayOf', ''], ['clipText', ''], ['isLate', false], ['fmtMoney', '']]) {
        const f = this[k]; if (typeof f !== 'function') continue;
        this[k] = (...a) => { try { return f.apply(this, a); } catch (e) { console.warn('render helper', k, e.message); return d; } };
      }
      this.density = MesimotLayout.density();
      // never let the browser open a dropped file (it would leave the app): dragging files over anything that is not a drop zone does nothing
      for (const t of ['dragover', 'drop']) window.addEventListener(t, (e) => { if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')) { e.preventDefault(); if (t === 'drop') this.dropping = null; } });
      window.addEventListener('dragend', () => { this.dropping = null; });
      try {
        this.filters.group = localStorage.getItem('groupProject') === '1';
      } catch (e) { /* storage unavailable */ }

      if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
      window.addEventListener('popstate', () => this.onRoute());
      window.addEventListener('scroll', () => this.mailNearEnd(), { passive: true });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (Date.now() - (this._escGuard || 0) < 200 || this.picker || this.menuOpen || this.dlg) return; if (this.route.name === 'task') this.closeTask(); else if (this.chatOpen) this.closeChat(); } });
      this.$nextTick(() => { // drag the sheet down by its header to close it
        const head = document.querySelector('.cp-head'), panel = document.querySelector('.chat-panel');
        let y0 = null, dy = 0;
        head.addEventListener('touchstart', (e) => { if (window.innerWidth < 900) { y0 = e.touches[0].clientY; dy = 0; panel.style.transition = 'none'; } }, { passive: true });
        head.addEventListener('touchmove', (e) => { if (y0 === null) return; dy = Math.max(0, e.touches[0].clientY - y0); panel.style.transform = `translateY(${dy}px)`; }, { passive: true });
        head.addEventListener('touchend', () => { if (y0 === null) return; panel.style.transition = ''; panel.style.transform = ''; if (dy > 90) this.closeChat(); y0 = null; });
      });
      window.matchMedia('(min-width: 1024px)').addEventListener('change', () => { this.markSeen(); });
      this.$nextTick(() => this.watchFeed());
      document.addEventListener('visibilitychange', () => { if (!document.hidden) { this.refresh(); this.scrollFeed(); } });
      setInterval(() => { if (!document.hidden) this.refresh(); }, 30000);
      try { this.seenId = +localStorage.getItem('seenChatId') || 0; this.chatTaskMsgs = localStorage.getItem('chatScopedMsgs') === '1'; } catch (e) {}
      await this.loadBoot();
      try { await this.loadChat(); } catch (e) { /* the chat retries on the next poll; the app still starts */ }
      this.ready = true;
      await this.onRoute();
      this.pollLoop();
      setInterval(() => { this.nowTick = Date.now(); }, 20000);
    },

    toggleGroup(on) { this.filters.group = on; try { localStorage.setItem('groupProject', on ? '1' : '0'); } catch (e) {} },
    pc(t) { return t.project_default || !t.project_color ? '#6b7280' : t.project_color; },
    sections() {
      const open = this.openList();
      if (!this.filters.group) return [{ key: 'all', title: '', items: open }];
      const out = [];
      for (const p of this.boot.projects) {
        const items = open.filter((t) => t.project_id === p.id);
        if (items.length) out.push({ key: 'g' + p.id, title: p.name_he, color: this.pc({ project_color: p.color, project_default: p.is_default }), def: p.is_default, items });
      }
      return out;
    },

    // ---------- plumbing
    async api(method, url, body) {
      const res = await fetch(url, {
        method, headers: { 'X-Mesimot': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin',
      });
      if (res.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); throw new Error('יש להתחבר מחדש'); }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'אירעה שגיאה. נסו שוב');
      return data;
    },
    toast(msg, err = false) {
      this.toastMsg = msg; this.toastErr = err; clearTimeout(this._toastT);
      this._toastT = setTimeout(() => { this.toastMsg = ''; }, err ? 4000 : 1800);
    },
    fail(e) { this.toast(e && e.message && /[֐-׿]/.test(e.message) ? e.message : 'אירעה שגיאה. נסו שוב', true); },
    ask(msg, ok) { return new Promise((resolve) => { this.dlg = { msg, ok, resolve }; }); },
    closeDlg(v) { this._escGuard = Date.now(); if (this.dlg) { const r = this.dlg.resolve; this.dlg = null; r(v); } },

    // ---------- routing
    parseRoute() {
      const path = location.pathname.replace(/\/+$/, '') || '/';
      let m;
      if ((m = /^\/task\/(\d+)$/.exec(path))) return { name: 'task', id: +m[1] };
      if ((m = /^\/projects\/(\d+)$/.exec(path))) return { name: 'projects', id: +m[1] };
      if ((m = /^\/email\/(\d+)$/.exec(path))) return { name: 'email', id: +m[1] };
      if (path === '/projects') return { name: 'projects', id: null };
      if (path === '/people') return { name: 'people', id: null };
      if (path === '/protocols') return { name: 'protocols', id: null };
      if (path === '/calendar') return { name: 'calendar', id: null };
      if (path === '/settings') { const c = new URLSearchParams(location.search).get('c'); return { name: 'settings', id: null, cat: SET_CATS.some((x) => x.id === c) ? c : null }; }
      if ((m = /^\/protocols\/(\d+)$/.exec(path))) return { name: 'protocols', id: +m[1] };
      if (path === '/chat') return { name: 'home', id: null, chat: true };
      if (path === '/activity') return { name: 'activity', id: null };
      if (path === '/search') return { name: 'search', id: null };
      if (path === '/mail') return { name: 'mail', id: null };
      if (path === '/archive') return { name: 'archive', id: null };
      if (path === '/trash') return { name: 'trash', id: null };
      return { name: 'home', id: null };
    },
    go(path, replace) {
      if (path.startsWith('/api/')) { window.open(path, '_blank'); return; }
      MesimotLayout.snapshot();                                       // panes keep their scroll position across a card opening or closing
      if (replace) history.replaceState({}, '', path); else if (path !== location.pathname + location.search) history.pushState({}, '', path);
      const r = this.onRoute();
      Promise.resolve(r).then(() => this.$nextTick(() => MesimotLayout.restore()));
      return r;
    },
    async onRoute() {
      const r = this.parseRoute();
      const prev = this.route;
      this.route = r;
      this.editing = null; this.menuOpen = false; this.bkHide(); // the encryption key is never kept when the page changes
      if (r.name === 'task') {
        if (!prev || prev.id !== r.id) this.detail = null;
        this.detailError = '';
        if (window.innerWidth < 900) window.scrollTo(0, 0); // on phones the card replaces the list
        await this.loadDetail();
      } else {
        this.detail = null;
        if (r.name === 'home') {
          await this.loadLists(); if (r.chat) this.openChat(true);
          if (prev && prev.name === 'task' && this.listScroll != null) this.$nextTick(() => window.scrollTo(0, this.listScroll));
        }
        else if (r.name === 'activity') { await this.loadBoot(); await this.loadActivity(); }
        else if (r.name === 'archive') { await this.loadBoot(); await this.loadArchive(); }
        else if (r.name === 'trash') { await this.loadBoot(); await this.loadBin(); }
        else if (r.name === 'search') { const q = new URLSearchParams(location.search).get('q'); if (q) this.sq.q = q; await this.loadBoot(); if (this.sq.q) this.runSearch(); }
        else if (r.name === 'mail') await this.mailEnter(prev);
        else if (r.name === 'email') { this.mailThreadOpen = null; await this.loadEmail(r.id); }
        else if (r.name === 'calendar') { await this.loadBoot(); await this.loadCalendar(); }
        else if (r.name === 'settings') {
          // wide screens always show a category (the last one used); on phones /settings is the list of categories
          if (!r.cat && window.matchMedia('(min-width: 900px)').matches) return this.go('/settings?c=' + this.setLast(), true);
          if (r.cat) { try { localStorage.setItem('mesimot.set.cat', r.cat); } catch (e) { /* no storage */ } }
          if (!prev || prev.name !== 'settings') this._setPushed = false;
          window.scrollTo(0, 0); const mp = document.querySelector('main.page'); if (mp) mp.scrollTop = 0;
          await this.loadBoot(); await this.loadSettings();
        }
        else if (r.name === 'protocols') {
          await this.loadBoot(); await this.loadProtocols();
          if (r.id) { window.scrollTo(0, 0); await this.loadProtocol(r.id); }
          else if (window.matchMedia('(min-width: 900px)').matches && this.protos.length) return this.go('/protocols/' + this.protos[0].id, true);
          else this.proto = null;
        }
        else if (r.name === 'projects') {
          await this.loadBoot();
          if (!r.id) {
            let last = null; try { last = +localStorage.getItem('lastProject') || null; } catch (e) {}
            if (last && window.matchMedia('(min-width: 900px)').matches && this.boot.projects.some((p) => p.id === last)) { return this.go('/projects/' + last, true); }
            this.pp = null;
          } else { window.scrollTo(0, 0); await this.loadProjectPage(r.id); }
        } else await this.loadBoot();
      }
    },
    async refresh() {
      try {
        await this.loadBoot();
        if (this.route.name === 'home' || this.route.name === 'task') await this.loadLists();
        const a = document.activeElement;
        const typing = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.closest('.pane-card');
        if (this.route.name === 'task' && !typing) await this.loadDetail(true);
      } catch (e) { /* silent */ }
    },

    // ---------- data
    async loadBoot() { this.boot = await this.api('GET', '/api/bootstrap'); },
    async loadLists() { await Promise.all([this.loadTasks(), this.loadOpen(), this.loadAttention()]); },
    // every task row is normalised once: null/undefined text fields become '', and a row that is not an object becomes a visible "פריט פגום" placeholder (logged), so the list always renders
    normTasks(list) {
      if (!Array.isArray(list)) return [];
      const str = (v) => (v === null || v === undefined ? '' : String(v));
      return list.map((t, i) => {
        if (!t || typeof t !== 'object' || t.id === undefined || t.id === null) { console.error('bad task row', i, t); return { id: -1 - i, _bad: true, title: 'פריט פגום', project: '', requester: '', assignee: null, status: '', priority_sort: 9, status_closed: 0, due_date: null }; }
        return { ...t, title: str(t.title), description: str(t.description), project: str(t.project), requester: t.requester == null ? '' : str(t.requester), assignee: t.assignee == null ? null : str(t.assignee), status: str(t.status), due_date: typeof t.due_date === 'string' && t.due_date ? t.due_date : null };
      });
    },
    async loadTasks() {
      const p = new URLSearchParams();
      const f = this.filters;
      p.set('open', '1'); // closed tasks live in the archive, not at the bottom of the list
      const fq = String(f.q || '').trim(); if (fq) p.set('q', fq);
      if (f.project) p.set('project', f.project);
      if (f.assignee) p.set('assignee', f.assignee);
      if (f.status) p.set('status', f.status);
      if (f.requester) p.set('requester', f.requester);
      this.tasks = this.normTasks(await this.api('GET', '/api/tasks' + (p.toString() ? '?' + p : '')));
    },
    async loadOpen() {
      this.openTasks = this.normTasks(await this.api('GET', '/api/tasks?open=1'));
      this.overdue = this.openTasks.filter((t) => t.due_date && t.due_date < todayISO()).sort((a, b) => a.due_date.localeCompare(b.due_date));
    },
    async loadAttention() { this.attention = await this.api('GET', '/api/attention?status=open'); },
    async loadDetail(quiet) {
      if (this.route.name !== 'task') return;
      const id = this.route.id;
      try {
        const d = await this.api('GET', '/api/tasks/' + id);
        if (this.route.id === id) this.detail = d;
      } catch (e) {
        if (!quiet) this.detailError = 'המשימה לא נמצאה';
      }
      if (!this.tasks.length && !quiet) await this.loadLists();
    },

    // ---------- formatting
    fmtDate(iso) { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; },
    fmtDateTime(iso) {
      if (!iso) return '';
      if (iso.length === 10) return this.fmtDate(iso);
      const p = jerusalemParts(new Date(iso));
      return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
    },
    dayOf(iso) {
      if (!iso) return '';
      if (iso.length === 10) return this.fmtDate(iso);
      const p = jerusalemParts(new Date(iso));
      return `${p.day}/${p.month}/${p.year}`;
    },
    fmtReceived(t) { return this.dayOf(t.source_date || t.created_at); },
    fmtReceivedFull(t) { return this.fmtDateTime(t.source_date || t.created_at); },
    offsetDate(n) {
      const [y, m, d] = todayISO().split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d + n));
      return dt.toISOString().slice(0, 10);
    },
    isLate(t) { return !!(t && t.due_date && !t.status_closed && t.due_date < todayISO()); },
    kindLabel(k) { return { reminder: 'תזכורת', question: 'שאלה', suggestion: 'הצעה' }[k] || ''; },
    roleLabel(r) { return { owner: 'בעלים', pm: 'מנהל פרויקט', assistant: 'עוזר', contact: 'איש קשר' }[r] || ''; },
    personLabel(p) { return p.role === 'assistant' ? 'אלכס · עוזר' : p.name_he; },
    partName(x) { const p = x.person_id && this.boot.people.find((q) => q.id === x.person_id); return p ? p.name_he : (x.name || x.email); },
    assigneeName(n) { return n; },
    assignees() { return this.boot.people.filter((p) => p.role !== 'contact'); },
    peopleGroups() {
      const ppl = this.boot.people;
      return [{ title: 'צוות', items: ppl.filter((p) => p.role !== 'contact') }, { title: 'אנשי קשר', items: ppl.filter((p) => p.role === 'contact') }].filter((g) => g.items.length);
    },
    openCountFor(p) { return this.openTasks.filter((t) => t.assignee_id === p.id).length; },
    hasFilters() { return !!(String(this.filters.q || '').trim() || this.activeChips().length); },
    activeChips() {
      const f = this.filters, out = [];
      const nm = (list, id) => (list.find((x) => x.id === id) || {}).name_he;
      if (f.project) out.push({ key: 'project', label: 'פרויקט: ' + nm(this.boot.projects, f.project) });
      if (f.assignee) out.push({ key: 'assignee', label: 'אחראי: ' + (f.assignee === 'none' ? 'ללא' : nm(this.boot.people, f.assignee)) });
      if (f.status) out.push({ key: 'status', label: 'סטטוס: ' + nm(this.boot.statuses, f.status) });
      if (f.requester) out.push({ key: 'requester', label: 'מאת: ' + (f.requester === 'none' ? 'ללא' : nm(this.boot.people, f.requester)) });
      return out;
    },
    async clearFilters() { Object.assign(this.filters, { project: null, assignee: null, status: null, requester: null }); await this.loadTasks(); },
    openList() { return this.tasks.filter((t) => !t.status_closed); },
    closedList() { return this.tasks.filter((t) => t.status_closed); },
    attnCount() { return this.overdue.length + this.attention.length; },
        describe(e) {
      const dsrc = { explicit: 'מפורש', estimated: 'משוער', manual: 'ידני' };
      const v = (f, x) => (x === null || x === undefined || x === '' ? 'ריק' : f === 'due_date' ? this.fmtDate(x) : f === 'source_date' ? this.fmtDateTime(x) : f === 'due_source' ? dsrc[x] || x : x);
      if (e.action === 'create') return 'יצר את המשימה';
      if (e.action === 'note') return 'הוסיף הערה';
      if (e.action === 'draft') return 'הוסיף טיוטה';
      if (e.action === 'update') {
        const l = FIELD_LABELS[e.field] || 'שדה';
        if (e.field === 'description') return 'עדכן את התיאור';
        return `שינה את ${l} מ־"${v(e.field, e.old_value)}" ל־"${v(e.field, e.new_value)}"`;
      }
      return 'עדכן את המשימה';
    },

    // ---------- filters / navigation helpers
    async setFilter(k, v) { this.filters[k] = v; await this.loadTasks(); },
    filterByProject(id) { this.filters = { q: '', project: id, assignee: null, status: null, requester: null, group: this.filters.group }; this.go('/'); },
    filterByAssignee(id) { this.filters = { q: '', project: null, assignee: id, status: null, requester: null, group: this.filters.group }; this.go('/'); },
    openTask(id) {
      if (this.route.name === 'task' && this.route.id === id) return this.closeTask();
      if (this.route.name === 'home') this.listScroll = window.scrollY;
      return this.go('/task/' + id);
    },
    closeTask() { return this.go('/'); },

    // ---------- task actions
    async quickAdd() {
      const title = this.quickTitle.trim();
      if (!title) return;
      const body = { title };
      if (this.filters.project) body.project = this.filters.project;
      if (typeof this.filters.assignee === 'number') body.assignee = this.filters.assignee;
      try {
        await this.api('POST', '/api/tasks', body);
        this.quickTitle = '';
        this.toast('המשימה נוספה');
        await Promise.all([this.loadLists(), this.loadBoot()]);
      } catch (e) { this.fail(e); }
    },
    // marking a task done: the circle fills and the check draws in, a soft green flash crosses the row, a few small particles, then the row collapses and leaves the list (done tasks live in the archive).
    // A 5-second "ביטול" brings it back. prefers-reduced-motion: no animation at all, just the state change and the toast. The list is edited in place, so the scroll position never moves.
    reducedMotion() { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } },
    burst(btn) {
      if (!btn || !btn.animate) return;
      const r = btn.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2; const colors = ['#22c55e', '#16a34a', '#86efac', '#f59e0b', '#38bdf8'];
      for (let i = 0; i < 8; i++) {
        const el = document.createElement('span'); const ang = (Math.PI * 2 * i) / 8 + Math.random() * 0.5; const dist = 22 + Math.random() * 16;
        el.style.cssText = `position:fixed;left:${cx}px;top:${cy}px;width:5px;height:5px;border-radius:50%;background:${colors[i % colors.length]};pointer-events:none;z-index:90`;
        document.body.appendChild(el);
        el.animate([{ transform: 'translate(-50%,-50%) scale(1)', opacity: 1 }, { transform: `translate(calc(-50% + ${Math.cos(ang) * dist}px), calc(-50% + ${Math.sin(ang) * dist}px)) scale(.4)`, opacity: 0 }], { duration: 600, easing: 'cubic-bezier(.2,.7,.3,1)' }).onfinish = () => el.remove();
      }
    },
    async animateDone(row, btn) {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      row.classList.add('done-anim'); this.burst(btn); await wait(520);
      const cs = getComputedStyle(row.parentElement); const gap = parseFloat(cs.rowGap) || 0;
      row.style.height = row.offsetHeight + 'px'; void row.offsetHeight; row.classList.add('collapsing'); row.style.height = '0px'; if (gap) row.style.marginBottom = `-${gap}px`;
      await wait(360);
    },
    async toggleDone(t, ev) {
      if (!t || t._bad) return;
      const closing = !t.status_done;
      const target = closing ? this.boot.statuses.find((s) => s.is_done) : this.boot.statuses.find((s) => !s.is_closed);
      const prev = t.status_id;
      const btn = ev && ev.currentTarget; const row = btn && btn.closest ? btn.closest('.row') : null;
      try {
        const call = this.api('PATCH', '/api/tasks/' + t.id, { status: target.id });
        if (closing && row && !this.reducedMotion()) await this.animateDone(row, btn);
        await call;
        if (closing) {
          this.tasks = this.tasks.filter((x) => x.id !== t.id); this.openTasks = this.openTasks.filter((x) => x.id !== t.id);
          this.doneUndo = { id: t.id, prev, title: t.title }; clearTimeout(this._doneT); this._doneT = setTimeout(() => { this.doneUndo = null; }, 5000);
        }
        Promise.all([this.loadLists(), this.loadBoot()]).catch(() => {});
        if (this.route.id === t.id) await this.loadDetail(true);
      } catch (e) { if (row) { row.classList.remove('done-anim', 'collapsing'); row.style.height = ''; row.style.marginBottom = ''; } this.fail(e); }
    },
    async undoDoneNow() {
      const u = this.doneUndo; if (!u) return; this.doneUndo = null; clearTimeout(this._doneT);
      try {
        await this.api('PATCH', '/api/tasks/' + u.id, { status: u.prev });
        this.enterId = u.id; await Promise.all([this.loadLists(), this.loadBoot()]); setTimeout(() => { this.enterId = null; }, 800);
      } catch (e) { this.fail(e); }
    },
    async save(field, val, ev) {
      const body = {};
      if (['status', 'priority', 'project'].includes(field)) body[field] = +val;
      else if (field === 'assignee' || field === 'requester') body[field] = val === '' ? null : +val;
      else body[field] = val;
      try {
        await this.api('PATCH', '/api/tasks/' + this.detail.id, body);
        this.toast('נשמר');
        await Promise.all([this.loadDetail(true), this.loadLists(), this.loadBoot()]);
      } catch (e) {
        this.fail(e);
        if (ev && ev.target && field in this.detail) ev.target.value = this.detail[field];
        else if (ev && ev.target) ev.target.value = this.detail[field + '_id'] ?? '';
      }
    },
    parseDateInput(s) {
      s = (s || '').trim();
      if (!s) return '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      let m = /^(\d{1,2})[/.](\d{1,2})$/.exec(s);
      if (m) return `${m[1]}/${m[2]}/${todayISO().slice(0, 4)}`;
      return s;
    },
    async saveDue(raw, ev) {
      const val = this.parseDateInput(raw);
      try {
        await this.api('PATCH', '/api/tasks/' + this.detail.id, { due_date: val === '' ? null : val });
        this.toast('נשמר');
        await Promise.all([this.loadDetail(true), this.loadLists()]);
      } catch (e) {
        this.fail(e);
        if (ev && ev.target) ev.target.value = this.fmtDate(this.detail.due_date);
      }
    },
    async saveReceived(raw, ev) {
      const v = (raw || '').trim();
      try {
        await this.api('PATCH', '/api/tasks/' + this.detail.id, { source_date: v === '' ? null : v });
        this.toast('נשמר');
        await Promise.all([this.loadDetail(true), this.loadLists()]);
      } catch (e) {
        this.fail(e);
        if (ev && ev.target) ev.target.value = this.fmtReceivedFull(this.detail);
      }
    },
    // ---- deleting moves things to the RECYCLE BIN: a short "הועבר לסל · בטל" bar after the owner's own deletion; destructive requests from the assistant arrive as a
    // confirmation with two buttons (its card then offers "שחזר"); permanent deletion only inside the bin (/trash) and by expiry (Settings, trash_days)
    purgeLeft() { void this.purgeTick; return this.purgeUndo ? Math.max(0, Math.ceil((this.purgeUndo.until - Date.now()) / 1000)) : 0; },
    startPurgeTimer() { if (this._pt) return; this._pt = setInterval(() => { this.purgeTick++; if (!this.purgeLeft()) { clearInterval(this._pt); this._pt = null; } }, 1000); },
    showBinBar(r, title) { if (!r || !r.trash_id) return; this.purgeUndo = { token: r.trash_id, title: title || r.title || '', until: Date.now() + 12000 }; this.startPurgeTimer(); },
    binKeepText() { const d = this.boot && this.boot.trash_days !== undefined ? +this.boot.trash_days : 60; return d > 0 ? `אפשר לשחזר מהסל במשך ${d} ימים.` : 'אפשר לשחזר מהסל.'; },
    confirmDone(c) { const r = c && c.result; if (!r) return 'בוצע.'; if (r.trash_id) return this.restoredBins[r.trash_id] ? 'הועבר לסל ושוחזר.' : 'הועבר לסל.'; if (r.purged !== undefined) return 'נמחק סופית.'; return 'בוצע.'; },
    canRestore(c) { return !!(c && c.status === 'yes' && c.result && c.result.trash_id && !this.restoredBins[c.result.trash_id]); },
    async confirmPurge() {
      const t = this.purgeDlg?.t; if (!t) return;
      try { const r = await this.api('DELETE', '/api/tasks/' + t.id); this.purgeDlg = null; this.showBinBar(r); this.go('/'); await Promise.all([this.loadLists(), this.loadBoot()]); } catch (e) { this.fail(e); }
    },
    async undoPurge(x) {
      const id = x && (x.token || x.trash_id || (x.result && x.result.trash_id)); if (!id) return;
      try {
        const r = await this.api('POST', `/api/trash/${id}/restore`, {}); this.restoredBins[id] = true; this.purgeUndo = null;
        this.toast((r.renamed ? 'שוחזר בשם: ' : 'שוחזר: ') + r.title);
        await Promise.all([this.loadLists(), this.loadBoot(), this.loadChat(), this.route.name === 'trash' ? this.loadBin() : null, this.route.name === 'settings' && this.loadFilters ? this.loadFilters() : null]);
      } catch (e) { this.fail(e); }
    },
    // ---- the recycle bin page
    async loadBin() { this.bin.loading = true; try { const r = await this.api('GET', '/api/trash'); Object.assign(this.bin, r, { loading: false }); if (this.bin.kind && !this.bin.counts[this.bin.kind]) this.bin.kind = ''; } catch (e) { this.bin.loading = false; this.fail(e); } },
    binKinds() { return ['task', 'project', 'person', 'protocol', 'calendar', 'chat', 'filter', 'email'].filter((k) => this.bin.counts[k]); },
    binKindPl(k) { return { task: 'משימות', project: 'פרויקטים', person: 'אנשים', protocol: 'פרוטוקולים', calendar: 'יומן', chat: 'הודעות', filter: 'כללי דואר', email: 'מיילים' }[k] || k; },
    binItems() { return this.bin.kind ? this.bin.items.filter((x) => x.kind === this.bin.kind) : this.bin.items; },
    binLeftText(it) { const n = it.days_left; if (n === null || n === undefined) return 'לא יימחק אוטומטית'; if (n <= 0) return 'יימחק סופית הלילה'; if (n === 1) return 'יימחק סופית מחר'; return `יימחק סופית בעוד ${n} ימים`; },
    async restoreBin(it) { await this.undoPurge({ trash_id: it.id }); },
    async destroyBin(it) {
      if (!(await this.ask(`למחוק סופית את "${this.clipText(it.title, 80)}"? אי אפשר לשחזר אחרי זה.`, 'מחק סופית'))) return;
      try { await this.api('DELETE', '/api/trash/' + it.id); this.toast('נמחק סופית'); await Promise.all([this.loadBin(), this.loadBoot()]); } catch (e) { this.fail(e); }
    },
    async emptyBin() {
      if (!(await this.ask(`לרוקן את הסל? ${this.bin.total} פריטים יימחקו סופית, ואי אפשר לשחזר אותם.`, 'רוקן את הסל'))) return;
      try { const r = await this.api('POST', '/api/trash/empty', {}); this.toast(`הסל רוקן (${r.purged} פריטים)`); await Promise.all([this.loadBin(), this.loadBoot()]); } catch (e) { this.fail(e); }
    },
    async answerConfirm(m, yes) {
      try {
        const r = await this.api('POST', `/api/confirm/${m.confirm.id}/answer`, { yes });
        await this.loadChat(); await Promise.all([this.loadLists(), this.loadBoot()]);
        if (r.status === 'yes' && this.route.name === 'projects' && this.route.id && !this.boot.projects.some((p) => p.id === this.route.id)) this.go('/projects');
        if (r.status === 'yes' && this.route.name === 'protocols' && this.route.id) { try { await this.loadProtocol(this.route.id); } catch (e) { this.go('/protocols'); } await this.loadProtocols(); }
      } catch (e) { this.fail(e); }
    },
    // ---- bulk proposals (task merges / closures, people cleanup): approve all, selected, or one by one
    async loadProposals(id) { try { this.proposalCards[id] = await this.api('GET', '/api/proposals/' + id); } catch (e) { /* not available */ } },
    selectProposals(id, on) { for (const it of (this.proposalCards[id]?.items || [])) if (it.status === 'open') this.propSel[it.id] = on; },
    async approveProposals(id, selectedOnly = false) {
      const ids = selectedOnly ? (this.proposalCards[id]?.items || []).filter((it) => it.status === 'open' && this.propSel[it.id]).map((it) => it.id) : null;
      if (selectedOnly && !ids.length) { this.toast('לא סומנו הצעות'); return; }
      try { this.proposalCards[id] = await this.api('POST', `/api/proposals/${id}/approve`, ids ? { ids } : {}); this.toast('בוצע'); await Promise.all([this.loadBoot(), this.route.name === 'home' ? this.loadLists() : Promise.resolve()]); } catch (e) { this.fail(e); }
    },
    async decideProposal(it, action, project) {
      try { await this.api('POST', '/api/proposals/item/' + it.id, { action, project }); await this.loadProposals(it.batch); if (it.pq_project) await Promise.all([this.loadBoot(), this.route.name === 'home' ? this.loadLists() : Promise.resolve()]); } catch (e) { this.fail(e); }
    },
    // ---- edit / delete chat messages
    startEdit(m) { this.msgMenu = null; this.editing = { id: m.id, text: m.text }; },
    cancelEdit() { this.editing = null; },
    async refreshAfterEdit() {
      await this.loadChat();
      if (this.route.name === 'task' && this.detail) { await this.loadDetail(true); }
      this.pollNow();
    },
    async saveEdit() {
      const e = this.editing; if (!e) return;
      const text = e.text.trim(); if (!text) return;
      try {
        const r = await this.api('PATCH', '/api/chat/' + e.id, { text });
        this.editing = null; this.awaitingId = e.id; this._awaitSince = Date.now();
        this.toast(r.undone ? `נערך. ביטלתי ${r.undone} פעולות קודמות ואלכס חושב מחדש` + (r.skipped && r.skipped.length ? ` (${r.skipped.length} לא ניתנו לביטול)` : '') : 'נערך. אלכס חושב מחדש');
        await this.refreshAfterEdit();
      } catch (err) { this.fail(err); }
    },
    askDelete(m) { this.msgMenu = null; this.delDlg = { m, undo: m.author === 'owner' }; },
    async confirmDelete() {
      const d = this.delDlg; if (!d) return;
      try {
        const r = await this.api('DELETE', `/api/chat/${d.m.id}?undo=${d.m.author === 'owner' && d.undo ? 1 : 0}`);
        this.delDlg = null;
        this.showBinBar(r, this.clipText(d.m.text || 'הודעה', 60) + (r.undone ? ` (בוטלו ${r.undone} פעולות)` : ''));
        await this.refreshAfterEdit();
      } catch (err) { this.fail(err); }
    },
    // ---- task-scoped chat (the "שיחה על המשימה" block of the card): the thread, the assistant's actions and the old notes in one chronological list
    taskConv() {
      const d = this.detail; if (!d) return [];
      const items = [
        ...(d.thread || []).map((m) => ({ key: 'm' + m.id, type: 'msg', at: m.created_at, m })),
        ...(d.notes || []).map((n) => ({ key: 'n' + n.id, type: 'note', at: n.created_at, n })),
      ]; // ONLY the conversation: his messages, the assistant's replies, the notes. Field changes and system events live in the history at the bottom of the card.
      return items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    },
    setChatTaskMsgs(on) { this.chatTaskMsgs = on; try { localStorage.setItem('chatScopedMsgs', on ? '1' : '0'); } catch (e) {} if (on) this.scrollFeed(); },
    // a message that arrives with a missing field must never break the whole list: every message is normalised once, and the view never throws
    normMsg(m) { if (!m || typeof m !== 'object') return null; m.files = Array.isArray(m.files) ? m.files : []; m.tasks = Array.isArray(m.tasks) ? m.tasks : []; m.refs = m.refs && typeof m.refs === 'object' ? m.refs : { task: {}, projects: {}, email: {} }; m.text = m.text == null ? '' : String(m.text); return m; },
    // the MAIN chat: unscoped messages (plus answers to a conversation the owner started in Telegram); scoped conversations only when the toggle is on
    isMainMsg(m) { return !!m && (!m.scope || !!m.in_main); },
    chatView() { try { const all = Array.isArray(this.chatMsgs) ? this.chatMsgs : []; return all.filter((m) => m && (this.chatTaskMsgs || this.isMainMsg(m))); } catch (e) { return []; } },
    scrollTaskFeed() { this.$nextTick(() => { const f = this.$refs.tcfeed || document.querySelector('.tc-feed'); if (f) f.scrollTop = f.scrollHeight; }); },
    // ENTITY-SCOPED chat (project / person / protocol / calendar day): the same thread component as the task chat; the ref is e.g. 'project:5'
    scMsgs(ref) { return (this.chatMsgs || []).filter((m) => m && m.scope === 'entity' && m.scope_ref === ref); },
    scScroll() { this.$nextTick(() => document.querySelectorAll('.sc-feed').forEach((f) => { f.scrollTop = f.scrollHeight; })); },
    async scLoad(ref) {
      if (!ref || /(null|undefined|NaN)$/.test(String(ref))) return;
      try { const list = await this.api('GET', '/api/chat/scope/' + ref.replace(':', '/')); let add = 0; for (const m of list) { if (!this.chatMsgs.some((x) => x.id === m.id)) { this.normMsg(m); this.chatMsgs.push(m); add++; } } if (add) { this.chatMsgs.sort((a, b) => (a.pos || a.id) - (b.pos || b.id)); this.lastMsgId = Math.max(this.lastMsgId, ...this.chatMsgs.map((m) => m.id)); } } catch (e) { /* the thread is optional */ }
    },
    async scSend(ref) {
      const text = this.sc.text.trim(); if (!text || this.sc.sending) return;
      this.sc.sending = true;
      try {
        const m = await this.api('POST', '/api/chat', { text, entity_scope: ref });
        this.sc.text = ''; document.querySelectorAll('.sc-chat .tc-in').forEach((el) => { el.style.height = 'auto'; });
        this.normMsg(m);
        if (!this.chatMsgs.some((x) => x.id === m.id)) { this.chatMsgs.push(m); this.lastMsgId = Math.max(this.lastMsgId, m.id); }
        this.sc.waiting = ref; this.awaitingId = m.id; this._awaitSince = Date.now(); this.scScroll(); this.pollNow();
      } catch (e) { this.fail(e); }
      this.sc.sending = false;
    },
    async sendTaskChat() {
      const text = this.tcText.trim();
      if (this.uploading()) { this.toast('ממתינים לסיום העלאת הקבצים'); return; }
      const files = this.chatFiles.filter((f) => f.done);
      if (this.tcSending || (!text && !files.length) || !this.detail) return;
      this.tcSending = true;
      try {
        const m = await this.api('POST', '/api/chat', { text, file_ids: files.map((f) => f.id), task_scope: this.detail.id });
        this.tcText = ''; this.chatFiles = []; this.chatTask = null;
        document.querySelectorAll('.tc-in').forEach((el) => { el.style.height = 'auto'; });
        this.normMsg(m);
        if (m.id > this.lastMsgId && !this.chatMsgs.some((x) => x.id === m.id)) { this.chatMsgs.push(m); this.lastMsgId = m.id; }
        this.detail.thread = [...(this.detail.thread || []), m];
        this.awaitingId = m.id; this._awaitSince = Date.now();
        this.scrollTaskFeed(); this.pollNow();
      } catch (e) { this.fail(e); }
      this.tcSending = false;
    },
    async addNote() {
      const text = this.noteText.trim();
      if (!text) return;
      try {
        await this.api('POST', `/api/tasks/${this.detail.id}/notes`, { text });
        this.noteText = '';
        this.toast('ההערה נוספה');
        await this.loadDetail(true);
      } catch (e) { this.fail(e); }
    },
    async setAttention(a, status) {
      try { await this.api('PATCH', '/api/attention/' + a.id, { status }); await this.loadAttention(); } catch (e) { this.fail(e); }
    },

    // ---------- projects
    toggleEdit(key, obj) {
      if (this.editing === key) { this.editing = null; return; }
      this.editing = key; this.mergeInto = '';
      if (key[0] === 'p') this.form = { name: obj.name_he, aliases: obj.aliases.join(', '), description: obj.description, status: obj.status, color: obj.color };
      else this.form = { name: obj.name_he, name_en: obj.name_en || '', role: obj.role, emails: obj.emails.join(', '), notes: obj.notes };
    },
    async addProject() {
      const name = this.newProject.trim();
      if (!name) return;
      try {
        const p = await this.api('POST', '/api/projects', { name });
        this.newProject = ''; this.showNewProj = false; this.toast('הפרויקט נוסף'); await this.loadBoot(); this.go('/projects/' + p.id);
      } catch (e) { this.fail(e); }
    },
    // the project settings dialog: focus moves into it, Tab stays inside, Esc closes, focus returns to the button
    closeMenu() { this._escGuard = Date.now(); this.menuOpen = false; const o = this._menuOpener; this._menuOpener = null; if (o && o.focus) o.focus(); },
    trapTab(ev) {
      if (!this.menuOpen) return;
      const box = this.$refs.pmenu; if (!box) return;
      const f = [...box.querySelectorAll('button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((e) => e.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
      else if (!box.contains(document.activeElement)) { ev.preventDefault(); first.focus(); }
    },
    toggleMenu(ev) {
      if (this.menuOpen) return this.closeMenu();
      this._menuOpener = (ev && ev.currentTarget) || document.activeElement;
      this.menuOpen = true;
      this.$nextTick(() => { const i = this.$refs.pmenu && this.$refs.pmenu.querySelector('input'); if (i) i.focus(); });
      if (this.menuOpen) { const p = this.pp.project; this.mergeInto = ''; this.form = { name: p.name_he, aliases: p.aliases.join(', '), status: p.status, color: p.color }; }
    },
    async saveProject(p) {
      try {
        await this.api('PATCH', '/api/projects/' + p.id, { name: this.form.name, aliases: this.form.aliases, status: this.form.status, ...(p.is_default ? {} : { color: this.form.color }) });
        this.toast('נשמר'); this.menuOpen = false; await this.loadBoot(); await this.loadProjectPage(p.id);
      } catch (e) { this.fail(e); }
    },
    async mergeProject(p) {
      const into = this.boot.projects.find((x) => x.id === +this.mergeInto);
      if (!into) return;
      const ok = await this.ask(`למזג את "${p.name_he}" לתוך "${into.name_he}"? כל המשימות והמידע יועברו והפרויקט "${p.name_he}" יימחק.`, 'מיזוג');
      if (!ok) return;
      try {
        const r = await this.api('POST', `/api/projects/${p.id}/merge`, { into: into.id });
        this.toast(`המיזוג הושלם, ${r.moved_tasks} משימות הועברו`);
        this.menuOpen = false;
        if (this.filters.project === p.id) this.filters.project = null;
        await this.loadBoot(); this.go('/projects/' + into.id);
      } catch (e) { this.fail(e); }
    },
    async saveSummary(v) {
      try { await this.api('PATCH', '/api/projects/' + this.pp.project.id, { summary: v }); this.toast('נשמר'); await this.loadProjectPage(this.pp.project.id, true); } catch (e) { this.fail(e); }
    },
    async loadProjectPage(id, quiet) {
      try {
        const d = await this.api('GET', `/api/projects/${id}/page`);
        if (this.route.name === 'projects' && this.route.id === id) { this.pp = d; this.ppErr = ''; try { localStorage.setItem('lastProject', String(id)); } catch (e) {} }
      } catch (e) { if (!quiet) { this.pp = null; this.ppErr = 'הפרויקט לא נמצא'; } }
    },
    openProject(id) { this.ppSearch = { q: '', results: [] }; this.pjFq = ''; this.pjEdit = null; this.pjMore = {}; this.pjHist = false; this.pjSumOpen = false; this.go('/projects/' + id); },
    // ---------- project page: passport, latest status per process, facts by topic
    pjIsEditing(kind, key) { return !!this.pjEdit && this.pjEdit.kind === kind && this.pjEdit.key === key; },
    pjStartEdit(kind, key, value) { this.pjEdit = { kind, key, value: value || '' }; },
    async pjSave() {
      const e = this.pjEdit; if (!e || !this.pp) return;
      const pid = this.pp.project.id;
      try {
        if (e.kind === 'field') await this.api('POST', `/api/projects/${pid}/profile`, { [e.key]: e.value.trim() });
        else await this.api('POST', `/api/projects/${pid}/status`, { process: e.key, text: e.value.trim() });
        this.pjEdit = null; this.toast('נשמר'); await this.loadProjectPage(pid, true);
      } catch (x) { this.fail(x); }
    },
    pjFieldText(f) { if (!f.value) return ''; if (f.field === 'floors' && /^\d+(, \d+)*$/.test(String(f.value))) { const a = String(f.value).split(', '); return a.length > 1 ? a.slice(0, -1).join(', ') + ' ו-' + a[a.length - 1] : a[0]; } return f.value; },
    pjStatuses() { const all = (this.pp && this.pp.profile ? this.pp.profile.statuses : []); return all.filter((s) => s.value || this.pjIsEditing('status', s.process)); },
    pjMissingProcesses() { const all = (this.pp && this.pp.profile ? this.pp.profile.statuses : []); return all.filter((s) => !s.value && !this.pjIsEditing('status', s.process)); },
    pjGroups() {
      if (!this.pp) return [];
      const q = this.pjFq.trim().toLowerCase();
      const hit = (f) => !q || `${f.key} ${f.value}`.toLowerCase().includes(q);
      const rows = [...(this.pp.facts || []), ...(this.pjHist ? (this.pp.facts_history || []) : [])].filter(hit);
      const T = this.pp.topics || {};
      return Object.keys(T).map((t) => ({ topic: t, label: T[t], items: rows.filter((f) => (f.topic || 'other') === t).sort((a, b) => String(b.as_of_date).localeCompare(String(a.as_of_date)) || (a.superseded_by ? 1 : 0) - (b.superseded_by ? 1 : 0)) })).filter((g) => g.items.length);
    },
    pjLimit(t) { return this.pjFq.trim() ? 1000 : (this.pjMore[t] || 8); },
    pjShown(g) { return g.items.slice(0, this.pjLimit(g.topic)); },
    pjClosed(t) { return !this.pjFq.trim() && !!this.pjClosedMap[t]; },
    pjToggleGroup(t) { this.pjClosedMap = { ...this.pjClosedMap, [t]: !this.pjClosedMap[t] }; try { localStorage.setItem('pjClosed', JSON.stringify(this.pjClosedMap)); } catch (e) { /* private mode */ } },
    pjSender(v) { return String(v || '').replace(/<[^>]*>/g, '').replace(/["']/g, '').trim(); },
    pjLate(t) { return !!t.due_date && t.due_date < todayISO(); },
    pjTopTasks() {
      const today = todayISO();
      const score = (t) => [t.due_date && t.due_date < today ? 0 : 1, t.priority_sort || 9, t.due_date || '9999-99-99', -t.id];
      return [...(this.pp ? this.pp.tasks : [])].sort((a, b) => { const x = score(a), y = score(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; }).slice(0, 5);
    },
    srcIcon(type) {
      const P = { email: '<path d="M4 6h16v12H4z"/><path d="M4 7l8 6 8-6"/>', file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
        protocol: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v3H9z"/><path d="M8.5 11h7M8.5 15h5"/>', chat: '<path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l.9-4.4A8 8 0 1 1 20 12z"/>',
        owner: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>', manual: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>' };
      return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[type] || P.manual}</svg>`;
    },
    srcClick(ev, s) {
      if (!s || !s.link) { if (s && s.type === 'chat') { ev.preventDefault(); this.openChat(); } else ev.preventDefault(); return; }
      if (s.type === 'file') { ev.preventDefault(); window.open(s.link, '_blank', 'noopener'); return; }
      ev.preventDefault(); this.go(s.link);
    },
    filteredProjects() {
      const q = this.projQ.trim().toLowerCase();
      return this.boot.projects.filter((p) => !q || p.name_he.toLowerCase().includes(q) || p.aliases.some((a) => a.toLowerCase().includes(q)));
    },
    async addKnowledge() {
      const body = this.kNote.trim();
      if (!body) return;
      try {
        await this.api('POST', '/api/knowledge', { project: this.pp.project.id, kind: 'note', title: this.clipText(body.split('\n')[0], 80), body });
        this.kNote = ''; this.toast('נוסף'); await this.loadProjectPage(this.pp.project.id, true);
      } catch (e) { this.fail(e); }
    },
    async uploadFiles(list, project) {
      const saved = [];
      for (const f of Array.from(list || [])) {
        try {
          if (f.size > 30 * 1024 * 1024) { saved.push(await this.uploadBig(f, project)); continue; }
          const fd = new FormData(); fd.append('file', f); if (project) fd.append('project', project);
          const res = await fetch('/api/files', { method: 'POST', headers: { 'X-Mesimot': '1' }, body: fd, credentials: 'same-origin' });
          if (res.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return saved; }
          const d = await res.json().catch(() => ({}));
          if (!res.ok) { this.toast(d.error || 'ההעלאה נכשלה', true); continue; }
          for (const x of d) {
            if (x.text_status === 'unsupported') this.toast(`הקובץ "${x.original_name}" נשמר, אך לא ניתן היה לקרוא את תוכנו`, true);
            else if (x.text_status === 'empty') this.toast(`הקובץ "${x.original_name}" נשמר, אך לא נמצא בו טקסט`, true);
          }
          saved.push(...d);
        } catch (e) { this.toast(e.message || 'ההעלאה נכשלה', true); }
      }
      return saved;
    },
    // big files: chunks of 32 MB (the tunnel caps one request), a progress bar, a retry per chunk, and a resume after a network drop
    async uploadBig(f, project, opts = {}) {
      // opts.chip: a chat attachment chip that shows the progress itself (no global panel); opts.signal: cancel; opts.task: link the file to a task
      const u = opts.chip || { id: Math.random().toString(36).slice(2), name: f.name, pct: 0, text: 'מתחיל…', done: false, error: false };
      if (!opts.chip) this.uploads.push(u);
      const cancelled = () => { if (opts.signal && opts.signal.aborted) throw new Error('ההעלאה בוטלה'); };
      const mb = (n) => Math.round(n / 1048576).toLocaleString('he-IL');
      const call = async (method, url, body, headers = {}) => {
        cancelled();
        const res = await fetch(url, { method, headers: { 'X-Mesimot': '1', ...headers }, body, credentials: 'same-origin', signal: opts.signal });
        if (res.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); throw new Error('נדרשת התחברות'); }
        const d = await res.json().catch(() => ({}));
        if (!res.ok) { const e = new Error(d.error || 'ההעלאה נכשלה'); e.status = res.status; throw e; }
        return d;
      };
      const waitOnline = () => (navigator.onLine ? Promise.resolve() : new Promise((r) => window.addEventListener('online', r, { once: true })));
      try {
        const start = await call('POST', '/api/uploads', JSON.stringify({ name: f.name, size: f.size, mime: f.type || null, project: project || null, task: opts.task || null, last_modified: f.lastModified }), { 'Content-Type': 'application/json' });
        const have = new Set(start.received);
        if (start.resumed && have.size) u.text = `ממשיך מהמקום שבו נעצר (${have.size} מתוך ${start.chunks} חלקים כבר בשרת)…`;
        const h = new Sha256();
        for (let i = 0; i < start.chunks; i++) {
          cancelled();
          const buf = new Uint8Array(await f.slice(i * start.chunk_size, Math.min(f.size, (i + 1) * start.chunk_size)).arrayBuffer());
          h.update(buf);
          if (!have.has(i)) {
            let sum = null;
            try { sum = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)), (x) => x.toString(16).padStart(2, '0')).join(''); } catch (e) { /* no subtle crypto */ }
            for (let attempt = 1; ; attempt++) {
              try { await waitOnline(); await call('PUT', `/api/uploads/${start.id}/${i}`, buf, { 'Content-Type': 'application/octet-stream', ...(sum ? { 'X-Chunk-Sha256': sum } : {}) }); break; }
              catch (e) {
                if (e.status && e.status < 500 && e.status !== 408 && e.status !== 429 && e.status !== 400) throw e;
                if (attempt >= 8) throw new Error('החיבור נותק והעלאה לא הצליחה. אפשר לבחור את אותו קובץ שוב והיא תמשיך מהמקום שבו נעצרה');
                u.text = `בעיית חיבור, מנסה שוב (${attempt}/8)…`; await new Promise((r) => setTimeout(r, Math.min(1500 * attempt, 10000)));
              }
            }
          }
          u.pct = Math.round(((i + 1) / start.chunks) * 100);
          u.text = `מעלה… ${u.pct}% (${mb(Math.min(f.size, (i + 1) * start.chunk_size))} מתוך ${mb(f.size)} מ״ב)`;
        }
        u.text = 'מאמת ומעבד בשרת…'; u.pct = 100;
        const sha = h.hex();
        let done;
        for (let attempt = 1; ; attempt++) {
          try { await waitOnline(); done = await call('POST', `/api/uploads/${start.id}/complete`, JSON.stringify({ sha256: sha }), { 'Content-Type': 'application/json' }); break; }
          catch (e) { if (e.status || attempt >= 4) throw e; u.text = 'בעיית חיבור, בודק שוב…'; await new Promise((r) => setTimeout(r, 3000 * attempt)); }
        }
        u.done = true; u.text = done.background ? 'הועלה. הקובץ גדול, הטקסט שלו נקרא ברקע.' : 'הועלה.';
        if (!opts.chip) { this.toast(done.background ? `הקובץ "${f.name}" הועלה. הטקסט שלו נקרא ברקע` : `הקובץ "${f.name}" הועלה`); setTimeout(() => { this.uploads = this.uploads.filter((x) => x.id !== u.id); }, 6000); }
        return done;
      } catch (e) {
        u.error = true; u.done = true; u.text = e.message || 'ההעלאה נכשלה';
        throw e;
      }
    },
    async uploadToProject(list) {
      try {
        const saved = await this.uploadFiles(list, this.pp.project.id);
        if (saved.length) { this.toast('הקובץ הועלה. אלכס יעבד אותו'); await this.loadProjectPage(this.pp.project.id, true); this.pollNow(); }
      } catch (e) { this.fail(e); }
    },
    async searchInProject() {
      const q = this.ppSearch.q.trim();
      if ([...q].length < 3) { this.ppSearch.results = []; return; }
      try { this.ppSearch.results = (await this.api('GET', '/api/search?limit=20&project=' + this.pp.project.id + '&q=' + encodeURIComponent(q))).results; } catch (e) { this.ppSearch.results = []; }
    },
    // email header block: sender (marked), to, cc, date and exact time; several messages newest first
    // the emails linked to the open task, the latest first (the source email alone when nothing else is linked)
    mailList() {
      const d = this.detail; if (!d) return [];
      const list = (d.correspondence || []).map((c) => ({ id: c.email_id, subject: c.subject, date: c.date }));
      if (d.source_email_id && !list.some((x) => x.id === d.source_email_id)) list.push({ id: d.source_email_id, subject: d.email && (d.email.original_subject || d.email.subject), date: d.email && d.email.received_at });
      return list;
    },
    mailHeadHtml(e) {
      if (!e) return '';
      const esc = (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const people = e.people || {};
      const who = (name, email) => {
        const known = email && people[email.toLowerCase()];
        const label = (known ? known.name_he : '') || name || email || '';
        return `<span class="mh-p"><b>${esc(label)}</b>${email && email !== label ? ` <bdi dir="ltr" class="mh-mail">${esc(email)}</bdi>` : ''}</span>`;
      };
      let thread = e.thread && e.thread.length ? e.thread : null;
      if (!thread && (e.from || e.forwarded_from)) {
        const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(e.from || e.forwarded_from || '');
        thread = [{ index: 0, from_name: m ? m[1] : (e.from || e.forwarded_from), from_email: m ? m[2] : '', date: e.date || e.forwarded_date, to: [], cc: [] }];
      }
      if (!thread) return '';
      const stamp = (d) => (d ? this.fmtDateTime(d) : 'לא ידוע');
      const msg = (m, i) => {
        const to = (m.to || []).map((x) => who(x.name, x.email)).join(' ');
        const cc = (m.cc || []).map((x) => who(x.name, x.email)).join(' ');
        const rows = `<div class="mh-row"><span class="mh-k">מאת</span>${who(m.from_name, m.from_email)} <span class="mh-tag">שולח</span></div>
          <div class="mh-row"><span class="mh-k">תאריך ושעה</span><b>${stamp(m.date)}</b></div>
          ${to ? `<div class="mh-row"><span class="mh-k">אל</span><span class="mh-list">${to}</span></div>` : ''}
          ${cc ? `<div class="mh-row"><span class="mh-k">עותק</span><span class="mh-list">${cc}</span></div>` : ''}`;
        if (i === 0) {
          const nm = (x) => { const known = x.email && people[String(x.email).toLowerCase()]; return (known ? known.name_he : '') || x.name || x.email || ''; };
          const toN = (m.to || []).map(nm).filter(Boolean); const ccN = (m.cc || []).filter((x) => nm(x)).length;
          const line = [`מאת ${esc(m.from_name || m.from_email || '')}`, toN.length ? `אל ${esc(toN.slice(0, 2).join(', '))}${toN.length > 2 ? ` ועוד ${toN.length - 2}` : ''}` : '', ccN ? `עותק ${ccN}` : '', stamp(m.date)].filter(Boolean).join(' · ');
          let open = false; try { open = localStorage.getItem('mesimot.mh.open') === '1'; } catch { /* no storage */ }
          return `<details class="mh-msg main"${open ? ' open' : ''} ontoggle="try{localStorage.setItem('mesimot.mh.open',this.open?'1':'0')}catch(e){}"><summary>${thread.length > 1 ? '<span class="mh-badge" style="display:inline;margin-inline-end:8px">העדכנית</span>' : ''}${line}</summary>${rows}</details>`;
        }
        return `<details class="mh-msg"><summary>${esc(m.from_name || m.from_email || '')} · ${stamp(m.date)}</summary>${rows}</details>`;
      };
      return `<div class="mailhead">${thread.map(msg).join('')}</div>`;
    },
    fromHtml(v) {
      const esc = (x) => String(x || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(String(v || ''));
      return m ? `${esc(m[1])} <bdi dir="ltr">${esc(m[2])}</bdi>` : esc(v);
    },
    fileIcon(f) {
      const n = String(f.name || f.original_name || '').toLowerCase(), m = f.mime || '';
      if (/\.(msg|eml)$/.test(n)) return '✉️';
      if (/\.pdf$/.test(n) || m === 'application/pdf') return '📕';
      if (/\.(docx?|rtf)$/.test(n)) return '📘';
      if (/\.(xlsx?|xlsm|csv|ods)$/.test(n)) return '📊';
      if (/\.pptx?$/.test(n)) return '📙';
      if (/\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?)$/.test(n) || m.startsWith('image/')) return '🖼️';
      if (/\.(txt|md|json|html?|xml|log)$/.test(n)) return '📄';
      return '📎';
    },
    isImage(f) { return /^image\//.test(f.mime || '') || /\.(jpe?g|png|gif|webp|bmp)$/i.test(f.original_name || f.name || ''); },
    textStatusHe(s) { return { ok: 'הטקסט נקרא', ocr: 'הטקסט זוהה מסריקה', empty: 'לא נמצא טקסט', unsupported: 'לא ניתן לקרוא את התוכן', pending: 'הטקסט נקרא ברקע…', stored: 'נשמר בלבד', too_big: 'נשמר בלבד (קובץ גדול)' }[s] || ''; },
    kindHe(k) { return { fact: 'עובדה', decision: 'החלטה', contact: 'איש קשר', note: 'הערה', doc: 'מסמך' }[k] || k; },
    kindLabel2(k) { return { task: 'משימה', email: 'מייל', chat: 'צ׳אט', knowledge: 'מידע', file: 'מסמך', chunk: 'מסמך', note: 'הערה' }[k] || k; },
    fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' מ״ב' : Math.max(1, Math.round(n / 1024)) + ' ק״ב'; },
    clipText(t, n) { t = String(t || ''); return t.length > n ? t.slice(0, n) + '…' : t; },

    // ---------- people
    async addPerson() {
      const n = this.newPerson;
      try {
        await this.api('POST', '/api/people', { name: n.name, role: n.role, emails: n.email });
        this.newPerson = { name: '', email: '', role: 'contact' };
        this.toast('נוסף'); await this.loadBoot();
      } catch (e) { this.fail(e); }
    },
    async saveModel(job, field, value) {
      const cur = { default: {}, jobs: {} };
      for (const m of this.st.agent.models) cur.jobs[m.job] = { model: m.model, effort: m.effort, fallback: m.fallback || '' };
      cur.jobs[job][field] = String(value).trim();
      try { await this.api('PATCH', '/api/settings', { agent_models: cur }); this.toast('נשמר'); await this.loadSettings(); } catch (e) { this.fail(e); await this.loadSettings(); }
    },
    // the thin bar re-opens the chat; when the window cannot hold all panes, the open card pane closes to make room (nothing overlays)
    chatBarClick() {
      if (window.innerWidth < 1024) return this.toggleChat();
      if (MesimotLayout.reopenNeedsRoom()) { if (this.route.name === 'task') this.closeTask(); else if (this.route.id && ['projects', 'protocols'].includes(this.route.name)) this.go('/' + this.route.name); }
      MesimotLayout.setCollapsed(false);
    },
    setDensity(d) { this.density = d; MesimotLayout.setDensity(d); },
    ownerId() { return (this.boot?.people || []).find((p) => p.role === 'owner')?.id; },
    ownerName() { return (this.boot?.people || []).find((p) => p.role === 'owner')?.name_he || 'אני'; },
    assistantName() { return (this.boot?.people || []).find((p) => p.role === 'assistant')?.name_he || 'אלכס'; },
    gateHe(g) { const L = { project: 'שיוך לפרויקט', requester: 'מאת', dates: 'תאריכים', people: 'אנשים שנזכרו', language: 'שפה', duplicate: 'כפילות', email_report: 'דיווח על מייל', attachments: 'קבצים מצורפים', facts: 'כרטיס הפרויקט', protocol: 'פרוטוקול', message: 'הודעה', summary: 'תקציר', memory: 'זיכרון' }; const O = { raised: 'נשאלה שאלה', resolved: 'תוקן', accepted: 'נשאר לבדיקה', autofixed: 'הושלם בקוד' }; return (L[g.code] || g.code) + ' · ' + O[g.outcome] + (g.round ? ' (סבב ' + g.round + ')' : '') + ':'; },
    async markReviewed(id) { try { await this.api('POST', `/api/tasks/${id}/reviewed`, {}); this.toast('סומן כנבדק'); await Promise.all([this.loadBoot(), this.openTask(id)]); } catch (e) { this.fail(e); } },
    async togglePersonCard(p) { if (this.personCard && this.personCard.id === p.id) { this.personCard = null; return; } try { this.personCard = await this.api('GET', '/api/people/' + p.id); } catch (e) { this.fail(e); } },
    async savePerson(p) {
      const body = { name: this.form.name, name_en: this.form.name_en, emails: this.form.emails, notes: this.form.notes };
      if (p.role === 'pm' || p.role === 'contact') body.role = this.form.role;
      try { await this.api('PATCH', '/api/people/' + p.id, body); this.toast('נשמר'); this.editing = null; await this.loadBoot(); } catch (e) { this.fail(e); }
    },

    // ---------- chat, status, search (stage 2)
    busy() { return !!(this.status.working || this.status.pending_chat > 0 || this.status.pending_web > 0 || this.awaitingId); },
    // a web search (/s) is running or waiting to start
    searching() { return this.status.pending_web > 0 || (this.status.working && this.status.trigger === 'web'); },
    statusText() {
      if (this.searching()) return 'אלכס מחפש באינטרנט…';
      if (this.busy()) return 'אלכס עובד…';
      const lr = this.status.last_run;
      if (!lr || !lr.finished_at) return '';
      const min = Math.max(0, Math.round((this.nowTick - Date.parse(lr.finished_at)) / 60000));
      if (min < 1) return 'עודכן עכשיו';
      if (min < 60) return `עודכן לפני ${min} דק׳`;
      if (min < 1440) return `עודכן לפני ${Math.round(min / 60)} שע׳`;
      return '';
    },
    async pollLoop() {
      const tick = async () => {
        try { if (!document.hidden) await this.pollNow(); } catch (e) { /* offline */ }
        setTimeout(tick, this.busy() ? 1500 : 4000);
      };
      tick();
    },
    importStage(i) { return { collecting: 'ממתין להודעות נוספות…', staging: 'קורא את הקבצים…', parsed: 'מסנן כפילויות…', triage: 'ממיין שרשורים…', processing: 'מעבד שרשורים…', digest: 'מכין סיכום…', done: 'הושלם' }[i.status] || ''; },
    async pollImports() {
      for (const m of this.chatMsgs) {
        if (m.import_id && !m._noimp && (!m.import || m.import.status !== 'done')) { try { const p = await this.api('GET', '/api/imports/' + m.import_id); m.import = p; } catch (e) { m._noimp = true; } }
      }
    },
    async pollNow() {
      const was = this.busy();
      this.status = await this.api('GET', '/api/status');
      if (this.chatMsgs.some((m) => m.import_id && !m._noimp && (!m.import || m.import.status !== 'done'))) this.pollImports();
      if (this.status.last_message_id > this.lastMsgId) await this.loadChat(true);
      if (this.awaitingId && !this.status.working && this.status.pending_chat === 0 && this.chatMsgs.some((m) => m.author === 'claude' && m.id > this.awaitingId)) this.awaitingId = 0;
      if (this.awaitingId && !this.status.working && this.status.pending_chat === 0 && Date.now() - (this._awaitSince || 0) > 15000) this.awaitingId = 0;
      if (was && !this.busy()) {
        await this.loadBoot();
        if (['home', 'task'].includes(this.route.name)) await this.loadLists();
        if (this.route.name === 'task') await this.loadDetail(true);
        if (this.route.name === 'projects' && this.route.id) await this.loadProjectPage(this.route.id, true);
        if (this.route.name === 'protocols' && this.route.id) { await this.loadProtocol(this.route.id); await this.loadProtocols(); }
        if (this.route.name === 'calendar') await this.loadCalendar();
        if (this.route.name === 'people' && typeof this.loadPeople === 'function') await this.loadPeople();
        this.sc.waiting = '';
      }
    },
    async loadChat(more) {
      if (more && this.lastMsgId) {
        if (this._chatLoading) return; this._chatLoading = true; // concurrent polls used to push the same message twice
        let add; try { add = await this.api('GET', '/api/chat?after=' + this.lastMsgId); } finally { this._chatLoading = false; }
        if (!Array.isArray(add)) return;
        add = add.filter((m) => !this.chatMsgs.some((x) => x.id === m.id));
        if (add.length) {
          const stick = this._stick !== false || add.every((m) => m.author !== 'claude');
          add.forEach((m) => this.normMsg(m)); this.chatMsgs.push(...add); this.lastMsgId = Math.max(this.lastMsgId, ...add.map((m) => m.id));
          this.chatMsgs.sort((a, b) => (a.pos || a.id) - (b.pos || b.id)); // a reply to an edited message sits right after it
          const fromClaude = add.filter((m) => m.author === 'claude' && this.isMainMsg(m));
          if (fromClaude.length && !this.chatVisible()) { const m = fromClaude[fromClaude.length - 1]; this.toast('אלכס: ' + this.clipText(m.text.replace(/https?:\/\/\S+/g, '').trim(), 90)); }
          this.markSeen();
          if (this.route.name === 'task' && add.some((m) => m.scope === 'task' && m.task_id === this.route.id)) { await this.loadDetail(true); this.scrollTaskFeed(); }
          if (stick) this.scrollFeed(); else this.newBelow += add.length;
        }
      } else {
        const first = await this.api('GET', '/api/chat?limit=80');
        if (!Array.isArray(first)) throw new Error('chat list');
        this.chatMsgs = first.map((m) => this.normMsg(m)).filter(Boolean);
        this.lastMsgId = this.chatMsgs.length ? this.chatMsgs[this.chatMsgs.length - 1].id : 0;
        this.markSeen(); this.scrollFeed();
      }
    },
    wide() { return window.matchMedia('(min-width: 1024px)').matches; },
    chatVisible() { return this.wide() || this.chatOpen; },
    unread() { return this.chatMsgs.filter((m) => m.author === 'claude' && m.id > this.seenId && this.isMainMsg(m)).length; },
    markSeen() { if (!this.chatVisible()) return; const last = this.chatMsgs.length ? this.chatMsgs[this.chatMsgs.length - 1].id : 0; if (last > this.seenId) { this.seenId = last; try { localStorage.setItem('seenChatId', String(last)); } catch (e) {} } },
    openChat(focus) {
      this.chatOpen = true; this.markSeen(); this._stick = true; this.scrollFeed();
      if (focus) this.$nextTick(() => { const el = document.querySelector('.cp-composer .comp-input'); if (el && !('ontouchstart' in window)) el.focus(); });
    },
    closeChat() { this.chatOpen = false; if (location.pathname === '/chat') history.replaceState({}, '', '/'); },
    toggleChat() { this.chatOpen ? this.closeChat() : this.openChat(true); },
    // The feed sticks to the bottom unless the owner scrolled up by more than ~150px; then a "new messages" button shows instead of yanking him down.
    scrollFeed(force = true) {
      if (force) { this._stick = true; this.newBelow = 0; }
      const go = () => { const f = this.$refs.feed; if (f && f.clientHeight > 0 && this._stick !== false) f.scrollTop = f.scrollHeight; };
      this.$nextTick(() => { go(); requestAnimationFrame(() => { go(); setTimeout(go, 120); }); });
    },
    watchFeed() {
      const f = this.$refs.feed; if (!f || f._watched) return; f._watched = true; this._stick = true;
      f.addEventListener('scroll', () => { if (f.clientHeight === 0) return; this._stick = f.scrollHeight - f.scrollTop - f.clientHeight < 150; if (this._stick) this.newBelow = 0; }, { passive: true });
      const keep = () => { if (this._stick !== false && f.clientHeight > 0) f.scrollTop = f.scrollHeight; };
      new ResizeObserver(keep).observe(f); // opened, un-collapsed, resized, keyboard
      new MutationObserver(keep).observe(f, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
      f.addEventListener('load', keep, true); // images / late content
    },
    autosize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px'; },
    // quote a message: the next message is a REPLY to it (the assistant sees which message he answered)
    startReply(m) { this.msgMenu = null; this.replyTo = { id: m.id, text: String(m.text || '').replace(/\s+/g, ' ').slice(0, 140) }; this.$nextTick(() => { const t = document.querySelector('.chat-panel .comp-input'); if (t) t.focus(); }); },
    async sendChat() {
      const text = this.chatText.trim();
      if (this.uploading()) { this.toast('ממתינים לסיום העלאת הקבצים'); return; }
      this.chatFiles = this.chatFiles.filter((f) => !f.error);
      if (this.sending || (!text && !this.chatFiles.length)) return;
      this.sending = true;
      try {
        const m = await this.api('POST', '/api/chat', { text, file_ids: this.chatFiles.map((f) => f.id), ...(this.chatTask ? { task: this.chatTask } : {}), ...(this.replyTo ? { reply_to: this.replyTo.id } : {}) });
        this.chatText = ''; this.chatFiles = []; this.chatTask = null; this.replyTo = null;
        document.querySelectorAll('.comp-input').forEach((el) => { el.style.height = 'auto'; });
        this.awaitingId = m.id; this._awaitSince = Date.now();
        if (m.id > this.lastMsgId && !this.chatMsgs.some((x) => x.id === m.id)) { this.chatMsgs.push(m); this.lastMsgId = m.id; }
        this.scrollFeed();
        this.pollNow();
      } catch (e) { this.fail(e); }
      this.sending = false;
    },
    // ---- chat attachments: dropped, pasted or picked. Every file is a chip with its own progress and a cancel button; the files go out WITH the next
    // message (the owner can type a caption first). Big files use the chunked, resumable upload.
    attachFiles(list, opts = {}) {
      const files = Array.from(list || []).filter((f) => f && typeof f.size === 'number');
      for (const f of files) {
        this.chatFiles.push({ key: 'c' + Math.random().toString(36).slice(2), name: f.name || 'קובץ', size: f.size, mime: f.type || null, pct: 0, text: 'ממתין…', done: false, error: false, id: null, ctl: new AbortController() });
        const chip = this.chatFiles[this.chatFiles.length - 1]; // the reactive proxy: updates to it redraw the chip
        this.runChip(chip, f, opts);
      }
      if (files.length && opts.task) { this.chatTask = opts.task; if (!this.chatText.trim()) this.chatText = `קובץ למשימה #${opts.task}`; this.$nextTick(() => { const t = document.querySelector('.chat-panel .comp-input'); if (t) { t.focus(); this.autosize && this.autosize(t); } }); }
    },
    async runChip(chip, f, opts) {
      try {
        let saved;
        if (f.size > 30 * 1024 * 1024) saved = await this.uploadBig(f, null, { chip, signal: chip.ctl.signal, task: opts.task });
        else saved = await this.xhrUpload(f, opts.task, chip);
        chip.id = saved.id; chip.mime = saved.mime || chip.mime; chip.done = true; chip.pct = 100; chip.text = 'הועלה';
      } catch (e) { if (chip.ctl.signal.aborted) return; chip.error = true; chip.text = e.message || 'ההעלאה נכשלה'; }
    },
    xhrUpload(f, task, chip) {
      return new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        const fd = new FormData(); fd.append('file', f); if (task) fd.append('task', task);
        x.open('POST', '/api/files'); x.setRequestHeader('X-Mesimot', '1'); x.withCredentials = true;
        x.upload.onprogress = (e) => { if (e.lengthComputable) { chip.pct = Math.round((e.loaded / e.total) * 100); chip.text = `מעלה… ${chip.pct}%`; } };
        x.onload = () => { let d = []; try { d = JSON.parse(x.responseText); } catch (e) { /* ignore */ } if (x.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return; } if (x.status >= 200 && x.status < 300 && d[0]) resolve(d[0]); else reject(new Error((d && d.error) || 'ההעלאה נכשלה')); };
        x.onerror = () => reject(new Error('ההעלאה נכשלה, בדקו את החיבור'));
        chip.ctl.signal.addEventListener('abort', () => { x.abort(); reject(new Error('ההעלאה בוטלה')); });
        chip.text = 'מעלה…'; x.send(fd);
      });
    },
    cancelChip(chip) { chip.ctl.abort(); this.chatFiles = this.chatFiles.filter((x) => x.key !== chip.key); if (!this.chatFiles.length) this.chatTask = null; },
    uploading() { return this.chatFiles.some((f) => !f.done && !f.error); },
    hasFiles(ev) { return !!(ev.dataTransfer && [...(ev.dataTransfer.types || [])].includes('Files')); },
    dragOver(zone, ev) { if (!this.hasFiles(ev)) return; ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; this.dropping = zone; },
    dragLeave(zone, ev) { if (!ev.currentTarget.contains(ev.relatedTarget) && this.dropping === zone) this.dropping = null; },
    dropOn(zone, ev) {
      if (!this.hasFiles(ev)) return;
      ev.preventDefault(); ev.stopPropagation(); this.dropping = null;
      if (zone === 'card') this.attachFiles(ev.dataTransfer.files, { task: this.detail && this.detail.id });
      else this.attachFiles(ev.dataTransfer.files);
    },
    onPaste(ev) {
      const files = Array.from((ev.clipboardData && ev.clipboardData.files) || []);
      if (!files.length) return;                                    // plain text: the browser pastes it as usual
      ev.preventDefault();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
      this.attachFiles(files.map((f, i) => (f.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(f.name) ? f : new File([f], `צילום-${stamp}-${i + 1}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }))));
    },
    toggleMic(target) {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) { this.toast('הדפדפן אינו תומך בזיהוי דיבור. השתמשו בכרום או בספארי', true); return; }
      if (this._rec) { this._rec.stop(); return; }
      const rec = new SR();
      rec.lang = 'he-IL'; rec.interimResults = true; rec.continuous = false;
      const key = target === 'task' ? 'tcText' : 'chatText';
      const base = this[key] ? this[key].trimEnd() + ' ' : '';
      rec.onresult = (ev) => { let t = ''; for (const r of ev.results) t += r[0].transcript; this[key] = base + t; };
      rec.onend = () => { this.listening = false; this.listeningTask = false; this._rec = null; };
      rec.onerror = () => { this.listening = false; this._rec = null; this.toast('לא הצלחתי להקליט. נסו שוב', true); };
      this._rec = rec; this.listening = true; this.listeningTask = target === 'task'; rec.start();
    },
    // links to the main or the mirror address stay on whichever host the owner is using now
    localize(t) { let s = String(t || ''); for (const u of [this.boot?.urls?.main, this.boot?.urls?.mirror].filter(Boolean)) { try { s = s.split(new URL(u).origin).join(location.origin); } catch { /* bad url */ } } return s; },
    // an absolute address of this site (calendar feed, copied links) on the host in use
    here(url) { try { return location.origin + new URL(url, location.origin).pathname + new URL(url, location.origin).search; } catch { return url; } },
    chatHtml(text, refs) { try { return this.chatHtml0(text, refs); } catch (e) { return String(text == null ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } },
    chatHtml0(text, refs) {
      const esc = this.localize(String(text || '')).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const fall = { task: 'משימה', projects: 'פרויקט', email: 'מייל' };
      const clip = (t) => (t.length > 48 ? t.slice(0, 48) + '…' : t);
      const name = (k, id) => {
        let n = refs && refs[k] && refs[k][id];
        if (!n && k === 'projects') n = (this.boot.projects.find((p) => p.id === +id) || {}).name_he;
        const label = n ? clip(n) : `${fall[k]} ${id}`;
        return label.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      };
      return esc.replace(/(?:https?:\/\/[^\/\s<]+)?\/(task|projects|email)\/(\d+)/g, (m, k, id) => `<a href="/${k}/${id}" data-go="/${k}/${id}">${name(k, id)}</a>`).replace(/\n/g, '<br>');
    },
    chatClick(ev) { const a = ev.target.closest && ev.target.closest('a[data-go]'); if (a) { ev.preventDefault(); this.go(a.dataset.go); } },

    // ---------- the "דואר" tab: every email, newest first (lib/maillist.js). The list state lives here, so coming back from a mail keeps the list, the filters and the scroll position.
    emailTpl() { if (!this._emailTpl) this._emailTpl = document.getElementById('tpl-email-view').innerHTML; return this._emailTpl; },
    mailDesktop() { return window.innerWidth >= 1024; },
    mailDirIcon(dir) {
      return dir === 'sent'
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="יוצא"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="נכנס"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/></svg>';
    },
    mailWho(m) { return m.direction === 'sent' ? 'אל: ' + ((m.to || []).slice(0, 2).join(', ') || '—') + (m.to && m.to.length > 2 || m.to_more ? ' ועוד' : '') : (m.from || '—'); },
    mailWhen(iso) {
      if (!iso) return '';
      const p = jerusalemParts(new Date(iso)), t = todayISO(), d = `${p.year}-${p.month}-${p.day}`;
      if (d === t) return `${p.hour}:${p.minute}`;
      const y = new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 1, +t.slice(8, 10) - 1)).toISOString().slice(0, 10);
      if (d === y) return 'אתמול';
      return d.slice(0, 4) === t.slice(0, 4) ? `${p.day}/${p.month}` : `${p.day}/${p.month}/${p.year.slice(2)}`;
    },
    mailSummary() {
      const m = this.mail; if (!m.loaded) return '';
      if (this.mail.f.q && m.items.length >= 0 && m.search) return m.items.length + ' תוצאות';
      return (m.total == null ? '' : m.total.toLocaleString('he-IL') + ' מיילים') + (m.newCount > 0 && !m.f.q ? ' · ' + m.newCount + ' חדשים' : '');
    },
    mailFilterCount() { const f = this.mail.f; return [f.project, f.person, (f.from || f.to), f.linked, f.att, f.archive !== '1', f.noise].filter(Boolean).length; },
    mailParams(extra = {}) {
      const f = this.mail.f, p = new URLSearchParams();
      const q = String(f.q || '').trim(); if ([...q].length >= 3) p.set('q', q);
      for (const k of ['project', 'person', 'from', 'to', 'linked', 'noise']) if (f[k]) p.set(k, f[k]);
      if (f.folder !== 'all') p.set('folder', f.folder);
      if (f.att) p.set('att', '1');
      if (f.archive !== '1') p.set('archive', f.archive);
      if (f.mode === 'all') p.set('mode', 'all');
      for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
      return p;
    },
    mailSync() { // the filters live in the address (a deep link, back/forward, a bookmark); no new history entry per keystroke
      if (this.route.name !== 'mail') return;
      const p = this.mailParams(); this.mail.urlKey = p.toString();
      if (this.mail.openId) p.set('m', this.mail.openId);
      history.replaceState({}, '', '/mail' + (p.toString() ? '?' + p : ''));
    },
    mailFromUrl(u) {
      const f = this.mail.f, g = (k) => u.get(k) || '';
      Object.assign(f, { q: g('q'), folder: ['in', 'out'].includes(g('folder')) ? g('folder') : 'all', project: g('project'), person: g('person'), personName: '', from: g('from'), to: g('to'), att: g('att') === '1', linked: ['0', '1'].includes(g('linked')) ? g('linked') : '', archive: ['0', 'only'].includes(g('archive')) ? g('archive') : '1', noise: g('noise') === '0' ? '0' : '', mode: g('mode') === 'all' ? 'all' : 'threads' });
      const pr = (this.boot.projects || []).find((x) => String(x.id) === f.project || x.name_he === f.project); if (f.project) f.project = pr ? String(pr.id) : '';
      if (/^\d+$/.test(f.person)) { const pe = (this.boot.people || []).find((x) => String(x.id) === f.person); f.personName = pe ? pe.name_he : f.person; } else f.personName = f.person;
      this.mail.range = f.from || f.to ? 'custom' : ''; this.mail.showF = this.mailFilterCount() > 0;
    },
    async mailEnter(prev) {
      const m = this.mail, u = new URLSearchParams(location.search);
      if (!(this.boot.projects || []).length) await this.loadBoot();
      const key = (() => { const c = new URLSearchParams(u); c.delete('m'); const t = [...c.entries()].sort(); return new URLSearchParams(t).toString(); })();
      const same = m.loaded && m.urlKey !== null && new URLSearchParams([...new URLSearchParams(m.urlKey).entries()].sort()).toString() === key;
      if (!same) this.mailFromUrl(u);
      if (!m.visited || !prev || !['mail', 'email'].includes(prev.name)) { try { const v = await this.api('POST', '/api/mail/visit'); m.since = v.since || null; } catch (e) { /* the marker is optional */ } m.visited = true; }
      const open = this.mailDesktop() ? +u.get('m') || null : null;
      if (!same) { m.openId = open; await this.mailLoad(true); } else if (open !== m.openId) m.openId = open;
      if (m.openId && (!this.emailView || this.emailView.id !== m.openId)) this.loadEmail(m.openId);
      if (!m.openId) { this.emailView = null; }
      this.mailSync();
      if (same && !this.mailDesktop()) this.$nextTick(() => requestAnimationFrame(() => window.scrollTo(0, m.scroll || 0)));
      this.$nextTick(() => this.mailNearEnd());
    },
    async mailLoad(reset) {
      const m = this.mail; if (m.loading && !reset) return;
      const seq = ++m.seq; m.loading = true; m.err = '';
      try {
        const r = await this.api('GET', '/api/mail?' + this.mailParams({ limit: '40', since: m.since, before: reset ? '' : m.next }));
        if (seq !== m.seq) return;
        if (reset) { m.items = r.items; m.open = {}; m.sub = {}; } else { const have = new Set(m.items.map((x) => x.id)); m.items = [...m.items, ...r.items.filter((x) => !have.has(x.id))]; }
        m.next = r.next; m.capped = !!r.capped; m.search = r.mode === 'search';
        if (reset) { m.total = r.total ?? null; m.newCount = r.new_count ?? (m.search ? 0 : m.newCount); }
        m.loaded = true;
      } catch (e) { if (seq === m.seq) { m.err = e.message || 'שגיאה בטעינת המיילים'; m.items = reset ? [] : m.items; m.loaded = true; } }
      if (seq === m.seq) m.loading = false;
      this.$nextTick(() => this.mailNearEnd());
    },
    async mailReload() { const m = this.mail; m.next = null; this.mailSync(); await this.mailLoad(true); const el = document.querySelector('.mail-list'); if (el && this.mailDesktop()) el.scrollTop = 0; else window.scrollTo(0, 0); },
    mailSet(k, v) { this.mail.f[k] = v; this.mailReload(); },
    mailMore() { if (this.mail.next && !this.mail.loading) return this.mailLoad(false); },
    mailNearEnd() { if (this.route.name !== 'mail' || !this.mail.next || this.mail.loading) return; const s = document.querySelector('.mail-more .sentinel'); if (s && s.getBoundingClientRect().top < window.innerHeight + 700) this.mailMore(); },
    mailScrolled() { this.mailNearEnd(); },
    mailRange() {
      const f = this.mail.f, r = this.mail.range, t = todayISO(), [y, mo, d] = t.split('-').map(Number);
      if (r === 'week') { const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); f.from = new Date(Date.UTC(y, mo - 1, d - dow)).toISOString().slice(0, 10); f.to = ''; }
      else if (r === 'month') { f.from = `${y}-${String(mo).padStart(2, '0')}-01`; f.to = ''; }
      else if (r === 'year') { f.from = `${y}-01-01`; f.to = ''; }
      else if (!r) { f.from = ''; f.to = ''; }
      else return;
      this.mailReload();
    },
    mailClearFilters() { Object.assign(this.mail.f, { project: '', person: '', personName: '', from: '', to: '', att: false, linked: '', archive: '1', noise: '' }); this.mail.range = ''; this.mail.pq = ''; this.mailReload(); },
    async mailPeople() {
      const q = this.mail.pq.trim(); if (q.length < 2) { this.mail.sug = []; return; }
      try { const r = await this.api('GET', '/api/mail/people?q=' + encodeURIComponent(q)); if (q === this.mail.pq.trim()) this.mail.sug = r; } catch (e) { this.mail.sug = []; }
    },
    mailPick(p) { const f = this.mail.f; f.person = p ? String(p.id || p.email) : ''; f.personName = p ? p.name : ''; this.mail.pq = ''; this.mail.sug = []; this.mailReload(); },
    async mailToggle(row) {
      const m = this.mail; m.open = { ...m.open, [row.id]: !m.open[row.id] };
      if (m.open[row.id] && !m.sub[row.id]) { try { const r = await this.api('GET', '/api/mail/thread/' + row.id + '?since=' + encodeURIComponent(m.since || '') + (m.f.archive === '0' ? '&archive=0' : '')); m.sub = { ...m.sub, [row.id]: r.items }; } catch (e) { this.fail(e); m.open = { ...m.open, [row.id]: false }; } }
    },
    mailOpen(row) { return this.mailOpenId(row.id); },
    mailOpenId(id) {
      const m = this.mail;
      if (this.route.name === 'mail' && this.mailDesktop()) { m.openId = id; this.mailThreadOpen = null; this.mailSync(); this.loadEmail(id); return; }
      if (this.route.name === 'mail') m.scroll = window.scrollY;
      return this.go('/email/' + id);
    },
    async mailShowThread(e) {
      if (this.mailThreadOpen && this.mailThreadOpen.id === e.id) { this.mailThreadOpen = null; return; }
      this.mailThreadOpen = { id: e.id, items: [], loading: true };
      try { const r = await this.api('GET', '/api/mail/thread/' + e.id); if (this.mailThreadOpen && this.mailThreadOpen.id === e.id) this.mailThreadOpen = { id: e.id, items: r.items, loading: false }; } catch (err) { this.fail(err); this.mailThreadOpen = null; }
    },
    // "create a task from the mail" / "ask about the mail": the chat pinned to THIS mail (ref email:ID); the assistant gets the mail as context and does the work
    mailChatAct(kind) {
      this.sc.text = kind === 'create' ? 'צור משימה מהמייל הזה' : '';
      this.$nextTick(() => { const box = document.querySelector('.email-chat'), ta = box && box.querySelector('.tc-in'); if (!ta) return; box.scrollIntoView({ block: 'center', behavior: 'smooth' }); box.classList.remove('flash'); void box.offsetWidth; box.classList.add('flash'); ta.focus(); this.autosize(ta); });
    },
    async loadEmail(id) {
      this.emailView = null; this.emailErr = '';
      try { this.emailView = await this.api('GET', '/api/emails/' + id); } catch (e) { this.emailErr = 'הדוא״ל לא נמצא'; }
    },
    // ---- archive: closed (done / cancelled) tasks, newest first, with its own search and filters; a task can be reopened
    async loadArchive(more = false) {
      const a = this.arc; a.loading = true;
      const p = new URLSearchParams({ limit: '50', offset: more ? String(a.items.length) : '0' });
      for (const k of ['q', 'project', 'person', 'from', 'to']) if (String(a[k] || '').trim()) p.set(k, String(a[k]).trim());
      try { const r = await this.api('GET', '/api/archive?' + p); const items = this.normTasks(r.items); a.items = more ? [...a.items, ...items] : items; a.total = r.total; } catch (e) { this.fail(e); }
      a.loading = false;
    },
    async reopenTask(t) { try { await this.api('PATCH', '/api/tasks/' + t.id, { status: 'בטיפול' }); this.toast('המשימה נפתחה מחדש'); await this.loadArchive(); } catch (e) { this.fail(e); } },
    async runSearch() {
      const q = this.sq.q.trim();
      this.sErr = '';
      if ([...q].length < 3) { this.sres = null; if (q) this.sErr = 'יש להזין לפחות שלוש אותיות לחיפוש'; return; }
      const p = new URLSearchParams({ q, limit: '60' });
      for (const k of ['kind', 'project', 'person', 'from', 'to']) if (this.sq[k]) p.set(k, this.sq[k]);
      if (this.sq.archive) p.set('archive', '1');
      if (!this.sq.mailArchive) p.set('mail_archive', '0');
      try { this.sres = await this.api('GET', '/api/search?' + p); } catch (e) { this.sres = null; this.sErr = e.message; }
      try { this.sem = await this.api('GET', '/api/semantic/status'); } catch (e) { /* ignore */ }
    },
    searchGroups() {
      if (!this.sres) return [];
      const defs = [['task', 'משימות', ['task']], ['email', 'מיילים', ['email']], ['chat', 'צ׳אט', ['chat']], ['knowledge', 'מידע', ['knowledge']], ['doc', 'מסמכים', ['chunk', 'file']], ['note', 'הערות', ['note']]];
      return defs.map(([key, label, kinds]) => ({ key, label, items: this.sres.results.filter((r) => kinds.includes(r.kind)) })).filter((g) => g.items.length);
    },
    openResult(r) { this.go(r.link); },

    // ---------- activity and undo
    async loadActivity() { try { this.act = await this.api('GET', '/api/activity?limit=40'); } catch (e) { this.fail(e); } this.loadUsage(); },
    async loadFbStats() { try { this.fbStats = await this.api('GET', '/api/feedback/stats?days=30'); } catch (e) { /* optional */ } },
    async loadUsage() { this.loadFbStats(); try { this.usage = await this.api('GET', '/api/usage?days=' + this.usageDays); } catch (e) { /* the panel is optional */ } },
    usd(n) { return '$' + (+n || 0).toFixed(2); },
    tok(n) { n = +n || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n); },
    usageBar(d) { const max = Math.max(...this.usage.daily.map((x) => x.cost), 0.0001); return Math.max(2, Math.round((d.cost / max) * 56)); },
    triggerHe(t) { return { web: 'חיפוש באינטרנט', chat: 'הודעה בצ׳אט', pulse: 'פולס יומי', curator: 'ניקוי שבועי של הזיכרון', reconcile: 'התאמה יומית', 'facts-backfill': 'השלמת כרטיס פרויקט' }[t] || 'עדכונים ומיילים'; },
    dayShort(d) { const [, m, dd] = d.split('-'); return `${dd}/${m}`; },
    runUndoable(r) { return r.actions.some((a) => !a.undone_at && a.undoable); },
    describeAction(a) {
      const dsrc = { explicit: 'מפורש', estimated: 'משוער', manual: 'ידני' };
      const v = (f, x) => (x === null || x === undefined || x === '' ? 'ריק' : f === 'due_date' ? this.fmtDate(x) : f === 'source_date' ? this.fmtDateTime(x) : f === 'due_source' ? dsrc[x] || x : this.clipText(x, 60));
      const PF = { name_he: 'שם הפרויקט', aliases: 'הכינויים', description: 'התיאור', status: 'המצב', color: 'הצבע', summary_he: 'התקציר' };
      const fld = (a.entity === 'project' ? PF[a.field] : FIELD_LABELS[a.field]) || 'שדה';
      const change = () => (a.field === 'description' || a.field === 'summary_he' || a.field === 'body' ? `עדכן את ${fld}` : `שינה את ${fld} מ־"${v(a.field, a.old_value)}" ל־"${v(a.field, a.new_value)}"`);
      switch (a.entity) {
        case 'task': if (a.action === 'decision') return `החלטה (${{ close: 'סגירה', advance: 'התקדמות', update: 'עדכון', no_change: 'ללא שינוי' }[a.field] || a.field}): ${this.clipText(a.new_value, 90)} · משימה:`; return a.action === 'create' ? 'יצר משימה:' : a.action === 'note' ? 'הוסיף הערה למשימה:' : a.action === 'draft' ? 'הוסיף טיוטה למשימה:' : change() + ' · משימה:';
        case 'project': return a.action === 'create' ? 'יצר פרויקט:' : a.action === 'merge' ? 'מיזג פרויקט לתוך:' : a.action === 'note' ? 'הוסיף הערה לפרויקט:' : change() + ' · פרויקט:';
        case 'calendar': return a.action === 'create' ? 'הוסיף ליומן:' : a.action === 'delete' ? 'מחק מהיומן:' : 'עדכן ביומן:';
        case 'protocol': return a.action === 'create' ? 'יצר פרוטוקול:' : a.action === 'promote' ? 'העביר סעיף מפרוטוקול למשימות:' : 'עדכן פרוטוקול:';
        case 'fact': if (a.action === 'update' && a.field === 'key') return `איחד מפתחות בכרטיס הפרויקט: "${a.old_value}" ← "${a.new_value}" ·`; if (a.action === 'update') return 'סימן נתון בכרטיס הפרויקט כמוחלף ·'; return `עדכן את כרטיס הפרויקט: ${a.old_value ? a.old_value + ' ← ' : ''}${a.new_value || ''} ·`;
        case 'knowledge': return a.action === 'create' ? 'שמר מידע:' : a.field === 'superseded_by' ? 'סימן מידע כמוחלף:' : 'עדכן מידע:';
        case 'attention': return a.action === 'create' ? 'הוסיף לתשומת לב:' : 'עדכן פריט בתשומת לב:';
        case 'person': return a.action === 'merge' ? 'איחד שני רשומות של אותו איש:' : a.action === 'create' ? 'הוסיף איש:' : change() + ' · איש:';
        case 'file': return a.action === 'update' ? 'עדכן מסמך:' : 'העלה מסמך:';
        case 'chat': return 'כתב בצ׳אט:';
        case 'email': return 'התקבל מייל:';
        default: return 'פעולה:';
      }
    },
    openAction(a) {
      if (a.entity === 'task') this.go('/task/' + a.entity_id);
      else if (a.entity === 'project') this.go('/projects/' + a.entity_id);
      else if (a.entity === 'email') this.go('/email/' + a.entity_id);
      else if (a.entity === 'chat') this.openChat();
    },
    async undoAction(a) {
      try { await this.api('POST', `/api/events/${a.id}/undo`, {}); this.toast('הפעולה בוטלה'); await Promise.all([this.loadActivity(), this.loadBoot()]); } catch (e) { this.fail(e); await this.loadActivity(); }
    },
    async undoRun(r) {
      const ok = await this.ask('לבטל את כל הפעולות של ההרצה הזו? אפשר לבטל רק פעולות שהנתונים שלהן לא השתנו מאז.', 'ביטול הכול');
      if (!ok) return;
      try { const d = await this.api('POST', `/api/runs/${r.id}/undo`, {}); this.toast(`בוטלו ${d.undone} פעולות` + (d.skipped.length ? `, ${d.skipped.length} לא ניתנו לביטול` : ''), d.skipped.length > 0 && d.undone === 0); await Promise.all([this.loadActivity(), this.loadBoot()]); } catch (e) { this.fail(e); }
    },

    // ---------- task card: compact meta line, pickers, inline edits
    shortDate(iso) { if (!iso) return ''; const [y, m, d] = iso.split('-'); return y === todayISO().slice(0, 4) ? `${d}/${m}` : `${d}/${m}/${y}`; },
    shortStamp(iso) {
      if (!iso) return '';
      if (iso.length === 10) return this.shortDate(iso);
      const p = jerusalemParts(new Date(iso));
      return `${p.day}/${p.month}${p.year === todayISO().slice(0, 4) ? '' : '/' + p.year} ${p.hour}:${p.minute}`;
    },
    nameOf(v) { const m = /^(.*?)\s*<[^>]+>\s*$/.exec(String(v || '')); return (m ? m[1] : String(v || '')).trim() || String(v || ''); },
    relHe(r) { return { created: 'נוצרה מהמייל', updated: 'עדכן', closed: 'סגר', info: 'מידע' }[r] || r; },
    async saveField(field, val) {
      this.ed = null;
      if (String(val ?? '') === String(this.detail[field] ?? '')) return;
      await this.save(field, val, null);
    },
    openPicker(type, ev) {
      const titles = { status: 'סטטוס', priority: 'דחיפות', project: 'פרויקט', assignee: 'אחראי', requester: 'מאת', due: 'תאריך יעד', received: 'תאריך קבלה' };
      const r = ev && ev.currentTarget ? ev.currentTarget.getBoundingClientRect() : null;
      const p = { type, title: titles[type], rect: r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null, date: '', time: '' };
      if (type === 'due') p.date = this.detail.due_date || '';
      if (type === 'received') {
        const iso = this.detail.source_date || this.detail.created_at;
        if (iso && iso.length === 10) p.date = iso; else if (iso) { const q = jerusalemParts(new Date(iso)); p.date = `${q.year}-${q.month}-${q.day}`; p.time = `${q.hour}:${q.minute}`; }
      }
      this.picker = p;
    },
    closePicker() { this._escGuard = Date.now(); this.picker = null; },
    pickerStyle() {
      const r = this.picker && this.picker.rect;
      if (window.innerWidth < 900) return '';
      if (!r) return 'left:50%;top:14%;transform:translateX(-50%);width:400px;max-width:92vw';
      const w = 300, left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
      const top = Math.min(r.bottom + 6, window.innerHeight - 380);
      return `left:${left}px;top:${Math.max(70, top)}px;width:${w}px`;
    },
    pickerOptions() {
      const t = this.picker && this.picker.type, d = this.detail;
      if (t === 'status') return this.boot.statuses.map((s) => ({ key: s.id, value: s.id, label: s.name_he, color: s.color, on: s.id === d.status_id }));
      if (t === 'priority') return this.boot.priorities.map((s) => ({ key: s.id, value: s.id, label: s.name_he, color: s.color, on: s.id === d.priority_id }));
      if (t === 'project') return this.boot.projects.map((s) => ({ key: s.id, value: s.id, label: s.name_he, color: s.is_default ? '#9aa5b8' : s.color, on: s.id === d.project_id }));
      if (t === 'assignee') return [{ key: 'none', value: '', label: 'ללא אחראי', on: !d.assignee_id }, ...this.assignees().map((s) => ({ key: s.id, value: s.id, label: this.personLabel(s), on: s.id === d.assignee_id }))];
      if (t === 'requester') return [{ key: 'none', value: '', label: 'ללא שולח', on: !d.requester_id }, ...this.boot.people.filter((s) => s.role !== 'assistant').map((s) => ({ key: s.id, value: s.id, label: s.name_he, sub: s.emails[0] || '', on: s.id === d.requester_id }))];
      return [];
    },
    async pickValue(v) {
      const t = this.picker.type;
      this.picker = null;
      await this.save(t, String(v), null);
    },
    async pickDate(v) {
      const t = this.picker.type;
      this.picker = null;
      if (t === 'due') await this.saveDue(v, null); else await this.saveReceived(v, null);
    },

    // ---------- calendar
    today() { return todayISO(); },
    setCalView(v) { this.calView = v; try { localStorage.setItem('calView', v); } catch (e) {} this.loadCalendar(); },
    calStart() {
      const base = this.calDate || todayISO();
      const [y, m, d] = base.split('-').map(Number);
      if (this.calView === 'week') { const dt = new Date(Date.UTC(y, m - 1, d)); dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay()); return dt; }
      const first = new Date(Date.UTC(y, m - 1, 1)); first.setUTCDate(1 - first.getUTCDay()); return first;
    },
    calDays() {
      const start = this.calStart(), n = this.calView === 'week' ? 7 : 42, out = [];
      const [, mm] = (this.calDate || todayISO()).split('-').map(Number);
      for (let i = 0; i < n; i++) { const d = new Date(start); d.setUTCDate(d.getUTCDate() + i); out.push({ date: d.toISOString().slice(0, 10), day: d.getUTCDate(), other: this.calView === 'month' && d.getUTCMonth() + 1 !== mm }); }
      if (this.calView === 'month' && out.slice(35).every((x) => x.other)) out.length = 35;
      return out;
    },
    calLabel() {
      const days = this.calDays();
      if (this.calView === 'week') {
        const [y1, m1, d1] = days[0].date.split('-'), [y2, m2, d2] = days[6].date.split('-');
        return m1 === m2 ? `${+d1}–${+d2}/${m2}/${y2}` : (y1 === y2 ? `${+d1}/${m1}–${+d2}/${m2}/${y2}` : `${+d1}/${m1}/${y1}–${+d2}/${m2}/${y2}`);
      }
      const [y, m] = (this.calDate || todayISO()).split('-').map(Number);
      return `${['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'][m - 1]} ${y}`;
    },
    calDowMonth() { return ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳']; },
    dowLabel(date) { const [, m, d] = date.split('-'); return `${['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'][new Date(date + 'T12:00:00Z').getUTCDay()]} ${+d}/${m}`; },
    calCap() { return this.calView === 'week' ? 8 : 3; },
    // project marks: the project colour, grey for "unassigned" (the default project) and for meetings without a project
    pcol(it) { return it.project_id && !it.project_default && it.project_color ? it.project_color : '#6b7280'; },
    pname(it) { return it.project_default ? 'לא משויך' : (it.project || ''); },
    pkey(it) { return it.project_id && !it.project_default ? String(it.project_id) : 'none'; },
    calTip(it) { return [it.time, it.title, this.pname(it) ? '(' + this.pname(it) + ')' : '', it.estimated ? 'משוער' : ''].filter(Boolean).join(' '); },
    calLegend() {
      const m = new Map();
      for (const it of this.calItems) { const k = this.pkey(it); const g = m.get(k) || { key: k, name: k === 'none' ? 'לא משויך' : it.project, color: this.pcol(it), count: 0 }; g.count++; m.set(k, g); }
      return [...m.values()].sort((a, b) => (a.key === 'none') - (b.key === 'none') || a.name.localeCompare(b.name, 'he'));
    },
    calFilterLabel() { if (this.calProject === 'all') return 'כל הפרויקטים'; const g = this.calLegend().find((x) => x.key === this.calProject); return g ? g.name : (this.calProject === 'none' ? 'לא משויך' : (this.boot?.projects?.find((p) => String(p.id) === this.calProject)?.name_he || 'פרויקט')); },
    calFilterColor() { if (this.calProject === 'all') return 'transparent'; const g = this.calLegend().find((x) => x.key === this.calProject); return g ? g.color : '#6b7280'; },
    toggleCalFilter(ev) {
      if (this.calFilterOpen) { this.calFilterOpen = false; return; }
      const r = ev.currentTarget.getBoundingClientRect(), w = Math.min(300, innerWidth - 16);
      const left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8));
      this.calPopStyle = `top:${Math.round(r.bottom + 6)}px;left:${Math.round(left)}px;width:${w}px`;
      this.calFilterOpen = true;
    },
    setCalProject(k) { this.calProject = k; this.calFilterOpen = false; try { localStorage.setItem('calProject', k); } catch (e) {} },
    calDayDots(date) { return [...new Set(this.calItemsOn(date).map((i) => this.pcol(i)))].slice(0, 4); },
    calPick(date) { this.calSel = date; this.$nextTick(() => { const el = document.querySelector('.cal-day'); if (el && this.calView === 'month') el.scrollIntoView({ block: 'nearest' }); }); },
    async loadCalendar() {
      try { this.calView = localStorage.getItem('calView') || this.calView; this.calProject = localStorage.getItem('calProject') || this.calProject; } catch (e) {}
      if (!this.calDate) this.calDate = todayISO();
      if (!this.calSel) this.calSel = todayISO();
      const days = this.calDays();
      this.calItems = await this.api('GET', `/api/calendar?from=${days[0].date}&to=${days[days.length - 1].date}`);
    },
    calItemsOn(date) { return this.calItems.filter((i) => i.date === date && (this.calProject === 'all' || this.pkey(i) === this.calProject)); },
    async calMove(dir) {
      const [y, m, d] = (this.calDate || todayISO()).split('-').map(Number);
      const dt = this.calView === 'week' ? new Date(Date.UTC(y, m - 1, d + 7 * dir)) : new Date(Date.UTC(y, m - 1 + dir, 1));
      this.calDate = dt.toISOString().slice(0, 10); this.calSel = this.calView === 'week' ? this.calDate : this.calDate;
      await this.loadCalendar();
    },
    async calToday() { this.calDate = todayISO(); this.calSel = todayISO(); await this.loadCalendar(); },
    dayTitle(d) { if (!d) return ''; const dt = new Date(d + 'T12:00:00Z'); return `יום ${['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'][dt.getUTCDay()]} ${this.fmtDate(d)}`; },
    openCalItem(it) { if (it.kind === 'task') this.openTask(it.id); else if (it.task_id) this.openTask(it.task_id); else if (it.project_id) this.go('/projects/' + it.project_id); },
    openEventAdd() { this.picker = { type: 'event', title: 'אירוע חדש ביומן', key: '', value: '', unit: '', date: this.calSel || todayISO(), time: '10:00', rect: null, location: '', allday: false }; },
    async saveEvent() {
      const p = this.picker;
      try {
        await this.api('POST', '/api/calendar/items', { title: p.key.trim(), start: p.allday ? p.date : `${p.date} ${p.time}`, location: p.location });
        this.picker = null; this.toast('האירוע נוסף'); await this.loadCalendar();
      } catch (e) { this.fail(e); }
    },

    // ---------- settings
    fmtGB(n) { return n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' ג״ב' : Math.max(1, Math.round(n / 1048576)) + ' מ״ב'; },
    // ---- feedback on what the assistant produced from mail
    fbReset() { this.fb = { open: false, reason: '', text: '', sent: null, fixes: false, mergeInto: '', id: null, done: false }; },
    async fbVote(type, id, verdict) {
      try {
        const r = await this.api('POST', '/api/feedback', { item_type: type, item_id: id, verdict, reason: verdict === 'down' ? this.fb.reason || null : null, reason_text: verdict === 'down' ? this.fb.text || null : null });
        this.fb.sent = verdict; this.fb.id = r.id; this.fb.open = false; this.fb.fixes = verdict === 'down' && !!this.fb.reason; if (!this.fb.fixes) { const fid = this.detail && this.detail.id; setTimeout(() => { if (this.detail && this.detail.id === fid) this.fb.done = true; }, 1500); } // answered: thank, then hide the question
        if (r.suggestion) this.toast('יש הצעה חדשה לכלל סינון בצ׳אט');
      } catch (e) { this.fail(e); }
    },
    async fbFix(kind, value) {
      if ((kind === 'project' || kind === 'assignee') && !value) return;
      try { await this.api('POST', `/api/tasks/${this.detail.id}/fix`, { kind, value, feedback_id: this.fb.id }); this.toast('תוקן'); this.fb.fixes = false; await this.loadDetail(true); await this.loadLists(); } catch (e) { this.fail(e); }
    },
    async fbQuick(taskId, verdict) { try { await this.api('POST', '/api/feedback', { item_type: 'task', item_id: taskId, verdict }); this.toast(verdict === 'up' ? 'תודה' : 'נשמר'); } catch (e) { this.fail(e); } },
    // ---- outgoing mail: the card's buttons. Approval is bound to the hash the card shows; the server refuses a stale one.
    async loadOutbox() { try { this.obSet = await this.api('GET', '/api/outbox/settings'); } catch (e) { /* optional */ } },
    async obToggle() { try { this.obSet = await this.api('POST', '/api/outbox/settings', { enabled: !this.obSet.enabled }); this.toast(this.obSet.enabled ? 'שליחת מיילים הופעלה' : 'שליחת מיילים הושבתה'); } catch (e) { this.fail(e); } },
    async obSetCap() { try { this.obSet = await this.api('POST', '/api/outbox/settings', { daily_cap: this.obSet.daily_cap }); this.toast('נשמר'); } catch (e) { this.fail(e); await this.loadOutbox(); } },
    async obRefresh() { try { this.pollNow(); const cur = await this.api('GET', '/api/chat?limit=60'); for (const x of cur) { const mm = this.chatMsgs.find((y) => y.id === x.id); if (mm && x.outbox) mm.outbox = x.outbox; } } catch (e) { /* ignore */ } },
    async obApprove(m) { try { await this.api('POST', `/api/outbox/${m.outbox.id}/approve`, { hash: m.outbox.shown_hash }); this.toast('אושר. המייל יישלח מה-Outlook'); } catch (e) { this.fail(e); } await this.obRefresh(m); },
    async obResend(o) { try { const d = await this.api('POST', `/api/outbox/${o.id}/resend`, {}); this.toast(`נוצרה טיוטה חדשה #${d.id}: צריך לאשר אותה בכרטיס`); } catch (e) { this.fail(e); } await this.obRefresh(); },
    async obCancel(o) { try { await this.api('POST', `/api/outbox/${o.id}/cancel`, {}); } catch (e) { this.fail(e); } await this.obRefresh(); },
    obStartEdit(o) { const j = (l) => (l || []).map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', '); this.obEdit = { id: o.id, to: j(o.to), cc: j(o.cc), bcc: j(o.bcc), subject: o.subject, body: o.body_text }; },
    async obSaveEdit(o) { try { await this.api('PATCH', `/api/outbox/${o.id}`, { to: this.obEdit.to, cc: this.obEdit.cc, bcc: this.obEdit.bcc, subject: this.obEdit.subject, body: this.obEdit.body }); this.obEdit = null; this.toast('נוצר כרטיס חדש לאישור'); } catch (e) { this.fail(e); } await this.obRefresh(); },
    async loadSysHealth() { try { this.sysHealth = await this.api('GET', '/api/system-health'); } catch (e) { /* optional */ } },
    async loadConnector() { try { this.cn.devices = await this.api('GET', '/api/connector/devices'); this.cn.latest = await this.api('GET', '/api/connector/latest'); } catch (e) { /* optional */ } },
    async loadBackup() { try { this.bk.st = await this.api('GET', '/api/backup/status'); } catch (e) { /* optional */ } },
    bkHide() { this.bk.key = null; this.bk.pw = ''; this.bk.ask = false; this.bk.err = ''; },
    async bkShow() {
      if (this.bk.busy || !this.bk.pw) return; this.bk.busy = true; this.bk.err = '';
      try { const r = await this.api('POST', '/api/backup/key', { password: this.bk.pw }); this.bk.pw = ''; this.bk.key = r.key; }
      catch (e) { this.bk.err = (e && e.message) || 'שגיאה'; this.bk.pw = ''; }
      finally { this.bk.busy = false; }
    },
    async cnNewCode() { try { this.cn.code = await this.api('POST', '/api/connector/pair-code', {}); } catch (e) { this.fail(e); } },
    async cnActivate(d) { if (!window.confirm('להפוך את "' + (d.name || 'המחשב') + '" לפעיל? המחשב הפעיל כעת יעבור למצב המתנה ויפסיק לקלוט ולשלוח מיילים.')) return; try { await this.api('POST', `/api/connector/devices/${d.id}/activate`, {}); this.toast('Alex Link עבר ל-' + (d.name || 'המחשב')); await this.loadConnector(); } catch (e) { this.fail(e); } },
    async cnRevoke(d) { if (!window.confirm('לנתק את "' + (d.name || 'המחשב') + '"? התוכנה שם תפסיק לעבוד עד חיבור מחדש.')) return; try { await this.api('POST', `/api/connector/devices/${d.id}/revoke`, {}); this.toast('המחשב נותק'); await this.loadConnector(); } catch (e) { this.fail(e); } },
    archiveLine() { const a = this.ingest && this.ingest.archive; if (!a) return ''; return `ארכיון: ${a.emails} מיילים, ${a.text_only} טקסט בלבד${a.last_stored_at ? ', אחרון ' + this.fmtDateTime(a.last_stored_at) : ''}${a.queued + a.embedding ? ` · בתור: ${a.queued + a.embedding}` : ''}${a.failed ? ` · ${a.failed} נכשלו` : ''}`; },
    async loadIngest() { try { this.ingest = await this.api('GET', '/api/ingest/status'); } catch (e) { /* optional */ } },
    ingestState() { const t = this.ingest && this.ingest.last_contact_at ? Date.now() - Date.parse(this.ingest.last_contact_at) : null; return t === null ? 'לא מחובר' : t < 30 * 60000 ? 'מחובר' : t < 2 * 3600000 ? 'שקט (מעל חצי שעה)' : 'לא שולח מעל שעתיים'; },
    async loadFilters() { try { this.mailFilters = await this.api('GET', '/api/filters'); } catch (e) { /* optional */ } },
    async previewFilter() { try { this.fprev = await this.api('POST', '/api/filters/preview', { ...this.fform, project: this.fform.project || null }); } catch (e) { this.fail(e); } },
    async addFilter() { try { await this.api('POST', '/api/filters', { ...this.fform, project: this.fform.project || null }); this.fform.pattern = ''; this.fprev = null; this.toast('הכלל נוסף'); await this.loadFilters(); } catch (e) { this.fail(e); } },
    async toggleFilter(f) { try { await this.api('PATCH', '/api/filters/' + f.id, { enabled: !f.enabled }); await this.loadFilters(); } catch (e) { this.fail(e); } },
    async deleteFilter(f) { try { const r = await this.api('DELETE', '/api/filters/' + f.id); this.showBinBar(r); await Promise.all([this.loadFilters(), this.loadBoot()]); } catch (e) { this.fail(e); } },
    // ---- the settings screen: a list of categories, one panel per category
    setCats() { return SET_CATS; },
    setLast() { let c = null; try { c = localStorage.getItem('mesimot.set.cat'); } catch (e) { /* no storage */ } return SET_CATS.some((x) => x.id === c) ? c : SET_CATS[0].id; },
    setCat() { return (this.route && this.route.cat) || this.setLast(); },
    setTitle() { const c = SET_CATS.find((x) => x.id === this.setCat()); return c ? c.title : ''; },
    setOpen(id) {
      const wideNow = window.matchMedia('(min-width: 900px)').matches;
      if (!wideNow) this._setPushed = true;
      return this.go('/settings?c=' + id, wideNow); // phones: a real step back to the list; wide screens: switching categories is not history
    },
    setBack() { if (this._setPushed) { this._setPushed = false; history.back(); } else this.go('/settings', true); },
    setIcon(id) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (SET_ICONS[id] || '') + '</svg>'; },
    setSummary(id) {
      const st = this.st; if (!st) return '';
      const on = (b) => (b ? 'פועל' : 'כבוי');
      switch (id) {
        case 'notify': return 'דוא״ל ' + on(st.notify_email) + ' · טלגרם ' + on(st.notify_telegram) + ' · שקט ' + st.quiet_start + '–' + st.quiet_end;
        case 'outlook': { const act = this.cn.devices.filter((d) => !d.revoked).length; return (this.ingest ? this.ingestState() : '') + (act ? ' · ' + act + ' מחשבים' : ''); }
        case 'mail': return (this.obSet ? (this.obSet.enabled ? 'שליחה פעילה' : 'שליחה מושבתת') + ' · ' : '') + this.mailFilters.length + ' כללי סינון';
        case 'calendar': return 'קישור מנוי לאאוטלוק';
        case 'ai': { const o = st.agent && st.agent.options.find((x) => x.name === st.agent.name); return (o ? o.label : '') + (st.daily_budget_usd ? ' · תקרה ' + this.usd(st.daily_budget_usd) : ''); }
        case 'tasks': return st.statuses.length + ' סטטוסים · ' + st.priorities.length + ' דחיפויות';
        case 'trash': return (+st.trash_days ? st.trash_days + ' ימים בסל' : 'הסל לא מתרוקן') + ' · תיבה ' + st.mailbox_keep_days + ' ימים';
        case 'backup': return this.bk.st ? 'גיבוי אחרון: ' + (this.bk.st.offsite.last_success_at ? this.fmtDateTime(this.bk.st.offsite.last_success_at) : 'אין') : '';
        case 'account': return 'סיסמה וכתובות האתר';
        case 'system': return this.sysHealth ? (this.sysHealth.summary || '') : '';
        default: return '';
      }
    },
    // the options of the dropdowns; a value that is not in the list (set elsewhere) is kept as its own option
    withCur(list, cur) { const v = cur == null ? '' : String(cur); return list.some((o) => String(o[0]) === v) ? list : [...list, [v, v]]; },
    timeOpts(cur) { const l = []; for (let h = 0; h < 24; h++) for (const mm of ['00', '30']) { const t = String(h).padStart(2, '0') + ':' + mm; l.push([t, t]); } return this.withCur(l, cur); },
    trashOpts(cur) { return this.withCur([[7, '7 ימים'], [14, '14 ימים'], [30, '30 ימים'], [60, '60 ימים'], [90, '90 ימים'], [180, '180 ימים'], [365, 'שנה'], [0, 'לא לרוקן אוטומטית']], cur); },
    keepOpts(cur) { return this.withCur([[7, '7 ימים'], [14, '14 ימים'], [30, '30 ימים'], [60, '60 ימים'], [90, '90 ימים'], [180, '180 ימים'], [365, 'שנה']], cur); },
    mbOpts(cur) { return this.withCur([[25, '25 מ״ב'], [50, '50 מ״ב'], [100, '100 מ״ב'], [250, '250 מ״ב'], [500, '500 מ״ב'], [1024, '1 ג״ב'], [2048, '2 ג״ב'], [4096, '4 ג״ב']], cur); },
    modelOpts(cur) {
      const ag = this.st && this.st.agent && this.st.agent.name;
      const base = [['', 'ברירת מחדל']].concat(ag === 'claude-code' ? [['sonnet', 'Sonnet'], ['opus', 'Opus'], ['haiku', 'Haiku']] : []);
      return [...this.withCur(base, cur), ['__other', 'אחר…']];
    },
    effortOpts(cur) {
      const ag = this.st && this.st.agent && this.st.agent.name;
      const lv = ag === 'codex' ? ['minimal', 'low', 'medium', 'high'] : ag === 'claude-code' ? ['low', 'medium', 'high', 'xhigh', 'max'] : [];
      const he = { minimal: 'מינימלי', low: 'נמוך', medium: 'בינוני', high: 'גבוה', xhigh: 'גבוה מאוד', max: 'מרבי' };
      return [...this.withCur([['', 'ברירת מחדל'], ...lv.map((x) => [x, he[x]])], cur), ['__other', 'אחר…']];
    },
    setOther: null,
    pickModel(key, v, save) { if (v === '__other') { this.setOther = key; this.$nextTick(() => { const el = document.querySelector('[data-other="' + key + '"]'); if (el) el.focus(); }); return; } this.setOther = null; save(v); },
    async loadSettings() { this.loadSysHealth(); this.loadOutbox(); this.loadIngest(); this.loadConnector(); this.loadBackup(); this.loadFilters(); this.api('GET', '/api/health').then((h) => { this.health = h; }).catch(() => {}); this.api('GET', '/api/storage').then((s) => { this.storage = s; }).catch(() => {}); this.st = await this.api('GET', '/api/settings'); this.allowText = this.st.email_allowlist.join('\n'); },
    async saveSet(b) { try { await this.api('PATCH', '/api/settings', b); this.toast('נשמר'); await this.loadSettings(); } catch (e) { this.fail(e); await this.loadSettings(); } },
    async renameItem(table, s, name) { try { await this.api('PATCH', `/api/${table}/${s.id}`, { name_he: name }); this.toast('נשמר'); await Promise.all([this.loadSettings(), this.loadBoot()]); } catch (e) { this.fail(e); await this.loadSettings(); } },
    async copyText(t) {
      try { await navigator.clipboard.writeText(t); this.toast('הועתק'); }
      catch (e) { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); this.toast('הועתק'); } catch (x) { this.toast('לא ניתן להעתיק', true); } ta.remove(); }
    },
    async rotateCal() {
      const ok = await this.ask('ליצור קישור חדש ליומן? הקישור הישן יפסיק לעבוד וצריך לעדכן אותו באאוטלוק.', 'יצירה');
      if (!ok) return;
      try { await this.api('POST', '/api/calendar/token', {}); this.toast('נוצר קישור חדש'); await this.loadSettings(); } catch (e) { this.fail(e); }
    },
    async changePassword() {
      try { await this.api('POST', '/api/password', { old_password: this.pw.old, new_password: this.pw.new }); this.pw = { old: '', new: '' }; this.toast('הסיסמה שונתה'); } catch (e) { this.fail(e); }
    },
    async unbindTelegram() {
      const ok = await this.ask('לנתק את הבוט? יהיה צורך לחבר אותו מחדש.', 'ניתוק');
      if (!ok) return;
      try { await this.api('POST', '/api/telegram/unbind', {}); this.toast('הבוט נותק'); await this.loadSettings(); } catch (e) { this.fail(e); }
    },

    // ---------- drafts
    async copyDraft(d) { await this.copyText(d.text); try { await this.api('PATCH', '/api/drafts/' + d.id, { status: 'הועתק' }); await this.loadDetail(true); } catch (e) { /* ignore */ } },
    async draftStatus(d, st) { try { await this.api('PATCH', '/api/drafts/' + d.id, { status: st }); await this.loadDetail(true); } catch (e) { this.fail(e); } },

    // ---------- protocols
    async loadProtocols() { this.protos = await this.api('GET', '/api/protocols' + (this.protoProject ? '?project=' + this.protoProject : '')); },
    async loadProtocol(id) {
      try { const p = await this.api('GET', '/api/protocols/' + id); if (this.route.name === 'protocols' && this.route.id === id) { this.proto = p; this.protoErr = ''; this.selItems = []; } }
      catch (e) { this.proto = null; this.protoErr = 'הפרוטוקול לא נמצא'; }
    },
    openProtocol(id) { return this.go('/protocols/' + id); },
    protoGroups() {
      const by = new Map();
      for (const p of this.protos) {
        const k = p.project_id || 0;
        if (!by.has(k)) by.set(k, { key: k, name: p.project || 'ללא פרויקט', color: this.pc({ project_color: p.project_color, project_default: p.project_default || !p.project_id }), def: !p.project_id || p.project_default, items: [] });
        by.get(k).items.push(p);
      }
      return [...by.values()].sort((a, b) => String(b.items[0].meeting_at).localeCompare(String(a.items[0].meeting_at)));
    },
    actionItems() { return (this.proto.items || []).filter((i) => i.kind === 'action').sort((a, b) => (b.recommended - a.recommended) || ((a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1)) || a.idx - b.idx); },
    itemsOf(kind) { return (this.proto.items || []).filter((i) => i.kind === kind); },
    toggleSel(id) { this.selItems = this.selItems.includes(id) ? this.selItems.filter((x) => x !== id) : [...this.selItems, id]; },
    async promoteItem(i) {
      try { const r = await this.api('POST', `/api/protocol-items/${i.id}/promote`, {}); this.toast('הסעיף הועבר למשימות'); await Promise.all([this.loadProtocol(this.route.id), this.loadProtocols()]); void r; } catch (e) { this.fail(e); }
    },
    async promoteSelected() {
      try { const r = await this.api('POST', '/api/protocols/promote', { ids: this.selItems }); this.toast(`הועברו ${r.promoted.length} סעיפים למשימות`); await Promise.all([this.loadProtocol(this.route.id), this.loadProtocols()]); } catch (e) { this.fail(e); }
    },
    async itemAction(i, act) {
      try { await this.api('POST', `/api/protocol-items/${i.id}/${act}`, {}); await Promise.all([this.loadProtocol(this.route.id), this.loadProtocols()]); } catch (e) { this.fail(e); }
    },

    // ---------- project card (dated facts)
    isStatusKey(k) { return /סטטוס|מצב/.test(k); },
    sortedFacts() { return [...(this.pp.facts || [])].sort((a, b) => (this.isStatusKey(b.key) - this.isStatusKey(a.key)) || a.key.localeCompare(b.key, 'he')); },
    async openFact(f) {
      this.picker = { type: 'fact', title: f.key, fact: f, history: [], value: f.value, unit: f.unit || '', date: todayISO(), rect: null };
      try { const h = await this.api('GET', `/api/facts?project=${this.pp.project.id}&key=${encodeURIComponent(f.key)}`); if (this.picker && this.picker.fact === f) this.picker.history = h; } catch (e) { this.fail(e); }
    },
    openFactAdd() { this.picker = { type: 'factnew', title: 'נתון חדש בכרטיס', key: '', value: '', unit: '', date: todayISO(), rect: null }; },
    async saveFact() {
      const p = this.picker; const key = p.type === 'fact' ? p.fact.key : p.key.trim();
      try {
        await this.api('POST', '/api/facts', { project: this.pp.project.id, key, value: p.value.trim(), unit: p.unit.trim(), as_of: p.date });
        this.picker = null; this.toast('הנתון נשמר'); await this.loadProjectPage(this.pp.project.id, true);
      } catch (e) { this.fail(e); }
    },
    factSourceLabel(h) { return { email: 'מייל', chat: 'צ׳אט', file: 'מסמך', manual: 'ידני' }[h.source_type] + (h.source && h.source.subject ? ': ' + this.clipText(h.source.subject, 30) : ''); },
    openFactSource(h) { this.picker = null; if (h.source_type === 'email' && h.source_id) this.go('/email/' + h.source_id); else if (h.source_type === 'chat') this.openChat(); else if (h.source_type === 'file' && h.source_id) window.open('/api/files/' + h.source_id + '/download?inline=1', '_blank', 'noopener'); },

    // ---------- misc
    toggleTheme() {
      const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('theme', next); } catch (e) {}
    },
    async logout() {
      try { await this.api('POST', '/api/logout', {}); } catch (e) {}
      location.href = '/login';
    },
  };
}
