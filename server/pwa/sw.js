/* Minimal service worker: makes the app installable and caches the shell so it
   opens even on a flaky connection. Live pings go straight to the network. */
const CACHE = "weather-v1";
const SHELL = ["/pwa/", "/pwa/app.js", "/pwa/find.js", "/pwa/find.html",
               "/pwa/manifest.webmanifest", "/pwa/icon.svg"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // never cache API / websocket / frame traffic
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/frames") || url.pathname === "/ws") {
    return; // default network
  }
  // cache-first for the app shell, network fallback
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok && e.request.method === "GET") {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => hit))
  );
});
