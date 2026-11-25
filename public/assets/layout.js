/* Desktop split-pane layout (>= 1024px): resizable dividers, persisted widths, automatic chat collapse, row density.
   Widths live in CSS variables (--chat-w, --card-w, --page-w). Everything works with pointer events (mouse, touch, pen) and the keyboard. */
(function () {
  // the task list keeps 360px (its rows carry a lot); the project list may go down to 180px and the protocols list to 220px
  const LIMITS = { chat: [300, 640], card: [360, Infinity], listMin: 360, plist: 180, tlist: 220, pageMin: 360, div: 14, bar: 52, padding: 40 };
  const KEYS = { chat: 'chat', card: 'card', page: 'page', plist: 'plist', tlist: 'tlist' };
  const root = document.documentElement;
  let state = { chat: null, card: null, page: null, plist: null, tlist: null, collapsed: false };   // null = the default of this viewport
  let tooNarrow = false;

  const vw = () => window.innerWidth;
  const cls = () => (vw() >= 1600 ? 'xl' : vw() >= 1280 ? 'lg' : 'md');     // widths are remembered per viewport class
  const storeKey = () => 'mesimot.layout.v1.' + cls();
  const read = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } };
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const desktop = () => vw() >= 1024;
  const cardOpen = () => !!document.querySelector('.split.has-task');

  const defaults = () => ({ chat: clamp(Math.round(vw() * 0.24), 340, 420), card: clamp(Math.round(vw() * 0.32), 380, 560), page: clamp(Math.round(vw() * 0.46), 480, 900), plist: 260, tlist: 300 });
  const kindOfSplit = () => (document.querySelector('.split .proj-list') ? 'proj' : document.querySelector('.split .proto-list') ? 'proto' : 'task');
  const listMinOf = () => ({ proj: LIMITS.plist, proto: LIMITS.tlist, task: LIMITS.listMin })[kindOfSplit()];
  function load() {
    state = { chat: null, card: null, page: null, plist: null, tlist: null, collapsed: false };
    try { const o = JSON.parse(read(storeKey()) || '{}'); for (const k of ['chat', 'card', 'page', 'plist', 'tlist']) if (Number.isFinite(o[k])) state[k] = o[k]; state.collapsed = !!o.collapsed; } catch (e) { /* ignore */ }
  }
  const save = () => write(storeKey(), JSON.stringify(state));

  // how much room is there for each pane right now
  function budget(open) {
    const total = vw() - LIMITS.padding;
    const chatMin = LIMITS.chat[0] + LIMITS.div;
    const needAll = listMinOf() + chatMin + (open ? (kindOfSplit() === 'task' ? LIMITS.card[0] : LIMITS.pageMin) + LIMITS.div : 0);
    return { total, needAll };
  }
  function effective() {
    const d = defaults();
    const open = cardOpen();
    const { total, needAll } = budget(open);
    tooNarrow = total < needAll;
    const collapsed = state.collapsed || tooNarrow;
    const chatBox = collapsed ? LIMITS.bar : 0;
    // chat: its own limits, and it may not push the list below its minimum
    let chat = clamp(state.chat ?? d.chat, LIMITS.chat[0], LIMITS.chat[1]);
    const cardWant = open ? clamp(state.card ?? d.card, LIMITS.card[0], Math.max(LIMITS.card[0], Math.round(vw() * 0.6))) : 0;
    if (!collapsed) chat = Math.min(chat, Math.max(LIMITS.chat[0], total - listMinOf() - (open ? (kindOfSplit() === 'task' ? LIMITS.card[0] : LIMITS.pageMin) + LIMITS.div : 0) - LIMITS.div));
    const avail = vw() - (collapsed ? chatBox : chat) - LIMITS.padding - LIMITS.div - (open ? LIMITS.div : 0);
    // card (home) and page (projects, protocols): up to 60% of the viewport, and the list keeps its minimum
    const maxCard = Math.max(LIMITS.card[0], Math.min(Math.round(vw() * 0.6), avail - LIMITS.listMin));
    const card = clamp(state.card ?? d.card, LIMITS.card[0], maxCard);
    const page = clamp(state.page ?? d.page, LIMITS.card[0], maxCard);
    void cardWant;
    // project and protocol lists: their own width (the page takes the rest)
    const split = document.querySelector('.split');
    const sw = split ? split.getBoundingClientRect().width : avail + LIMITS.div;
    const maxList = Math.max(LIMITS.plist, Math.round(sw - LIMITS.pageMin - LIMITS.div));
    const plist = clamp(state.plist ?? d.plist, LIMITS.plist, maxList), tlist = clamp(state.tlist ?? d.tlist, LIMITS.tlist, Math.max(LIMITS.tlist, maxList));
    return { chat, card, page, plist, tlist, collapsed, maxCard, maxList };
  }
  function apply() {
    if (!desktop()) { document.body.classList.remove('chat-collapsed'); return; }
    const e = effective();
    root.style.setProperty('--chat-w', e.chat + 'px');
    root.style.setProperty('--card-w', e.card + 'px');
    root.style.setProperty('--page-w', e.page + 'px');
    root.style.setProperty('--plist-w', e.plist + 'px');
    root.style.setProperty('--tlist-w', e.tlist + 'px');
    document.body.classList.toggle('chat-collapsed', e.collapsed);
    for (const d of document.querySelectorAll('.divider')) {
      const k = d.dataset.pane;
      const [lo, hi] = k === 'chat' ? LIMITS.chat : k === 'plist' ? [LIMITS.plist, e.maxList] : k === 'tlist' ? [LIMITS.tlist, e.maxList] : [LIMITS.card[0], e.maxCard];
      d.setAttribute('aria-valuemin', String(lo)); d.setAttribute('aria-valuemax', String(Math.round(hi)));
      d.setAttribute('aria-valuenow', String(Math.round(e[k])));
    }
  }

  // ---- dragging (pointer events: mouse, touch, pen)
  let drag = null;
  function widthFromPointer(kind, x, el) {
    if (kind === 'chat') return x;                                   // the chat column starts at the left edge of the window
    const split = el.closest('.split');
    if (kind === 'plist' || kind === 'tlist') return split.getBoundingClientRect().right - x;   // these lists sit at the start (right) edge
    const left = split.getBoundingClientRect().left;                 // the card sits at the end side of the list, its far edge is the split's left edge
    return x - left;
  }
  function setWidth(kind, w) {
    const e = effective();
    const lst = kind === 'plist' || kind === 'tlist';
    const hi = kind === 'chat' ? LIMITS.chat[1] : lst ? e.maxList : e.maxCard;
    const lo = kind === 'chat' ? LIMITS.chat[0] : kind === 'plist' ? LIMITS.plist : kind === 'tlist' ? LIMITS.tlist : LIMITS.card[0];
    state[KEYS[kind]] = Math.round(clamp(w, lo, hi));
    apply();
  }
  document.addEventListener('pointerdown', (ev) => {
    const el = ev.target.closest && ev.target.closest('.divider');
    if (!el || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
    ev.preventDefault();
    drag = { el, kind: el.dataset.pane, id: ev.pointerId };
    try { el.setPointerCapture(ev.pointerId); } catch (e) { /* not capturable */ }
    el.classList.add('dragging'); document.body.classList.add('dragging-pane');
  });
  document.addEventListener('pointermove', (ev) => { if (drag && ev.pointerId === drag.id) setWidth(drag.kind, widthFromPointer(drag.kind, ev.clientX, drag.el)); });
  const end = (ev) => { if (!drag || (ev && ev.pointerId !== drag.id)) return; drag.el.classList.remove('dragging'); document.body.classList.remove('dragging-pane'); drag = null; save(); };
  document.addEventListener('pointerup', end); document.addEventListener('pointercancel', end);
  document.addEventListener('dblclick', (ev) => {
    const el = ev.target.closest && ev.target.closest('.divider');
    if (!el) return;
    state[KEYS[el.dataset.pane]] = null; save(); apply();                       // back to the default width
  });
  document.addEventListener('keydown', (ev) => {
    const el = ev.target.closest && ev.target.closest('.divider');
    if (!el || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
    ev.preventDefault();
    const kind = el.dataset.pane, e = effective();
    const step = ev.shiftKey ? 64 : 16;
    // the divider sits at the end (left) edge of its pane's neighbour: moving it right widens the pane on its left
    if (ev.key === 'Home') { state[KEYS[kind]] = null; save(); apply(); return; }
    if (ev.key === 'End') { setWidth(kind, kind === 'chat' ? LIMITS.chat[1] : (kind === 'plist' || kind === 'tlist') ? e.maxList : e.maxCard); save(); return; }
    // the arrows move the divider: right widens the pane on its left (chat, card) and narrows the list on its right (project and protocol lists)
    const lst = kind === 'plist' || kind === 'tlist';
    setWidth(kind, e[kind] + ((ev.key === 'ArrowRight') !== lst ? step : -step));
    save();
  });

  // ---- chat collapse (by hand, and automatically when the window cannot hold all panes)
  function setCollapsed(v) { state.collapsed = !!v; save(); apply(); }
  // opening the chat again when the window is too narrow for all panes needs room: the card pane closes first
  function reopenNeedsRoom() { return tooNarrow; }

  // ---- row density
  const density = () => { const d = read('mesimot.density'); return ['compact', 'regular', 'large'].includes(d) ? d : 'regular'; };
  function setDensity(d) { if (!['compact', 'regular', 'large'].includes(d)) return; write('mesimot.density', d); document.body.dataset.density = d; }

  // --top is the real height of the header (it differs with fonts, zoom and Windows scaling): the shell below it is exactly the rest of the viewport
  function measureTop() {
    const h = document.querySelector('header.topbar, .topbar');
    if (h && desktop()) root.style.setProperty('--top', Math.ceil(h.getBoundingClientRect().height) + 'px');
  }
  // every pane keeps its own scroll position, also across a card opening or closing (the list reflows, its position is put back)
  const snap = new Map();
  function snapshot() { snap.clear(); for (const e of document.querySelectorAll('.pane-list')) snap.set(e, e.scrollTop); }
  function restore() { for (const [e, t] of snap) if (e.isConnected && t) requestAnimationFrame(() => { if (Math.abs(e.scrollTop - t) > 2) e.scrollTop = t; }); }
  function restoreScroll() { /* done by snapshot() and restore(), called around every route change */ }
  function boot() {
    load(); document.body.dataset.density = density(); measureTop(); apply();
    let t = null;
    window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => { measureTop(); const before = cls(); if (before !== window.__layoutCls) { window.__layoutCls = before; load(); } apply(); }, 60); });
    window.__layoutCls = cls();
    // panes open and close with the route: re-check the room each time
    new MutationObserver(() => { apply(); restoreScroll(); }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
  }
  window.MesimotLayout = { snapshot, restore, setCollapsed, setDensity, density, apply, reopenNeedsRoom, state: () => ({ ...state }), effective, cls };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
