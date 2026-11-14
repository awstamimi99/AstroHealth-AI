// js/db/repositories/settings.js — store "settings" (keyPath "key")
// Keys: mission, units, notifications, simulation, display, thresholds.
// Flags inside values use 0/1. Thresholds are DEMONSTRATION values only.

import { run, requestToPromise } from "../database.js";
import { SYSTEM_USER } from "../constants.js";
import { getOne } from "./_common.js";

const STORE = "settings";

export const settingsRepo = {
  /** @returns {Promise<any>} the VALUE for `key`, or null */
  async get(key, opts) {
    return run([STORE], "readonly", opts, async (tx, s) => (await getOne(s.settings, key))?.value ?? null);
  },

  /** Save a value. @returns {Promise<{key, value, updatedAt, updatedBy}>} */
  async set(key, value, userId = SYSTEM_USER, opts) {
    const record = { key, value, updatedAt: Date.now(), updatedBy: userId || SYSTEM_USER };
    await run([STORE], "readwrite", opts, async (tx, s) => requestToPromise(s.settings.put(record)));
    return record;
  },

  /** Every setting as { key: value }. */
  async getAll(opts) {
    return run([STORE], "readonly", opts, async (tx, s) => {
      const records = await requestToPromise(s.settings.getAll());
      return Object.fromEntries(records.map((r) => [r.key, r.value]));
    });
  },
};
