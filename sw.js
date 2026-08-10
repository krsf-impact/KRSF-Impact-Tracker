// KRSF Beneficiary Impact Tracker — Service Worker
// V400 — Always-fresh app shell (fixes the "stuck on an old version" problem).
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
// V400: the "network-first" HTML fetch was silently vulnerable to the
// BROWSER's own HTTP cache — GitHub Pages sets Cache-Control: max-age=600,
// and a plain fetch(req) can be satisfied entirely from the browser's disk
// cache within that window, never touching the network at all despite this
// function's whole purpose. Real incident: pushing a new version and
// reloading within 10 minutes of the previous visit kept showing the OLD
// version. Fixed in networkFirstHTML() by forcing { cache: 'reload' } on
// the runtime fetch, same explicit bypass the install handler already used.
//
// Bump CACHE_VERSION whenever you change this file. activate prunes old caches;
// the page auto-reloads onto the new worker (skipWaiting + clients.claim).

const CACHE_VERSION = 'krsf-v8-0';
const APP_CACHE = 'krsf-app-' + CACHE_VERSION;
const NETWORK_TIMEOUT_MS = 3000;

// V6.8.3: the 10 achievement badges on the FC "My Badges" tab (~89 KB total),
// hosted on Cloudinary rather than inlined into index.html — the HTML shell is
// fetched NETWORK-FIRST on every app open, so inlined bytes are re-downloaded
// on every single launch, forever.
//
// They are deliberately NOT in PRECACHE_URLS, and deliberately NOT in
// APP_CACHE. Two reasons, both about not making anyone pay for bytes they
// don't use:
//   1. Precaching at install charges all 89 KB to EVERY user — including
//      admins, NGO admins and viewers, who have no My Badges tab at all — and
//      stalls the install on a slow field connection.
//   2. APP_CACHE is pruned on every CACHE_VERSION bump (see activate), so the
//      badges would be re-downloaded on every release that touches this file.
// Instead they are cached lazily, on first view, into their own cache that the
// activate prune leaves alone (it only deletes `krsf-app-*`). Net effect: an FC
// downloads them ONCE, ever — not per login, not per release — and only if they
// actually open the tab. Everyone else downloads nothing.
const BADGE_CACHE = 'krsf-badges-v1';
const BADGE_PATH = '/krsf_badges/';

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
      // Only app-shell caches are pruned. BADGE_CACHE ('krsf-badges-v1') is
      // intentionally outside this prefix so badge artwork survives every
      // release — an FC downloads those 89 KB once per device, not once per
      // version. Rename BADGE_CACHE only if the artwork itself changes.
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
//
// V400 fix: this used to call fetch(req) directly — passing the original
// navigation Request straight through. That Request carries the BROWSER's
// normal HTTP cache semantics, and GitHub Pages serves index.html with
// `Cache-Control: max-age=600`. So "network-first" was only network-first in
// name: within 10 minutes of a previous visit to the same URL, the browser's
// own disk cache could transparently satisfy fetch(req) with a STALE
// response, and this code had no way to tell the difference — it just saw
// something that looked like a successful fetch and cached it right back.
// Confirmed live: pushing V6.5 and reloading within that 10-minute window
// kept showing V6.1 despite this function's entire reason for existing.
// Fixed by building a fresh Request that bypasses the browser's HTTP cache.
//
// V16.9: that fix used { cache: 'reload' }, which forces a FULL re-download of
// index.html on every single app open. Measured against the live site, that is
// 1,002,526 bytes each time a coordinator opens the app - several MB a day out
// of their own mobile data, for a file that usually has not changed.
// { cache: 'no-cache' } keeps the V400 guarantee exactly: the browser must
// still revalidate with the SERVER before using any cached copy, so a stale
// version can never be served silently - that was the whole bug. The only
// difference is that it sends the conditional headers, so an unchanged file
// comes back as 304 Not Modified with an EMPTY body and the browser hands us
// the cached bytes. Verified against GitHub Pages: conditional GET on
// index.html returns "HTTP 304, 0 bytes". A changed file still returns 200
// with the new content, so releases reach the fleet exactly as before.
// If a proxy ever strips the validators, the server answers 200 with the full
// body and behaviour falls back to what it is today. Strictly better.
//
// Original V400 note, kept because it explains WHY the plain fetch was wrong:
// Fixed by building a fresh Request with an explicit cache mode, the same
// explicit bypass the install handler already correctly uses below — this
// forces an actual round-trip to the server every time, not just whenever
// the browser's HTTP cache happens to have expired.
function networkFirstHTML(req) {
  return caches.open(APP_CACHE).then(function(cache) {
    return new Promise(function(resolve) {
      var settled = false;
      function finish(r) { if (!settled) { settled = true; resolve(r); } }
      // Fast fallback so a flaky connection never blocks the app from opening.
      var timer = setTimeout(function() {
        cache.match('./index.html').then(function(cached) { if (cached) finish(cached); });
      }, NETWORK_TIMEOUT_MS);
      fetch(new Request(req.url, { cache: 'no-cache' })).then(function(resp) {
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

  // 3) Badge artwork: cache-first into its own long-lived cache. Written on
  // first view and then never fetched again — not per login, not per release.
  //
  // ignoreVary is required here: Cloudinary sends `Vary: Accept, User-Agent`,
  // so a Vary-aware match can miss an entry that is plainly present and go
  // back to the network every time (blank badges offline, despite being
  // cached). Confirmed against the live CDN, not assumed.
  if (url.href.indexOf(BADGE_PATH) !== -1) {
    event.respondWith(
      caches.open(BADGE_CACHE).then(function(cache) {
        return cache.match(req, { ignoreVary: true }).then(function(cached) {
          if (cached) return cached;
          return fetch(req).then(function(resp) {
            if (resp && resp.ok) cache.put(req, resp.clone()).catch(function(){});
            return resp;
          }).catch(function() {
            // Offline and not cached yet — let it fail so the page's onerror
            // swaps in the 🏅 placeholder rather than hanging on a dead image.
            return cached || Response.error();
          });
        });
      })
    );
    return;
  }

  // 4) Cached static assets (icons, manifest): cache-first.
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
