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
import { settingsRepo } from "./repositories/settings.js";
import { DEMO_THRESHOLDS } from "./seed-data.js";
import { buildSeedSupplement } from "./seed-supplement.js";
import { SEED_ASTRONAUTS } from "./seed-data.js";

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
  if (existing != null) {
    await upgradeDemoThresholds();
    const upgraded = existing < SEED_VERSION ? await upgradeDemoData({ now }) : false;
    return { seeded: false, seedVersion: upgraded ? SEED_VERSION : existing, upgraded };
  }

  const data = await prepareSeedData({ now });

  return withTransaction(STORE_NAMES, "readwrite", async (tx, stores) => {
    // Check again inside the transaction (another tab may have just seeded).
    const again = await requestToPromise(stores.meta.get("seedVersion"));
    if (again) return { seeded: false, seedVersion: again.value };
    const counts = await writeSeedData(stores, data);
    return { seeded: true, seedVersion: SEED_VERSION, counts };
  });
}

/**
 * One-time settings upgrade for browsers seeded before PHY-02 v2: if the
 * stored SpO₂ thresholds are STILL the original demo values
 * (warningLow 95, criticalLow 92), replace them with the current demo bands
 * (watch < 95 · warning < 93 · critical < 90). Any other stored value is left
 * alone. No schema change; never throws (the app keeps working on failure).
 */
export async function upgradeDemoThresholds({ repo = settingsRepo } = {}) {
  try {
    const t = await repo.get("thresholds");
    if (!t || !t.metrics || typeof t.metrics !== "object") return false;
    const metrics = { ...t.metrics };
    let changed = false;
    const spo2 = metrics.spo2;
    if (spo2 && Object.keys(spo2).length === 2 && spo2.warningLow === 95 && spo2.criticalLow === 92) {
      metrics.spo2 = { ...DEMO_THRESHOLDS.metrics.spo2 };
      changed = true;
    }
    // Seed version 2 metrics: add their demonstration thresholds when missing (never overwrite).
    for (const key of ["bodyTemperature", "cabinCo2", "cabinPressure", "cabinHumidity"]) {
      if (!metrics[key]) {
        metrics[key] = { ...DEMO_THRESHOLDS.metrics[key] };
        changed = true;
      }
    }
    if (!changed) return false;
    await repo.set("thresholds", { ...t, metrics }, "system");
    return true;
  } catch {
    return false;
  }
}

/**
 * Seed version 1 → 2, once: add body temperature, cabin-environment readings,
 * exercise sessions and the body-temperature baselines
 * (js/db/seed-supplement.js), and set meta.seedVersion = 2 — ONE transaction,
 * re-checked inside it (two tabs can't add the data twice). Nothing existing
 * is changed except astronauts.latest / .baseline gaining the new keys.
 * Only for astronauts of the demo crew. Never throws.
 */
export async function upgradeDemoData({ now = Date.now() } = {}) {
  try {
    const sup = buildSeedSupplement({ now, astronauts: SEED_ASTRONAUTS });
    const stores = ["meta", "measurements", "dailySummaries", "missionEvents", "astronauts"];
    return await withTransaction(stores, "readwrite", async (tx, s) => {
      const v = await requestToPromise(s.meta.get("seedVersion"));
      if (!v || v.value >= SEED_VERSION) return false;
      const writes = [];
      for (const m of sup.measurements) writes.push(requestToPromise(s.measurements.put(m)));
      for (const d of sup.dailySummaries) writes.push(requestToPromise(s.dailySummaries.put(d)));
      for (const e of sup.missionEvents) writes.push(requestToPromise(s.missionEvents.put(e)));
      for (const a of SEED_ASTRONAUTS) {
        const cur = await requestToPromise(s.astronauts.get(a.id));
        if (!cur) continue;
        writes.push(requestToPromise(s.astronauts.put({ ...cur, latest: { ...(cur.latest || {}), ...(sup.latest[a.id] || {}) }, baseline: { ...(cur.baseline || {}), ...(sup.baselines[a.id] || {}) }, updatedAt: now })));
      }
      writes.push(requestToPromise(s.meta.put({ key: "seedVersion", value: SEED_VERSION })));
      await Promise.all(writes);
      return true;
    });
  } catch {
    return false;
  }
}
