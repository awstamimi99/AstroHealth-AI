// js/core/action-plan-progress.js — SHARED (core). Which review steps the signed-in
// user ticked in an alert's action-plan drawer (decision: browser storage).
//
//   localStorage["astrohealth.actionplan.v1"] = { [userKey]: { "ALT-0191": ["recent", "repeat"] } }
//
// Per user (the signed-in user's id, never placed in the URL or DOM) and per
// public alert number. Browser/device-local only: it is NOT in IndexedDB, the
// Medical Officer never sees it, and it never changes alerts or risk rules.
// Only allow-listed step ids are kept; malformed data falls back to empty.
// If storage is blocked, ticks are kept in memory for this tab.
//
// Test seam: createPlanProgress({ storage }).

export const PROGRESS_KEY = "astrohealth.actionplan.v1";
const USER_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const ALERT_NUMBER = /^ALT-\d{4,6}$/;
const STEP_ID = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_ALERTS_PER_USER = 50;

function parse(text) {
  if (typeof text !== "string" || !text) return {};
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [user, alerts] of Object.entries(raw)) {
    if (!USER_KEY.test(user) || !alerts || typeof alerts !== "object" || Array.isArray(alerts)) continue;
    const clean = {};
    for (const [number, steps] of Object.entries(alerts).slice(0, MAX_ALERTS_PER_USER)) {
      if (ALERT_NUMBER.test(number) && Array.isArray(steps)) clean[number] = [...new Set(steps.filter((s) => typeof s === "string" && STEP_ID.test(s)))];
    }
    out[user] = clean;
  }
  return out;
}

function usable(getter) {
  try {
    const s = getter();
    if (!s) return null;
    s.setItem("astrohealth.actionplan.probe", "1");
    s.removeItem("astrohealth.actionplan.probe");
    return s;
  } catch {
    return null;
  }
}

export function createPlanProgress({ storage = () => globalThis.localStorage } = {}) {
  const memory = new Map(); // `${user}|${number}` → string[]
  const valid = (user, number) => USER_KEY.test(String(user)) && ALERT_NUMBER.test(String(number));

  /** Ticked step ids for this user + alert, limited to `allowed`. */
  function get(user, number, allowed) {
    if (!valid(user, number)) return [];
    const keep = (list) => list.filter((s) => allowed.includes(s));
    const key = `${user}|${number}`;
    if (memory.has(key)) return keep(memory.get(key));
    const s = usable(storage);
    if (!s) return [];
    try {
      const all = parse(s.getItem(PROGRESS_KEY));
      return keep((all[user] && all[user][number]) || []);
    } catch {
      return [];
    }
  }

  /** Tick or untick one step. Returns { ok, done, persisted }. */
  function set(user, number, stepId, done, allowed) {
    if (!valid(user, number) || !allowed.includes(stepId)) return { ok: false, done: get(user, number, allowed), persisted: false };
    const current = new Set(get(user, number, allowed));
    if (done) current.add(stepId);
    else current.delete(stepId);
    const next = allowed.filter((s) => current.has(s));
    const s = usable(storage);
    let persisted = false;
    if (s) {
      try {
        const all = parse(s.getItem(PROGRESS_KEY));
        all[user] = { ...(all[user] || {}), [number]: next };
        s.setItem(PROGRESS_KEY, JSON.stringify(all));
        persisted = true;
        memory.delete(`${user}|${number}`);
      } catch {
        persisted = false;
      }
    }
    if (!persisted) memory.set(`${user}|${number}`, next);
    return { ok: true, done: next, persisted };
  }

  return { get, set };
}

export const planProgress = createPlanProgress();
