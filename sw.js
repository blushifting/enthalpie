// Service worker Enthalpie — app-shell offline.
// Stratégie : stale-while-revalidate pour les ressources même-origine (chargement
// instantané + mise à jour en arrière-plan) ; réseau direct pour l'API Apps Script
// et OpenFoodFacts (jamais cachées — la couche localStorage gère déjà le cache métier).
// Bump CACHE à chaque release pour purger l'ancien app-shell.
const CACHE = 'enthalpie-shell-v1';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/api.js',
  './js/store.js',
  './js/sync.js',
  './js/config.js',
  './js/util.js',
  './js/engine.js',
  './js/quoimanger.js',
  './js/today.js',
  './js/courses.js',
  './icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                  // POST API → réseau (jamais caché)
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // script.google.com, OFF… → réseau direct
  e.respondWith(staleWhileRevalidate(req));
});

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });
  const fetching = fetch(req)
    .then((res) => {
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await fetching) || fetch(req);
}
