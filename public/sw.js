const CACHE_NAME = 'factura-clara-static-v1';
const CACHE_PREFIX = 'factura-clara-static-';
const STATIC_ASSETS = [
  '/styles.css', '/app.js', '/manifest.webmanifest', '/offline.html',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Fiscal data, account data, screenshots, downloads, and MCP always go to the server.
  if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request, { cache: 'no-store' })
      .catch(async () => (await caches.match('/offline.html')) || Response.error()));
    return;
  }

  if (url.search || !STATIC_ASSETS.includes(url.pathname)) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    } catch {
      return (await caches.match(request)) || Response.error();
    }
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});
