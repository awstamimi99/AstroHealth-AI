// js/auth/session.js
// The demo login session, stored at localStorage["astrohealth.session"].
// CONTRACT: only Team 1 code (js/auth/) creates, updates or deletes it.
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

function readRaw() {
  try {
    return storage()?.getItem(SESSION_KEY) ?? null;
  } catch {
    return null;
  }
}

function removeRaw() {
  try {
    storage()?.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable — nothing to remove */
  }
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
 * @returns {object} the stored session (a copy)
 */
export function createSession(user) {
  const session = buildSession(user);
  const store = storage();
  if (!store) throw new Error("Browser storage is unavailable, so the session can't be saved.");
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
