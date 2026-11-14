// js/db/seed.js
// Writes the demo data set (built by seed-data.js) into IndexedDB.
//
//   await seedDemoData();   // safe to call on every app start — idempotent
//
// Idempotent: if meta.seedVersion exists, nothing is written. The check is
// repeated INSIDE the write transaction, so two tabs seeding at the same
// moment still can't duplicate data.

import { withTransaction, requestToPromise } from "./database.js";
import { STORE_NAMES } from "./schema.js";
import { buildSeedData, DEMO_PASSWORD, SEED_VERSION } from "./seed-data.js";
import { hashPassword } from "./password.js";
import { metaRepo } from "./repositories/meta.js";

export { SEED_VERSION, DEMO_PASSWORD } from "./seed-data.js";

/**
 * Build the demo data and hash the demo passwords. Async work happens HERE,
 * before any transaction starts (awaiting crypto inside a transaction would
 * end it early).
 */
export async function prepareSeedData({ now = Date.now() } = {}) {
  const data = buildSeedData({ now });
  data.users = await Promise.all(
    data.users.map(async (user) => ({ ...user, ...(await hashPassword(DEMO_PASSWORD)) }))
  );
  return data;
}

/** put() every record of `data` into the matching store. Inside a transaction. */
export async function writeSeedData(stores, data) {
  const writes = [];
  for (const name of STORE_NAMES) {
    for (const record of data[name] || []) writes.push(requestToPromise(stores[name].put(record)));
  }
  await Promise.all(writes);
  return countsOf(data);
}

/** { storeName: number of records } */
export function countsOf(data) {
  return Object.fromEntries(STORE_NAMES.map((name) => [name, (data[name] || []).length]));
}

/**
 * Seed the demo data once.
 * @returns {Promise<{ seeded: boolean, seedVersion: number, counts?: Record<string, number> }>}
 */
export async function seedDemoData({ now = Date.now() } = {}) {
  const existing = await metaRepo.get("seedVersion");
  if (existing != null) return { seeded: false, seedVersion: existing };

  const data = await prepareSeedData({ now });

  return withTransaction(STORE_NAMES, "readwrite", async (tx, stores) => {
    // Check again inside the transaction (another tab may have just seeded).
    const again = await requestToPromise(stores.meta.get("seedVersion"));
    if (again) return { seeded: false, seedVersion: again.value };
    const counts = await writeSeedData(stores, data);
    return { seeded: true, seedVersion: SEED_VERSION, counts };
  });
}
