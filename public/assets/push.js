/* Web push on this device (docs/PUSH.md): the settings switch, the test button, the categories, and the "site is open" signal.
   Permission is asked ONLY from the switch (a tap), never on page load. Merged into the Alpine app by app.js. */
(function () {
  const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const ios = () => /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = () => { try { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch (e) { return false; } };
  const b64 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...raw].map((c) => c.charCodeAt(0))); };
  const reg = () => Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('אין Service Worker פעיל. רעננו את הדף ונסו שוב')), 8000))]);

  window.MesimotPush = {
    state: () => ({ loaded: false, supported: false, perm: 'default', subscribed: false, devices: 0, cats: [], busy: false, err: '', ios: false, standalone: false, endpoint: null }),
    methods: {
      // the state word next to the switch
      pushWord() {
        const p = this.push;
        if (!p.loaded) return 'בודק…';
        if (!p.supported) return 'לא נתמך';
        if (p.perm === 'denied') return 'חסום בדפדפן';
        return p.subscribed ? 'מופעל' : 'כבוי';
      },
      async pushLoad() {
        const p = this.push; p.err = ''; p.ios = ios(); p.standalone = standalone(); p.supported = supported();
        p.perm = p.supported ? Notification.permission : 'default';
        let sub = null;
        if (p.supported) { try { sub = await (await reg()).pushManager.getSubscription(); } catch (e) { /* no worker yet */ } }
        p.endpoint = sub ? sub.endpoint : null;
        try {
          const st = await this.api('GET', '/api/push/status' + (sub ? '?endpoint=' + encodeURIComponent(sub.endpoint) : ''));
          p.cats = st.categories; p.devices = st.devices; p.subscribed = !!st.subscribed;
          // the browser still has a subscription the server forgot (removed after an error): register it again, permission is already there
          if (sub && !st.subscribed && p.perm === 'granted') { const r = await this.api('POST', '/api/push/subscribe', { subscription: sub.toJSON() }); p.subscribed = !!r.subscribed; p.devices = r.devices; }
        } catch (e) { p.err = e.message; }
        p.loaded = true;
      },
      // the switch: ON asks the browser for permission (this tap is the user gesture), subscribes and tells the server; OFF removes this device
      async pushToggle(on) {
        const p = this.push; if (p.busy) return; p.busy = true; p.err = '';
        try {
          if (on) {
            if (!p.supported) throw new Error(p.ios && !p.standalone ? 'באייפון: קודם מוסיפים את האפליקציה למסך הבית ופותחים אותה משם' : 'הדפדפן הזה לא תומך בהתראות');
            const perm = await Notification.requestPermission(); p.perm = perm;
            if (perm !== 'granted') throw new Error(perm === 'denied' ? 'ההתראות חסומות בדפדפן. ראו את ההסבר למטה' : 'לא ניתן אישור להתראות');
            const r = await reg();
            const { key } = await this.api('GET', '/api/push/key');
            let sub = await r.pushManager.getSubscription();
            if (sub && sub.options && sub.options.applicationServerKey) { const a = new Uint8Array(sub.options.applicationServerKey), k = b64(key); if (a.length !== k.length || a.some((x, i) => x !== k[i])) { await sub.unsubscribe(); sub = null; } }
            if (!sub) sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
            const st = await this.api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
            p.subscribed = !!st.subscribed; p.devices = st.devices; p.endpoint = sub.endpoint;
            this.toast('ההתראות הופעלו במכשיר הזה');
          } else {
            let ep = p.endpoint;
            try { const sub = await (await reg()).pushManager.getSubscription(); if (sub) { ep = sub.endpoint; await sub.unsubscribe(); } } catch (e) { /* the server side is removed anyway */ }
            if (ep) await this.api('POST', '/api/push/unsubscribe', { endpoint: ep });
            p.subscribed = false; p.endpoint = null; this.toast('ההתראות כובו במכשיר הזה');
          }
        } catch (e) { p.err = e.message || 'שגיאה'; }
        p.busy = false;
        await this.pushLoad();
      },
      async pushTest() {
        const p = this.push; p.busy = true; p.err = '';
        try { const r = await this.api('POST', '/api/push/test', {}); this.toast(r.sent ? `נשלחה התראת בדיקה (${r.devices === 1 ? 'מכשיר אחד' : r.devices + ' מכשירים'})` : r.retrying ? 'שירות ההתראות לא ענה. ננסה שוב בעוד דקה' : 'השליחה נכשלה'); }
        catch (e) { p.err = e.message; }
        p.busy = false;
      },
      async pushCat(id, on) {
        try { await this.api('POST', '/api/push/settings', { [id]: !!on }); const c = this.push.cats.find((x) => x.id === id); if (c) c.on = !!on; this.toast('נשמר'); }
        catch (e) { this.fail(e); await this.pushLoad(); }
      },
      // while a page of the site is visible, tell the server every 30 s (the assistant's chat replies are pushed only when no page is open)
      pushPresence() {
        const ping = () => { if (document.visibilityState === 'visible') fetch('/api/push/seen', { method: 'POST', headers: { 'X-Mesimot': '1' }, credentials: 'same-origin' }).catch(() => {}); };
        ping(); setInterval(ping, 30000); document.addEventListener('visibilitychange', ping);
      },
      // a tapped notification while the app is open: the service worker asks this page to move there (no reload) and waits for the answer
      pushListen() {
        if (!('serviceWorker' in navigator)) return;
        navigator.serviceWorker.addEventListener('message', (e) => {
          const d = e.data || {}; if (d.type !== 'push-open' || typeof d.url !== 'string') return;
          let u; try { u = new URL(d.url, location.origin); } catch (x) { return; }
          if (u.origin !== location.origin) return;
          this.go(u.pathname + u.search);
          if (e.ports && e.ports[0]) e.ports[0].postMessage('ok');
        });
      },
    },
  };
})();
