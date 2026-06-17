// DealCheck SW v2 — never cache index.html
const CACHE = 'dealcheck-v2';
const STATIC = ['/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Never cache HTML or API — always network
  const url = new URL(e.request.url);
  if (e.request.headers.get('accept')?.includes('text/html')) return;
  if (url.pathname.startsWith('/api/')) return;
  
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
