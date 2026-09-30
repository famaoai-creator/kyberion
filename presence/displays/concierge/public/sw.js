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
