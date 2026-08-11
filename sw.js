/* Docket service worker.
   Bump CACHE when you change index.html so phones pick up the new version. */
const CACHE = 'docket-v36';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Our own /api endpoints (Instagram proxy) must always hit the network.
  if (url.pathname.startsWith('/api/')) return;

  // Firebase auth + Firestore APIs: never cache, always hit the network.
  if ((url.hostname === 'firestore.googleapis.com' ||
       url.hostname === 'identitytoolkit.googleapis.com' ||
       url.hostname === 'securetoken.googleapis.com' ||
       url.hostname.endsWith('firebaseio.com'))) return;

  // gstatic (Firebase SDK + fonts) and Google Fonts: cache-first for offline.
  const cacheFirst =
    url.hostname.endsWith('gstatic.com') ||
    url.hostname.endsWith('fonts.googleapis.com');

  // Fonts + libraries: serve from cache first, refill in the background.
  if (cacheFirst) {
    e.respondWith(
      caches.match(req).then(hit =>
        hit || fetch(req).then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
          return res;
        }).catch(() => hit)
      )
    );
    return;
  }

  // App shell: try the network so updates land, fall back to cache offline.
  e.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
  );
});
