// Keeps the installed app exactly as it is until you tap "Update now".
// Releasing a new version = change VERSION below (and in config.js), then publish.
var VERSION = '1.0.0';
var SHELL_CACHE = 'shell-' + VERSION;
var LIB_CACHE = 'libs-v1';
var SHELL = [
  './', './index.html', './app.js', './drive.js', './config.js', './demo-data.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './maskable-512.png', './apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  // No skipWaiting here: a new version waits until the app asks for it.
  event.waitUntil(caches.open(SHELL_CACHE).then(function (c) { return c.addAll(SHELL); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k.indexOf('shell-') === 0 && k !== SHELL_CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (event) {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  // The app itself: always the approved, cached version.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(function (c) {
        return c.match(req, { ignoreSearch: true }).then(function (hit) { return hit || fetch(req); });
      })
    );
    return;
  }

  // Helper libraries and fonts: keep a copy so they load fast and stay the same.
  if (/(^|\.)cdnjs\.cloudflare\.com$|(^|\.)unpkg\.com$|^fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    event.respondWith(
      caches.open(LIB_CACHE).then(function (c) {
        return c.match(req).then(function (hit) {
          return hit || fetch(req).then(function (res) {
            if (res.ok || res.type === 'opaque') c.put(req, res.clone());
            return res;
          });
        });
      })
    );
  }
  // Everything else (Google sign-in, Google Drive) goes straight to the network.
});
