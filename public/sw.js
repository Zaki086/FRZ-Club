// Completion pass P1 (PWA): a small service worker. Pages always come from the network (live data: bookings,
// stock, tabs); only when the network is down is the offline page shown. Nothing is cached that could go stale.
const OFFLINE = "/offline";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open("offline-v1").then((c) => c.add(OFFLINE)));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
  e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE)));
});
