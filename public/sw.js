/**
 * Basil Service Worker
 * Strategy:
 *   - Static assets (_next/static, icons, fonts) → Stale-While-Revalidate
 *     (serve fast from cache BUT always refresh in the background, so a new
 *     deploy is picked up on the next load instead of being pinned forever).
 *   - API routes (/api/*) → Network Only (never cache auth/data).
 *   - Page navigations → Network First (always fresh), /offline only as a
 *     true-offline fallback. HTML is never persistently cached, so a stale
 *     app shell can't be served over a fresh deploy.
 *
 * NOTE: bump CACHE_NAME on any caching-behaviour change — the activate handler
 * purges every cache that doesn't match, which is what un-sticks old clients.
 */

const CACHE_NAME = "basil-v3";
const OFFLINE_URL = "/offline";

const PRECACHE_URLS = [
  "/offline",
  "/icons/icon-192.png",
  "/icons/apple-touch-icon.png",
];

// ── Install: precache shell resources, take over immediately ─────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
  self.skipWaiting();
});

// ── Activate: purge every old cache, claim all clients ───────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch routing ────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // never cache auth/data

  // Static assets — stale-while-revalidate (fast, but self-refreshing).
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname.match(/\.(png|jpg|jpeg|svg|webp|woff2?|ttf|otf|ico)$/)
  ) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Page navigations — network first, offline page as last resort.
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }
});

// ── Strategies ────────────────────────────────────────────────────────────────
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((resp) => {
      if (resp && resp.ok) cache.put(request, resp.clone());
      return resp;
    })
    .catch(() => cached);
  return cached || network;
}

async function networkFirst(request) {
  try {
    const resp = await fetch(request);
    return resp;
  } catch {
    const cached = await caches.match(request);
    return cached || (await caches.match(OFFLINE_URL));
  }
}

// ── Push notifications (lib/notify, 2026-11-10) ──────────────────────────────
// Payload: { title, body, url, tag, kind }. A push must always show something
// (iOS revokes the subscription otherwise), so a bad payload still shows Basil.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    console.warn("[sw] push payload was not JSON", e);
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Basil";
  const url = typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/dashboard";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      tag: typeof data.tag === "string" ? data.tag : undefined,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url },
    })
  );
});

// Open (or focus) Basil at the notification's page. Only same-origin paths.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.data && typeof event.notification.data.url === "string" ? event.notification.data.url : "/dashboard";
  const target = new URL(path.startsWith("/") ? path : "/dashboard", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => w.url.startsWith(self.location.origin));
      if (open) {
        return open.focus().then((w) => (w && "navigate" in w ? w.navigate(target) : undefined));
      }
      return self.clients.openWindow(target);
    })
  );
});
