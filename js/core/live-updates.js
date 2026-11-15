// js/core/live-updates.js — SHARED. Keeps an open screen in step with stored
// data that changed elsewhere (Live control / a simulation step / an alert
// action), in this tab or another one, without a manual reload.
//
//   import { onHealthChanged } from "../core/live-updates.js";
//   onHealthChanged({ signal, crewId: () => "AH-04" | "" | null, reload });
//
// Events (js/core/event-bus.js, mirrored to other tabs by BroadcastChannel):
//   "health:changed"     { crewId, metric, alertsChanged } — a reading was
//                        committed, or the risk evaluation changed an alert.
//                        Public crew ID + metric name + a flag: no values,
//                        no names, no internal ids.
//   "alert:changed"      {} — an alert was acknowledged / resolved / raised.
//   "simulation:changed" {} — a run started, paused, stopped or finished.
//
// `crewId()` says whose data the screen shows right now: a crew ID (events
// for other crew members are ignored), "" for crew-wide screens (every
// event counts), or null while unknown (every event counts — the screen's
// own service still returns only what the signed-in user may see).
// Bursts of events are merged into one reload. The subscription ends when
// the navigation AbortSignal fires, so listeners never pile up.
//
// Test seam: `source` (anything with on(name, handler) → unsubscribe) and
// `schedule` (defaults to setTimeout / clearTimeout).

import { bus } from "./event-bus.js";

export const HEALTH_EVENT = "health:changed";
export const LIVE_EVENTS = Object.freeze([HEALTH_EVENT, "alert:changed", "simulation:changed"]);
export const LIVE_DEBOUNCE_MS = 120;

const defaultSchedule = Object.freeze({ set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) });

/** Does this event concern the crew member a screen is showing? */
export function concerns(name, data, crewId) {
  if (name !== HEALTH_EVENT) return true;
  if (crewId === "" || crewId === null || crewId === undefined) return true;
  return Boolean(data) && data.crewId === crewId;
}

/**
 * Subscribe a screen. Returns an unsubscribe function (also called on abort).
 * @param {{ signal?: AbortSignal, crewId?: () => (string|null), reload: (info: {name: string, data: object}) => void,
 *           events?: string[], source?: object, schedule?: object, delay?: number }} options
 */
export function onHealthChanged({ signal, crewId = () => null, reload, events = LIVE_EVENTS, source = bus, schedule = defaultSchedule, delay = LIVE_DEBOUNCE_MS }) {
  if (signal && signal.aborted) return () => {};
  let timer = null;
  let last = null;
  let stopped = false;
  const fire = () => {
    timer = null;
    if (stopped || (signal && signal.aborted)) return;
    const info = last;
    last = null;
    try {
      reload(info);
    } catch (err) {
      console.error("[live-updates] reload failed:", err);
    }
  };
  const stops = events.map((name) =>
    source.on(name, (data) => {
      if (stopped || (signal && signal.aborted)) return;
      let shown = null;
      try {
        shown = crewId();
      } catch {
        shown = null;
      }
      if (!concerns(name, data, shown)) return;
      last = { name, data: data && typeof data === "object" ? { ...data } : {} };
      if (timer === null) timer = schedule.set(fire, delay);
    })
  );
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) schedule.clear(timer);
    timer = null;
    for (const off of stops) if (typeof off === "function") off();
  };
  if (signal) signal.addEventListener("abort", stop, { once: true });
  return stop;
}

/**
 * Run a reload and put keyboard focus back on the element with the same id
 * (the reload replaces the nodes). Elements without an id are left alone.
 */
export async function keepFocus(root, work) {
  const active = globalThis.document && document.activeElement;
  const id = active && typeof active.getAttribute === "function" ? active.getAttribute("id") : null;
  await work();
  if (!id || !root || typeof root.querySelectorAll !== "function") return;
  if (globalThis.document && document.activeElement && document.activeElement !== active && document.activeElement !== document.body && typeof document.activeElement.getAttribute === "function" && document.activeElement.getAttribute("id")) return; // focus moved on purpose
  for (const n of root.querySelectorAll("[id]")) if (n.getAttribute("id") === id && typeof n.focus === "function") n.focus();
}

