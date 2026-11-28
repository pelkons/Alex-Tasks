const CACHE = 'mesimot-v6';
const SHELL = ['/assets/app.css', '/assets/app.js', '/assets/sha256.js', '/assets/layout.js', '/assets/push.js', '/assets/badge-96.png', '/assets/vendor/alpine.min.js', '/assets/vendor/heebo-400.ttf', '/assets/vendor/heebo-500.ttf', '/assets/vendor/heebo-700.ttf', '/assets/icon-192.png', '/assets/logo-64.png', '/assets/favicon-32.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const isShell = url.pathname.startsWith('/assets/');
  const isNav = req.mode === 'navigate' && url.pathname === '/';
  if (!isShell && !isNav) return;
  // network first, fall back to cache when offline
  e.respondWith(fetch(req, { cache: 'no-cache' }).then((res) => {
    if (res.ok && !res.redirected && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req)));
});

// ---- web push (lib/push.js, docs/PUSH.md). The payload is tiny: {t: title, b: one line, u: a path on this site, g: tag, c: category}
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { b: e.data ? e.data.text() : '' }; }
  const url = typeof d.u === 'string' && d.u.startsWith('/') && !d.u.startsWith('//') ? d.u : '/';
  e.waitUntil(self.registration.showNotification(d.t || 'Alex Tasks', {
    body: d.b || '', dir: 'rtl', lang: 'he', tag: d.g || 'alex', renotify: d.c === 'waiting' || d.c === 'system',
    icon: '/assets/icon-192.png', badge: '/assets/badge-96.png', data: { url }, timestamp: Date.now(),
  }));
});
// a tap opens the right page: an open window of the app is focused and moved there, otherwise a new one opens.
// If the session expired, the server sends the page to the login, which returns to this link after signing in.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const mine = wins.filter((w) => new URL(w.url).origin === self.location.origin);
    const w = mine.find((x) => x.focused) || mine.find((x) => x.visibilityState === 'visible') || mine[0];
    if (w) {
      try { await w.focus(); } catch (x) { /* not allowed: open a new one below */ }
      // the running app moves there itself (no reload) and answers; a page that does not answer (login, landing, an old version) is navigated
      const ok = await new Promise((res) => { try { const ch = new MessageChannel(); const t = setTimeout(() => res(false), 1200); ch.port1.onmessage = () => { clearTimeout(t); res(true); }; w.postMessage({ type: 'push-open', url }, [ch.port2]); } catch (x) { res(false); } });
      if (ok) return;
      try { if (w.navigate) { await w.navigate(url); return; } } catch (x) { /* fall through */ }
    }
    await self.clients.openWindow(url);
  })());
});
// the browser replaced the subscription (keys rotated): register the new one with the server, with the session cookie
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    try {
      const old = e.oldSubscription;
      const key = await (await fetch('/api/push/key', { credentials: 'same-origin' })).json();
      const sub = e.newSubscription || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key.key });
      await fetch('/api/push/subscribe', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Mesimot': '1' }, body: JSON.stringify({ subscription: sub.toJSON() }) });
      if (old) await fetch('/api/push/unsubscribe', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Mesimot': '1' }, body: JSON.stringify({ endpoint: old.endpoint }) });
    } catch (x) { /* the settings screen re-registers on the next visit */ }
  })());
});
