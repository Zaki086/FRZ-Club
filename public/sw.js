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

// v3 §6.3 Web Push: show the club's notification and open its page when tapped.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Notification", { body: d.body || "", data: { url: d.url || "/" }, icon: "/icon" }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if ("focus" in c && new URL(c.url).pathname === url) return c.focus();
    return self.clients.openWindow(url);
  }));
});
