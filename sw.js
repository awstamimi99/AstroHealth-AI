// sw.js — AstroHealth AI service worker (SHARED FILE)
//
// Makes the whole app work with NO network:
//   1. install  → download every runtime file into a versioned cache
//   2. activate → delete caches from older versions
//   3. fetch    → answer same-origin GET requests from the cache first
//
// The file list is generated: run `npm run build:sw` after adding/removing
// files. When you ship changes, bump CACHE_VERSION (and APP_VERSION in
// js/core/config.js) so every device downloads the new files.
//
// This is a classic (non-module) worker for maximum browser support, so it
// uses importScripts() instead of import.

const CACHE_VERSION = "0.10.1";
const CACHE_NAME = `astrohealth-v${CACHE_VERSION}`;

// Defines self.PRECACHE_URLS (relative to this file).
importScripts("./js/core/precache-manifest.js");

// ---- Install: precache everything ----------------------------------------
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      // cache: "reload" skips the browser's HTTP cache so we store fresh files.
      .then((cache) => cache.addAll(self.PRECACHE_URLS.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

// ---- Activate: remove old versions ---------------------------------------
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("astrohealth-") && key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ---- Fetch: cache-first for same-origin GET ------------------------------
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Only handle our own files. We NEVER fetch anything cross-origin: those
  // requests are left alone (and check:offline makes sure none exist).
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  event.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);

  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    // Store successful same-origin responses for next time.
    if (response.ok && response.type === "basic") {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Offline and not cached. For page loads, try the page without its
    // ?query, then fall back to the landing page.
    if (request.mode === "navigate") {
      return (
        (await cache.match(request, { ignoreSearch: true })) ||
        (await cache.match("./index.html")) ||
        Response.error()
      );
    }
    return Response.error();
  }
}
