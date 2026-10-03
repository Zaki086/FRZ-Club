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

// v3 §6.3 / v4 §4.2 Web Push. The payload is { title, body, url, tag }: show it (a newer message with the same tag
// replaces the older one); a tap focuses an open tab of the app and takes it to the deep link, or opens one.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: e.data ? e.data.text() : "" }; }
  const options = { body: d.body || "", data: { url: d.url || "/" }, icon: "/icon", badge: "/icon" };
  if (d.tag) options.tag = d.tag;
  e.waitUntil(self.registration.showNotification(d.title || "Notification", options));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  // Only links inside this app are followed.
  let target;
  try {
    target = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin);
    if (target.origin !== self.location.origin) target = new URL("/", self.location.origin);
  } catch { target = new URL("/", self.location.origin); }
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (list) => {
    const same = list.find((c) => new URL(c.url).pathname === target.pathname);
    if (same && "focus" in same) return same.focus();
    const open = list.find((c) => new URL(c.url).origin === self.location.origin && "focus" in c);
    if (open) {
      const focused = await open.focus();
      if ("navigate" in focused) return focused.navigate(target.href).catch(() => self.clients.openWindow(target.href));
      return focused;
    }
    return self.clients.openWindow(target.href);
  }));
});
