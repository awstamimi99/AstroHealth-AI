// js/core/event-bus.js
// SHARED. A tiny publish/subscribe bus so modules can talk without importing
// each other. Events are ALSO mirrored to other open tabs of the app using
// BroadcastChannel — e.g. an alert raised in one tab shows up in another.
//
//   import { bus } from "./core/event-bus.js";
//   const stop = bus.on("alert:new", (alert, meta) => { … });
//   bus.emit("alert:new", { id: 1, severity: "critical" });
//   stop(); // unsubscribe
//
// `meta.remote` is true when the event came from another tab.
// Payloads must be plain data (structured-cloneable): no functions/DOM nodes.
// Use bus.emit(name, data, { local: true }) to NOT send to other tabs.

import { CHANNEL_NAME } from "./config.js";

const listeners = new Map(); // event name -> Set of handler functions

// BroadcastChannel is missing in very old browsers — then we stay local-only.
const channel = "BroadcastChannel" in self ? new BroadcastChannel(CHANNEL_NAME) : null;

/** Call every handler registered for `name` (and "*" wildcard handlers). */
function dispatch(name, data, meta) {
  for (const key of [name, "*"]) {
    const set = listeners.get(key);
    if (!set) continue;
    for (const handler of [...set]) {
      try {
        handler(data, { ...meta, name });
      } catch (err) {
        console.error(`[event-bus] handler for "${name}" failed:`, err);
      }
    }
  }
}

if (channel) {
  channel.addEventListener("message", (event) => {
    const { name, data } = event.data || {};
    if (typeof name === "string") dispatch(name, data, { remote: true });
  });
}

export const bus = {
  /** Subscribe. Returns a function that unsubscribes. Use "*" for all events. */
  on(name, handler) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(handler);
    return () => this.off(name, handler);
  },

  /** Subscribe for a single event only. */
  once(name, handler) {
    const stop = this.on(name, (data, meta) => {
      stop();
      handler(data, meta);
    });
    return stop;
  },

  /** Unsubscribe a handler previously passed to on(). */
  off(name, handler) {
    listeners.get(name)?.delete(handler);
  },

  /** Publish an event to this tab and (unless local) to other tabs. */
  emit(name, data, { local = false } = {}) {
    dispatch(name, data, { remote: false });
    if (channel && !local) {
      try {
        channel.postMessage({ name, data });
      } catch (err) {
        console.warn(`[event-bus] "${name}" could not be sent to other tabs:`, err);
      }
    }
  },
};
