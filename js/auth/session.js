// js/auth/session.js
// The demo login session, stored at localStorage["astrohealth.session"].
// CONTRACT: only js/auth/ creates, updates or deletes it.
// Other code may READ it with getSession().
//
//   import { createSession, getSession, clearSession, onSessionChange } from "../auth/session.js";
//   const user = await usersRepo.verifyPassword(username, password);
//   if (user) createSession(user);
//
// ⚠️ DEMO ONLY — not real security (see session-core.js for the schema).
//
// Other tabs learn about sign-in / sign-out in two ways:
//   1. the browser "storage" event (fires in OTHER tabs when localStorage changes)
//   2. the shared event bus, which mirrors "session:changed" over BroadcastChannel
// onSessionChange() listens to both and only calls you when the session really changed.
//
// TAB-ONLY SESSIONS (opt-in, "Sign in for this tab only" on the login page):
// createSession(user, { tabOnly: true }) stores the session in THIS tab's
// sessionStorage instead. A tab that has a tab-only session uses it and
// ignores the shared one; signing out there clears only that tab. Other tabs
// keep the shared session exactly as before. This lets one browser show two
// demo users side by side (e.g. Medical Officer + astronaut) while they
// still share the local database. Same schema, same expiry, same checks.

import { SESSION_KEY } from "../core/config.js";
import { bus } from "../core/event-bus.js";
import { buildSession, parseSession, VALID_ROLES } from "./session-core.js";

export { roleLabel, initialsOf } from "./session-core.js";

/** localStorage, or null when blocked (private mode, disabled storage…). */
function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** This tab's own storage (tab-only sessions), or null when blocked. */
function tabStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readTabRaw() {
  try {
    return tabStorage()?.getItem(SESSION_KEY) ?? null;
  } catch {
    return null;
  }
}

/** The tab-only session wins in its tab; otherwise the shared one. */
function readRaw() {
  const own = readTabRaw();
  if (own !== null) return own;
  try {
    return storage()?.getItem(SESSION_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Remove the session this tab is using: its tab-only one if it has one, else the shared one. */
function removeRaw() {
  try {
    if (readTabRaw() !== null) {
      tabStorage()?.removeItem(SESSION_KEY);
      return;
    }
    storage()?.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable — nothing to remove */
  }
}

/** true when this tab is signed in with a tab-only session. */
export function isTabOnlySession() {
  return readTabRaw() !== null && getSession() !== null;
}

/** Only non-personal data goes on the bus; listeners call getSession(). */
function announce() {
  const session = getSession();
  bus.emit("session:changed", { authenticated: Boolean(session), role: session?.role ?? null });
}

/**
 * Save a new session for the user returned by usersRepo.verifyPassword().
 * Copies only safe fields; throws if the user is unsuitable or storage fails.
 * @param {import("../db/types.js").SafeUser} user
 * @param {{ tabOnly?: boolean }} [options]  tabOnly: keep the session in this tab only
 * @returns {object} the stored session (a copy)
 */
export function createSession(user, { tabOnly = false } = {}) {
  const session = buildSession(user);
  const store = tabOnly === true ? tabStorage() : storage();
  if (!store) throw new Error("Browser storage is unavailable, so the session can't be saved.");
  if (tabOnly !== true) {
    // A normal sign-in replaces any tab-only session this tab had.
    try { tabStorage()?.removeItem(SESSION_KEY); } catch { /* nothing to remove */ }
  }
  store.setItem(SESSION_KEY, JSON.stringify(session));
  announce();
  return { ...session };
}

/**
 * The current valid session, or null. Never throws. A corrupted, expired or
 * otherwise invalid stored session is removed. Returns a NEW object each time.
 */
export function getSession() {
  const raw = readRaw();
  if (raw === null) return null;
  const session = parseSession(raw);
  if (!session) removeRaw(); // don't keep broken or expired data around
  return session;
}

/** Sign out: remove the session (IndexedDB data is NOT touched). */
export function clearSession() {
  removeRaw();
  announce();
}

export function isAuthenticated() {
  return getSession() !== null;
}

/** true if the signed-in user has this role (a known role only). */
export function hasRole(role) {
  return VALID_ROLES.includes(role) && getSession()?.role === role;
}

/**
 * Call `callback(session | null)` whenever the session changes — in this tab
 * or another. Duplicate notifications are filtered out.
 * @returns {() => void} unsubscribe
 */
export function onSessionChange(callback) {
  const signature = (s) => (s ? `${s.userId}|${s.createdAt}` : "none");
  let last = signature(getSession());

  const check = () => {
    const session = getSession();
    const now = signature(session);
    if (now === last) return;
    last = now;
    callback(session);
  };
  const onStorage = (event) => {
    if (event.key === SESSION_KEY || event.key === null) check(); // null = storage.clear()
  };

  const stopBus = bus.on("session:changed", check);
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    stopBus();
    globalThis.removeEventListener?.("storage", onStorage);
  };
}
