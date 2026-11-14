// js/sw-register.js
// SHARED. Registers the service worker (sw.js) and tracks its status so the
// UI can show an offline indicator.
//
//   import { registerServiceWorker, getSwStatus, onSwStatus } from "./sw-register.js";
//   registerServiceWorker();
//   onSwStatus((status) => { … });   // called now and on every change
//
// Status values:
//   "unsupported" – browser has no service worker (or page opened via file://)
//   "installing"  – first visit: files are being cached
//   "active"      – app is fully available offline
//   "error"       – registration failed (see console)

import { bus } from "./core/event-bus.js";

let status = "serviceWorker" in navigator && location.protocol !== "file:" ? "installing" : "unsupported";
const listeners = new Set();

function setStatus(next) {
  if (next === status) return;
  status = next;
  for (const fn of listeners) {
    try {
      fn(status);
    } catch (err) {
      console.error("[sw] status listener failed:", err);
    }
  }
  bus.emit("sw:status", status, { local: true });
}

/** Current status string. */
export function getSwStatus() {
  return status;
}

/** Public offline state used by pages and diagnostics. */
export async function getOfflineStatus() {
  let cachedFiles = 0;
  if ("caches" in window) {
    try {
      const keys = await caches.keys();
      const appCache = keys.find((key) => key.startsWith("astrohealth-v"));
      if (appCache) cachedFiles = (await (await caches.open(appCache)).keys()).length;
    } catch {
      // Cache inspection is optional; registration status remains useful.
    }
  }
  return { online: navigator.onLine, serviceWorker: status, cachedFiles };
}

/** Subscribe to status changes. Calls `fn` immediately. Returns unsubscribe. */
export function onSwStatus(fn) {
  listeners.add(fn);
  fn(status);
  return () => listeners.delete(fn);
}

/** Register sw.js. Safe to call on every page. */
export async function registerServiceWorker() {
  if (status === "unsupported") return null;

  try {
    // sw.js lives at the repo root; resolve it from this module's location so
    // it works from any page (and from tests/browser/).
    const swUrl = new URL("../sw.js", import.meta.url);
    const registration = await navigator.serviceWorker.register(swUrl, {
      scope: new URL("../", import.meta.url).pathname,
    });

    const track = (worker) => {
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "activated") setStatus("active");
      });
    };

    if (registration.active) setStatus("active");
    else track(registration.installing || registration.waiting);
    registration.addEventListener("updatefound", () => track(registration.installing));

    await navigator.serviceWorker.ready;
    setStatus("active");
    return registration;
  } catch (err) {
    console.error("[sw] registration failed:", err);
    setStatus("error");
    return null;
  }
}
