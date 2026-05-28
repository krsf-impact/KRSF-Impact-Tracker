// KRSF Beneficiary Impact Tracker — Service Worker
// V352 — App shell caching for PWA install.
//
// Strategy:
//   - HTML app shell: stale-while-revalidate (instant load, refresh in background)
//   - Manifest + icons: cache-first (rarely changes)
//   - Firebase API calls: NEVER cache (always go to network, fresh data)
//   - Everything else: network-first, fall back to cache
//
// Bump CACHE_VERSION whenever you change this file or want to force re-fetch.
// The activate event prunes old caches automatically.

const CACHE_VERSION = 'krsf-v352-1';
const APP_CACHE = 'krsf-app-' + CACHE_VERSION;

// Files cached on install. Keep this list small — the SW intercepts everything
// at runtime anyway, so we only need to pre-cache the absolute essentials.
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

// Hosts that should NEVER be cached — these are live data sources.
const NETWORK_ONLY_HOSTS = [
  'firebaseio.com',
  'firebasedatabase.app',
  'googleapis.com',
  'identitytoolkit.googleapis.com',
  'firebaseinstallations.googleapis.com',
  'firebase.googleapis.com'
];

self.addEventListener('install', function(event) {
  console.log('[SW] install', CACHE_VERSION);
  event.waitUntil(
    caches.open(APP_CACHE).then(function(cache) {
      return cache.addAll(PRECACHE_URLS).catch(function(err) {
        console.warn('[SW] precache partial:', err);
      });
    }).then(function() {
      // Activate this SW immediately, without waiting for old tabs to close.
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(event) {
  console.log('[SW] activate', CACHE_VERSION);
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== APP_CACHE && k.indexOf('krsf-app-') === 0; })
            .map(function(k) { console.log('[SW] prune', k); return caches.delete(k); })
      );
    }).then(function() {
      // Take control of open tabs immediately.
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(event) {
  const req = event.request;
  if (req.method !== 'GET') return;  // only intercept GETs

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // 1) Never cache live data. Pass through to network.
  for (let i = 0; i < NETWORK_ONLY_HOSTS.length; i++) {
    if (url.hostname.indexOf(NETWORK_ONLY_HOSTS[i]) !== -1) return;
  }

  // 2) HTML navigation: stale-while-revalidate.
  //    Serve cached HTML instantly, fetch fresh copy in background for next time.
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').indexOf('text/html') !== -1) {
    event.respondWith(
      caches.open(APP_CACHE).then(function(cache) {
        return cache.match('./index.html').then(function(cached) {
          const networkPromise = fetch(req).then(function(resp) {
            if (resp && resp.ok) cache.put('./index.html', resp.clone());
            return resp;
          }).catch(function() { return cached; });
          return cached || networkPromise;
        });
      })
    );
    return;
  }

  // 3) Cached static assets (icons, manifest): cache-first.
  event.respondWith(
    caches.match(req).then(function(cached) {
      if (cached) return cached;
      return fetch(req).then(function(resp) {
        if (resp && resp.ok && url.origin === self.location.origin) {
          const respClone = resp.clone();
          caches.open(APP_CACHE).then(function(cache) { cache.put(req, respClone); });
        }
        return resp;
      }).catch(function() { return cached; });
    })
  );
});

// Allow the page to message the SW (e.g., to force-update).
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
