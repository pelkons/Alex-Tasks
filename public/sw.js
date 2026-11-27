const CACHE = 'mesimot-v5';
const SHELL = ['/assets/app.css', '/assets/app.js', '/assets/sha256.js', '/assets/layout.js', '/assets/vendor/alpine.min.js', '/assets/vendor/heebo-400.ttf', '/assets/vendor/heebo-500.ttf', '/assets/vendor/heebo-700.ttf', '/assets/icon-192.png', '/assets/logo-64.png', '/assets/favicon-32.png'];

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
