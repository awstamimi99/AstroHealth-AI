// js/db/repositories/measurements.js — store "measurements"
// Adding readings ALSO (in the same transaction):
//   • moves astronauts.latest forward when a reading is newer,
//   • updates that day's dailySummaries record.
// So a dashboard can always trust `latest` and the daily summaries.

import { run, requestToPromise, collect, prefixRange } from "../database.js";
import { DatabaseError } from "../errors.js";
import { buildMeasurement } from "../records.js";
import { applyToLatest, mergeIntoSummary, summaryId, toDateKey, isUsable } from "../summaries.js";
import { getOne, MIN_TS, MAX_TS } from "./_common.js";

const STORE = "measurements";
/** Stores a write needs — include ALL of them when you pass { tx }. */
export const MEASUREMENT_WRITE_STORES = ["measurements", "astronauts", "dailySummaries"];

/** Save already-built measurements + update caches. Runs inside a transaction. */
async function saveAll(stores, records, now) {
  await Promise.all(records.map((m) => requestToPromise(stores.measurements.add(m))));

  // 1) astronauts.latest — one read/write per astronaut
  const astronautIds = [...new Set(records.map((m) => m.astronautId))];
  for (const astronautId of astronautIds) {
    const astronaut = await getOne(stores.astronauts, astronautId);
    if (!astronaut) {
      throw new DatabaseError(`measurements: unknown astronautId "${astronautId}"`, {
        code: "NOT_FOUND",
        store: "astronauts",
        operation: "add",
      });
    }
    let latest = astronaut.latest || {};
    let changed = false;
    for (const m of records) {
      if (m.astronautId !== astronautId) continue;
      const result = applyToLatest(latest, m);
      if (result.changed) {
        latest = result.latest;
        changed = true;
      }
    }
    if (changed) await requestToPromise(stores.astronauts.put({ ...astronaut, latest, updatedAt: now }));
  }

  // 2) dailySummaries — one read/write per (astronaut, metric, day)
  const groups = new Map();
  for (const m of records.filter(isUsable)) {
    const id = summaryId(m.astronautId, m.metric, toDateKey(m.timestamp));
    groups.set(id, [...(groups.get(id) || []), m]);
  }
  for (const [id, list] of groups) {
    let summary = await getOne(stores.dailySummaries, id);
    for (const m of list) summary = mergeIntoSummary(summary, m, now);
    await requestToPromise(stores.dailySummaries.put(summary));
  }
  return records;
}

export const measurementsRepo = {
  /** Add one reading. @returns {Promise<import("../types.js").Measurement>} */
  async add(record, opts) {
    const now = Date.now();
    const built = buildMeasurement(record, now);
    await run(MEASUREMENT_WRITE_STORES, "readwrite", opts, (tx, s) => saveAll(s, [built], now));
    return built;
  },

  /** Add many readings in ONE transaction (all or nothing). */
  async addMany(records, opts) {
    const now = Date.now();
    const built = (records || []).map((r) => buildMeasurement(r, now));
    if (!built.length) return [];
    await run(MEASUREMENT_WRITE_STORES, "readwrite", opts, (tx, s) => saveAll(s, built, now));
    return built;
  },

  /** Readings between fromTs and toTs (inclusive), oldest → newest. */
  async getRange(astronautId, metric, fromTs = MIN_TS, toTs = MAX_TS, opts) {
    return run([STORE], "readonly", opts, async (tx, s) =>
      requestToPromise(
        s.measurements.index("by_astronaut_metric_time").getAll(IDBKeyRange.bound([astronautId, metric, fromTs], [astronautId, metric, toTs]))
      )
    );
  },

  /** Newest reading of a metric (any quality), or null. */
  async getLatest(astronautId, metric, opts) {
    return run([STORE], "readonly", opts, async (tx, s) => {
      const [latest] = await collect(s.measurements.index("by_astronaut_metric_time"), prefixRange(astronautId, metric), {
        direction: "prev",
        limit: 1,
      });
      return latest ?? null;
    });
  },

  /** The newest `limit` readings, returned oldest → newest (chart order). */
  async getRecent(astronautId, metric, limit = 50, opts) {
    return run([STORE], "readonly", opts, async (tx, s) => {
      const newest = await collect(s.measurements.index("by_astronaut_metric_time"), prefixRange(astronautId, metric), {
        direction: "prev",
        limit,
      });
      return newest.reverse();
    });
  },

  /** All readings taken together (e.g. systolic + diastolic). */
  async getBySample(sampleId, opts) {
    return run([STORE], "readonly", opts, async (tx, s) =>
      requestToPromise(s.measurements.index("by_sample").getAll(sampleId))
    );
  },

  /** Number of raw readings stored. */
  async countAll(opts) {
    return run([STORE], "readonly", opts, async (tx, s) => requestToPromise(s.measurements.count()));
  },
};
