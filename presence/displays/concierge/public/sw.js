/* global self, caches, fetch */
/* Concierge service worker — installability + offline notice only.
 *
 * Deliberately caches NOTHING but the offline page: approvals, summaries and
 * identity are live, authenticated data. Serving them stale would let a person
 * decide on facts that have already changed. API and non-GET requests are never
 * intercepted. Bump CACHE to invalidate. */
const CACHE = 'concierge-shell-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(OFFLINE_URL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;
  event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
});

/* Web Push — a content-free nudge. The payload is only a fixed title/line the
 * server chose (never a decision's title, id, tenant or amount); tapping it opens
 * the app, where the real, authenticated queue is. Anything malformed still shows
 * the generic line rather than nothing, so a missed alert is never silent. */
self.addEventListener('push', (event) => {
  let title = 'Kyberion';
  let body = '';
  try {
    const data = event.data ? event.data.json() : {};
    if (typeof data.title === 'string') title = data.title.slice(0, 80);
    if (typeof data.body === 'string') body = data.body.slice(0, 160);
  } catch (_) {
    // Fall through to the generic notification.
  }
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      tag: 'kyberion-decide',
      data: { url: '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('/');
    })
  );
});
