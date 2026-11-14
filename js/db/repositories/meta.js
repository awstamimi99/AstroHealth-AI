// js/db/repositories/meta.js — store "meta" (keyPath "key")
// Database bookkeeping: schemaVersion, seededAt, seedVersion, alertCounter,
// lastCompactedAt. Don't change alertCounter by hand — use alertsRepo.add().

import { run, requestToPromise } from "../database.js";
import { getOne } from "./_common.js";

const STORE = "meta";

export const metaRepo = {
  /** @returns {Promise<any>} value or null */
  async get(key, opts) {
    return run([STORE], "readonly", opts, async (tx, s) => (await getOne(s.meta, key))?.value ?? null);
  },

  /** @returns {Promise<any>} the saved value */
  async set(key, value, opts) {
    await run([STORE], "readwrite", opts, async (tx, s) => requestToPromise(s.meta.put({ key, value })));
    return value;
  },
};
