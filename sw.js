// JARVIS TERMINAL service worker: caches the app shell only.
// Data (/data, /api, data/*.json) is always fetched live, never cached.
// Paths are relative to the SW scope so this works at / and at /jarvis-dash/.
const CACHE = "jarvis-shell-v6-newcoins";
const SHELL = ["./","manifest.json","static-fallback.js","newcoins.js","icons/icon-192.png","icons/icon-512.png","icons/apple-touch-icon.png"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;
  const p = u.pathname;
  if (p.includes("/data/") || p.includes("/api/") || /\/data\/[^/]+\.json$/.test(p)) return;
  e.respondWith(
    fetch(e.request).then(r => {
      const cp = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, cp));
      return r;
    }).catch(() => caches.match(e.request))
  );
});
self.addEventListener("push", e => {
  let data = {};
  try { data = e.data ? (e.data.json ? e.data.json() : JSON.parse(e.data.text())) : {}; }
  catch (err) {
    try { data = { body: e.data && e.data.text ? e.data.text() : "" }; } catch (e2) { data = {}; }
  }
  if (typeof data !== "object" || !data) data = { body: String(data || "") };
  const title = data.title || "JARVIS";
  const opts = {
    body: data.body || "",
    icon: data.icon || "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: data.tag || "jarvis",
    data: { url: data.url || "./", kind: data.kind || "" },
    renotify: true
  };
  e.waitUntil((async () => {
    await self.registration.showNotification(title, opts);
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    clients.forEach(c => c.postMessage({ type: "jarvis-push", payload: data, title }));
  })());
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of clients) {
      if (c.url.startsWith(self.registration.scope) && "focus" in c) {
        await c.focus();
        if ("navigate" in c) { try { await c.navigate(target); } catch (err) {} }
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
