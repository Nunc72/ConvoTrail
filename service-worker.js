// Convooz service worker.
//
// Why we have one: iOS Safari in PWA standalone mode caches the original
// install-time HTML for the start_url indefinitely and ignores
// Cache-Control headers on subsequent fetches. That meant every kill +
// re-open landed on the build the user first installed, with no way to
// roll a new release out short of re-installing the PWA.
//
// Strategy:
//  - Navigation requests (HTML): network-first. Fall back to cache only if
//    the user is offline. The fresh response is also written to the cache
//    so a later offline open still works.
//  - Same-origin static (CSS, JSON, images): network-first too — same
//    reason; we want any deploy of polish.css or version.json to win
//    immediately. Cached response is the offline fallback.
//  - Cross-origin (CDN scripts): we don't intercept these. The browser
//    handles them with its native cache and respects Cache-Control.
//
// skipWaiting + clients.claim makes a new service-worker version take
// over the page on activation, so a deploy reaches the running tab on the
// next reload, no extra refresh needed.

// Bump the cache key whenever we want to force every client to drop
// stale shell entries on the next activate (see the cleanup loop in
// the activate handler below). v2 was rolled to break out of a
// "service-worker keeps serving an old index.html → infinite auto-
// update redirect" loop that hit users with very old SW installs.
const SHELL_CACHE = 'convooz-shell-v2';
const SHELL_FILES = ['./', './index.html', './polish.css', './manifest.json', './version.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES))
      .catch(() => {/* tolerate partial pre-cache failure on first install */})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle GETs we can meaningfully cache.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Cross-origin (CDN scripts, supabase, fly backend): let the browser
  // handle caching natively. We don't intercept.
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      // Write a clone to cache so an offline open still works. Don't
      // cache opaque error responses.
      if (fresh && fresh.ok) {
        const cache = await caches.open(SHELL_CACHE);
        cache.put(req, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch (e) {
      // Offline: serve from cache. For navigations, fall back to the
      // app shell (./index.html) so a deep-linked URL still loads.
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw e;
    }
  })());
});
