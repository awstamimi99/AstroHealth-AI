// js/db/maintenance.js
// Housekeeping: compacting old raw readings and checking storage use.
//
// Retention: raw measurements are kept for `keepRawDays` (7). Older WHOLE
// UTC days are rolled into dailySummaries and the raw readings deleted —
// one transaction per day, so a crash can never lose a day.

import { withTransaction, requestToPromise } from "./database.js";
import { summarize, startOfUtcDay, toDateKey, dateKeyToStart } from "./summaries.js";
import { DAY_MS } from "./constants.js";

/** Find the distinct UTC days that have raw readings before `cutoff`. */
async function daysBefore(cutoff) {
  return withTransaction(["measurements"], "readonly", (tx, s) =>
    new Promise((resolve, reject) => {
      const days = [];
      // A KEY cursor on the time index reads only timestamps (fast).
      const request = s.measurements.index("by_time").openKeyCursor(IDBKeyRange.upperBound(cutoff, true));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(days);
        const day = toDateKey(cursor.key);
        days.push(day);
        // Jump straight to the next day instead of visiting every reading.
        const nextDay = dateKeyToStart(day) + DAY_MS;
        if (nextDay >= cutoff) return resolve(days);
        cursor.continue(nextDay);
      };
    })
  );
}

/**
 * Roll raw readings older than `keepRawDays` into dailySummaries and delete them.
 * @param {{ keepRawDays?: number, now?: number }} [options]
 * @returns {Promise<{ daysCompacted: number, readingsDeleted: number, summariesWritten: number }>}
 */
export async function compactMeasurements({ keepRawDays = 7, now = Date.now() } = {}) {
  const cutoff = startOfUtcDay(now) - keepRawDays * DAY_MS; // keep today + 7 whole days
  const days = await daysBefore(cutoff);
  let readingsDeleted = 0;
  let summariesWritten = 0;

  for (const day of days) {
    const from = dateKeyToStart(day);
    const result = await withTransaction(["measurements", "dailySummaries"], "readwrite", async (tx, s) => {
      const readings = await requestToPromise(
        s.measurements.index("by_time").getAll(IDBKeyRange.bound(from, from + DAY_MS, false, true))
      );
      // Recompute the day EXACTLY from its raw readings (replaces the summary).
      const summaries = summarize(readings, now);
      for (const summary of summaries) {
        const existing = await requestToPromise(s.dailySummaries.get(summary.id));
        if (existing) summary.createdAt = existing.createdAt;
        await requestToPromise(s.dailySummaries.put(summary));
      }
      await Promise.all(readings.map((m) => requestToPromise(s.measurements.delete(m.id))));
      return { deleted: readings.length, written: summaries.length };
    });
    readingsDeleted += result.deleted;
    summariesWritten += result.written;
  }

  await withTransaction(["meta"], "readwrite", (tx, s) =>
    requestToPromise(s.meta.put({ key: "lastCompactedAt", value: now }))
  );
  return { daysCompacted: days.length, readingsDeleted, summariesWritten };
}

/**
 * How much storage the app uses.
 * @returns {Promise<{ usage: number|null, quota: number|null, persisted: boolean }>}
 */
export async function getStorageInfo() {
  const storage = typeof navigator !== "undefined" ? navigator.storage : undefined;
  let usage = null;
  let quota = null;
  let persisted = false;
  try {
    if (storage?.estimate) ({ usage = null, quota = null } = await storage.estimate());
    if (storage?.persisted) persisted = await storage.persisted();
  } catch {
    /* not available (old browser / private mode) */
  }
  return { usage, quota, persisted };
}
