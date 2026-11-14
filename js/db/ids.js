// js/db/ids.js
// ID helpers. Pure module (works in Node) — it never opens the database
// itself; nextAlertNumber() receives an object store from a transaction.
//
//   newId("msr")              → "msr_1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"
//   formatAlertNumber(193)    → "ALT-0193"
//   parseAlertNumber("ALT-0193") → 193

import { DatabaseError } from "./errors.js";

const PREFIX_RE = /^[a-z][a-z0-9]{1,11}$/;

/** A random v4 UUID. Falls back to getRandomValues() on older browsers. */
function uuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * New unique id: `${prefix}_${uuid}`.
 * @param {string} prefix  short lower-case word, e.g. "msr", "alr", "evt"
 */
export function newId(prefix) {
  if (!PREFIX_RE.test(String(prefix))) {
    throw new DatabaseError(`newId(): invalid prefix "${prefix}" (use 2–12 lower-case letters/digits)`, {
      code: "INVALID",
    });
  }
  return `${prefix}_${uuid()}`;
}

/** Deterministic id for seed data: seedId("msr", 42) → "msr_seed_00042". */
export function seedId(prefix, n) {
  return `${prefix}_seed_${String(n).padStart(5, "0")}`;
}

/** 193 → "ALT-0193" (numbers above 9999 just get more digits). */
export function formatAlertNumber(n) {
  if (!Number.isInteger(n) || n < 1) {
    throw new DatabaseError(`Alert numbers start at 1 (got ${n})`, { code: "INVALID" });
  }
  return `ALT-${String(n).padStart(4, "0")}`;
}

/** "ALT-0193" → 193 (or NaN if the text isn't an alert number). */
export function parseAlertNumber(text) {
  const match = /^ALT-(\d{4,})$/.exec(String(text));
  return match ? Number(match[1]) : NaN;
}

/**
 * Take the next alert number from meta.alertCounter and save the new value.
 * MUST run inside a "readwrite" transaction that includes the "meta" store,
 * together with the alert insert — so a crash can never reuse a number.
 * alertsRepo.add() does this for you.
 *
 * @param {IDBObjectStore} metaStore  tx.objectStore("meta")
 * @returns {Promise<string>} e.g. "ALT-0191"
 */
export function nextAlertNumber(metaStore) {
  if (!metaStore || typeof metaStore.get !== "function") {
    return Promise.reject(
      new DatabaseError("nextAlertNumber() needs the 'meta' object store of an open readwrite transaction", {
        code: "INVALID",
        store: "meta",
      })
    );
  }
  return new Promise((resolve, reject) => {
    const read = metaStore.get("alertCounter");
    read.onerror = () => reject(read.error);
    read.onsuccess = () => {
      const next = (Number(read.result?.value) || 0) + 1;
      const write = metaStore.put({ key: "alertCounter", value: next });
      write.onerror = () => reject(write.error);
      write.onsuccess = () => resolve(formatAlertNumber(next));
    };
  });
}
