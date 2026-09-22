// Bump this on every deploy that changes app files. Changing this string changes
// sw.js's own bytes, which is what makes the browser notice there's an update at
// all -- a byte-identical sw.js is never re-installed, no matter how much
// index.html changed on the server.
const CACHE_NAME = 'tripcost-v2';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept cross-origin calls (e.g. exchange-rate API, Firebase, Drive) --
  // always go straight to the network for those.
  if (url.origin !== self.location.origin) return;

  // Network-first for same-origin app files: while online, always fetch the
  // current version from the server and refresh the cache with it. Only fall
  // back to whatever's cached when there's no connectivity at all. This is what
  // makes "I pushed an update" actually show up on next reload instead of being
  // stuck on whatever was cached the very first time the app was opened.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
