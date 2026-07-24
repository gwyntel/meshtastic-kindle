// mesh-kindle service worker — cache-first for static assets
var CACHE = 'mesh-kindle-v6';
var ASSETS = ['/', '/index.html', '/style.css', '/app.js', '/manifest.json', '/NotoEmoji.ttf'];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(ASSETS);
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; }).map(function(k) {
          return caches.delete(k);
        })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(e) {
  var url = new URL(e.request.url);

  // Only cache same-origin GET requests
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // Never cache API requests
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Cache-first for static assets
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      if (cached) {
        // Update cache in background
        fetch(e.request).then(function(resp) {
          if (resp && resp.status === 200) {
            caches.open(CACHE).then(function(cache) {
              cache.put(e.request, resp.clone());
            });
          }
        }).catch(function() {});
        return cached;
      }
      return fetch(e.request).then(function(resp) {
        if (resp && resp.status === 200) {
          var respClone = resp.clone();
          caches.open(CACHE).then(function(cache) {
            cache.put(e.request, respClone);
          });
        }
        return resp;
      });
    })
  );
});
