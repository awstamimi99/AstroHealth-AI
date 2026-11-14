// js/core/preferences.js — SHARED (core). Personal display preferences (Sprint 9).
//
// Browser-only: localStorage["astrohealth.prefs.v1"] = { [userKey]: { textSize, motion } }.
// The key is the verified signed-in user's id (already present in this
// browser's session); it never goes into the URL or the DOM. Only these two
// allow-listed preferences are stored — never session objects, passwords or
// anything else. Preferences never affect data, alerts, thresholds,
// simulation or risk evaluation.
//
//   const prefs = createPreferences({ storage, root });   // test seam
//   prefs.get(userKey)              → { textSize, motion } (validated, defaults on bad data)
//   prefs.set(userKey, changes)     → { ok, prefs, persisted }
//   prefs.reset(userKey)            → removes ONLY this user's entry
//   prefs.apply(userKey)            → sets data-text-size / data-motion on <html>
//   prefs.subscribe(userKey, fn)    → other tabs (storage event) → fn(prefs)
//
// If storage is blocked, values are kept in memory for this tab and
// `persisted` is false (the page shows a calm notice).

export const PREFS_KEY = "astrohealth.prefs.v1";
export const TEXT_SIZES = Object.freeze(["standard", "large", "larger"]);
export const MOTIONS = Object.freeze(["system", "reduce"]);
export const DEFAULT_PREFS = Object.freeze({ textSize: "standard", motion: "system" });
const MAX_USERS = 20;
const USER_KEY = /^[A-Za-z0-9_-]{1,64}$/;

/** Validate one user's entry; anything unknown falls back to the default. */
export function validatePrefs(value) {
  const v = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.freeze({
    textSize: TEXT_SIZES.includes(v.textSize) ? v.textSize : DEFAULT_PREFS.textSize,
    motion: MOTIONS.includes(v.motion) ? v.motion : DEFAULT_PREFS.motion,
  });
}

/** Parse the whole stored object; malformed JSON / shapes → {} (safe). */
export function parseStore(text) {
  if (typeof text !== "string" || !text) return {};
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw).slice(0, MAX_USERS)) if (USER_KEY.test(k)) out[k] = validatePrefs(v);
  return out;
}

function safeStorage(getter) {
  try {
    const s = getter();
    if (!s) return null;
    const probe = "astrohealth.prefs.probe";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export function createPreferences({ storage = () => globalThis.localStorage, root = () => globalThis.document && document.documentElement, events = globalThis } = {}) {
  const memory = new Map(); // fallback when storage is blocked (this tab only)
  const store = () => safeStorage(storage);
  const validKey = (userKey) => typeof userKey === "string" && USER_KEY.test(userKey);

  function readAll() {
    const s = store();
    if (!s) return null;
    try {
      return parseStore(s.getItem(PREFS_KEY));
    } catch {
      return null;
    }
  }

  function get(userKey) {
    if (!validKey(userKey)) return DEFAULT_PREFS;
    if (memory.has(userKey)) return memory.get(userKey);
    const all = readAll();
    return all && all[userKey] ? all[userKey] : DEFAULT_PREFS;
  }

  function apply(userKey) {
    const p = get(userKey);
    const el = root();
    if (el && typeof el.setAttribute === "function") {
      el.setAttribute("data-text-size", p.textSize);
      el.setAttribute("data-motion", p.motion);
    }
    return p;
  }

  function set(userKey, changes) {
    if (!validKey(userKey)) return { ok: false, reason: "invalid_user", prefs: DEFAULT_PREFS, persisted: false };
    const c = changes && typeof changes === "object" ? changes : {};
    if (c.textSize !== undefined && !TEXT_SIZES.includes(c.textSize)) return { ok: false, reason: "invalid_value", prefs: get(userKey), persisted: false };
    if (c.motion !== undefined && !MOTIONS.includes(c.motion)) return { ok: false, reason: "invalid_value", prefs: get(userKey), persisted: false };
    const next = validatePrefs({ ...get(userKey), ...(c.textSize !== undefined ? { textSize: c.textSize } : {}), ...(c.motion !== undefined ? { motion: c.motion } : {}) });
    const s = store();
    let persisted = false;
    if (s) {
      try {
        const all = parseStore(s.getItem(PREFS_KEY));
        all[userKey] = next;
        s.setItem(PREFS_KEY, JSON.stringify(all));
        persisted = true;
        memory.delete(userKey);
      } catch {
        persisted = false;
      }
    }
    if (!persisted) memory.set(userKey, next);
    apply(userKey);
    return { ok: true, prefs: next, persisted };
  }

  function reset(userKey) {
    if (!validKey(userKey)) return { ok: false, reason: "invalid_user", prefs: DEFAULT_PREFS, persisted: false };
    memory.delete(userKey);
    const s = store();
    let persisted = false;
    if (s) {
      try {
        const all = parseStore(s.getItem(PREFS_KEY));
        delete all[userKey]; // only this user's entry
        if (Object.keys(all).length) s.setItem(PREFS_KEY, JSON.stringify(all));
        else s.removeItem(PREFS_KEY);
        persisted = true;
      } catch {
        persisted = false;
      }
    }
    apply(userKey);
    return { ok: true, prefs: DEFAULT_PREFS, persisted };
  }

  /** Other tabs: the browser fires "storage" in OTHER tabs when localStorage changes. */
  function subscribe(userKey, fn) {
    if (!events || typeof events.addEventListener !== "function") return () => {};
    const handler = (e) => {
      if (e && e.key !== PREFS_KEY && e.key !== null) return;
      memory.delete(userKey);
      fn(apply(userKey));
    };
    events.addEventListener("storage", handler);
    return () => events.removeEventListener("storage", handler);
  }

  return { get, set, reset, apply, subscribe, isPersistent: () => Boolean(store()) };
}

export const preferences = createPreferences();
