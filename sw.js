// Self-destructing service worker — unregisters old cached frontend
// and serves as a one-time cleanup for the v2→v3 migration.
// After activation, it unregisters itself and clears all caches.

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        return caches.delete(key);
      }));
    }).then(function () {
      return self.registration.unregister();
    })
  );
});

// Don't intercept any fetch — let network handle everything
self.addEventListener('fetch', function (event) {
  event.respondWith(fetch(event.request));
});
