// Lnkbase Newsletter service worker — deliberately minimal.
// - Caches static assets (/static/*) and an offline page, nothing else.
// - Dashboard HTML (private data) and every API / form request always go to the network and are NEVER cached.
// - When a dashboard navigation fails because the device is offline, the offline page is shown instead.
const VERSION = 'v1';
const STATIC_CACHE = `lnk-static-${VERSION}`;
const OFFLINE_URL = '/offline';
const PRECACHE = [OFFLINE_URL, '/static/app.css', '/static/app.js', '/static/favicon.svg', '/static/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('lnk-') && k !== STATIC_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Dashboard pages: network only; offline page when the network is unreachable. Responses are not stored.
  if (req.mode === 'navigate') {
    if (!url.pathname.startsWith('/app')) return;
    event.respondWith(fetch(req).catch(async () => (await caches.match(OFFLINE_URL)) || new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } })));
    return;
  }

  // Static assets: stale-while-revalidate (these files hold no private data).
  if (url.pathname.startsWith('/static/') && !url.pathname.startsWith('/static/shots/')) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC_CACHE);
      const hit = await cache.match(req);
      const net = fetch(req).then((res) => {
        if (res.ok && res.type === 'basic') cache.put(req, res.clone());
        return res;
      }).catch(() => hit);
      return hit || net;
    })());
  }
  // Everything else (media, API, JSON, publication sites) is left to the browser.
});
