// KRSF Beneficiary Impact Tracker — Service Worker
// V399 — Always-fresh app shell (fixes the "stuck on an old version" problem).
//
// Strategy:
//   - HTML app shell: NETWORK-FIRST. When online, always fetch the latest
//     index.html from the server, so a device can NEVER get stuck on an old
//     version. Falls back to the cached copy if the network is unavailable or
//     slower than NETWORK_TIMEOUT_MS — so the PWA still opens offline and stays
//     fast on a poor connection. (V352 used stale-while-revalidate, which could
//     wedge a device on an old version — the V398 incident.)
//   - Manifest + icons: cache-first (rarely change).
//   - Firebase API calls: NEVER cache (always live data).
//   - Everything else: network-first, fall back to cache.
//
// Bump CACHE_VERSION whenever you change this file. activate prunes old caches;
// the page auto-reloads onto the new worker (skipWaiting + clients.claim).

const CACHE_VERSION = 'krsf-v399-1';
const APP_CACHE = 'krsf-app-' + CACHE_VERSION;
const NETWORK_TIMEOUT_MS = 3000;

// Files cached on install (the offline fallback set). Kept small — the SW
// intercepts everything at runtime anyway.
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

// Hosts that must NEVER be cached — these are live data sources.
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
      // Fetch the shell FRESH on install (bypass the HTTP cache) so a new
      // worker never seeds itself with a stale page.
      return Promise.all(PRECACHE_URLS.map(function(u) {
        return fetch(new Request(u, { cache: 'reload' })).then(function(resp) {
          if (resp && resp.ok) return cache.put(u, resp);
        }).catch(function(){ /* offline at install time — ignore */ });
      }));
    }).then(function() {
      // Activate immediately, without waiting for old tabs to close.
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
      // Take control of open tabs immediately → triggers controllerchange in
      // the page, which auto-reloads onto this new version.
      return self.clients.claim();
    })
  );
});

// Network-first for the HTML shell, with a cached fallback + timeout.
//   - online  : returns the freshest index.html (can't get stuck on old).
//   - offline : returns the cached copy.
//   - slow net: after NETWORK_TIMEOUT_MS, serves cached so app start stays fast;
//               the network copy still updates the cache for next time.
function networkFirstHTML(req) {
  return caches.open(APP_CACHE).then(function(cache) {
    return new Promise(function(resolve) {
      var settled = false;
      function finish(r) { if (!settled) { settled = true; resolve(r); } }
      // Fast fallback so a flaky connection never blocks the app from opening.
      var timer = setTimeout(function() {
        cache.match('./index.html').then(function(cached) { if (cached) finish(cached); });
      }, NETWORK_TIMEOUT_MS);
      fetch(req).then(function(resp) {
        clearTimeout(timer);
        if (resp && resp.ok) {
          // Keep the offline copy current for next time.
          cache.put('./index.html', resp.clone()).catch(function(){});
          finish(resp);
        } else {
          cache.match('./index.html').then(function(cached) { finish(cached || resp); });
        }
      }).catch(function() {
        clearTimeout(timer);
        cache.match('./index.html').then(function(cached) {
          finish(cached || new Response('Offline and no cached copy available yet.',
            { status: 503, headers: { 'Content-Type': 'text/plain' } }));
        });
      });
    });
  });
}

self.addEventListener('fetch', function(event) {
  const req = event.request;
  if (req.method !== 'GET') return;  // only intercept GETs

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // 1) Never cache live data. Pass through to network.
  for (let i = 0; i < NETWORK_ONLY_HOSTS.length; i++) {
    if (url.hostname.indexOf(NETWORK_ONLY_HOSTS[i]) !== -1) return;
  }

  // 2) HTML navigation: network-first (always fresh when online).
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').indexOf('text/html') !== -1) {
    event.respondWith(networkFirstHTML(req));
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
