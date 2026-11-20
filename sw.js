// JARVIS TERMINAL service worker: caches the app shell only.
// Data (/data, /api, data/*.json) is always fetched live, never cached.
// Paths are relative to the SW scope so this works at / and at /jarvis-dash/.
const CACHE = "jarvis-shell-v4-grok";
const SHELL = ["./","manifest.json","static-fallback.js","icons/icon-192.png","icons/icon-512.png","icons/apple-touch-icon.png"];
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
