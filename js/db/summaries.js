// js/db/summaries.js
// Pure helpers for dates, daily summaries and the astronaut "latest" cache.
// No IndexedDB here, so Node unit tests can import it — and both the real
// repositories and the mock use EXACTLY the same logic.

import { DAY_MS, SYSTEM_USER } from "./constants.js";

// ---- Dates (always UTC) --------------------------------------------------

/** ms timestamp → "YYYY-MM-DD" (UTC calendar day). */
export function toDateKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" → ms at 00:00 UTC of that day. */
export function dateKeyToStart(dateKey) {
  return Date.parse(`${dateKey}T00:00:00.000Z`);
}

/** ms at 00:00 UTC of the day containing `timestamp`. */
export function startOfUtcDay(timestamp) {
  return Math.floor(timestamp / DAY_MS) * DAY_MS;
}

/** Primary key of a daily summary. */
export function summaryId(astronautId, metric, date) {
  return `${astronautId}:${metric}:${date}`;
}

// ---- Daily summaries -----------------------------------------------------

/** Readings marked "invalid" never count in summaries or the latest cache. */
export function isUsable(measurement) {
  return measurement.quality !== "invalid";
}

/**
 * Add ONE measurement to a summary (or start a new one).
 * Returns a NEW object; the input is not changed.
 * @param {object|null} summary   existing summary for that day, or null
 * @param {object} m              measurement { astronautId, metric, value, timestamp }
 * @param {number} [now]
 */
export function mergeIntoSummary(summary, m, now = Date.now()) {
  const date = toDateKey(m.timestamp);
  if (!summary) {
    return {
      id: summaryId(m.astronautId, m.metric, date),
      astronautId: m.astronautId,
      metric: m.metric,
      date,
      min: m.value,
      max: m.value,
      avg: m.value,
      count: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: SYSTEM_USER,
    };
  }
  const count = summary.count + 1;
  return {
    ...summary,
    min: Math.min(summary.min, m.value),
    max: Math.max(summary.max, m.value),
    // running average: new avg = old avg + (value − old avg) / new count
    avg: summary.avg + (m.value - summary.avg) / count,
    count,
    updatedAt: now,
  };
}

/**
 * Build daily summaries from a list of measurements (any astronauts,
 * metrics and days). Invalid readings are skipped.
 * @returns {object[]} summaries sorted by id
 */
export function summarize(measurements, now = Date.now()) {
  const byId = new Map();
  for (const m of measurements) {
    if (!isUsable(m)) continue;
    const id = summaryId(m.astronautId, m.metric, toDateKey(m.timestamp));
    byId.set(id, mergeIntoSummary(byId.get(id) || null, m, now));
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---- Latest-value cache (astronauts.latest) ------------------------------

/**
 * Apply a measurement to an astronaut's `latest` object.
 * Only moves FORWARD in time; invalid readings are ignored.
 * @returns {{ changed: boolean, latest: object }}  (new object when changed)
 */
export function applyToLatest(latest, m) {
  const current = latest?.[m.metric];
  if (!isUsable(m) || (current && current.timestamp >= m.timestamp)) {
    return { changed: false, latest: latest || {} };
  }
  return {
    changed: true,
    latest: { ...(latest || {}), [m.metric]: { value: m.value, timestamp: m.timestamp } },
  };
}
