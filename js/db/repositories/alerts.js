// js/db/repositories/alerts.js — store "alerts"
// Storage only: Team 1's risk engine/services decide WHEN to create,
// escalate or resolve an alert, and log alertActions + missionEvents.
//
// add() assigns the human-readable number ("ALT-0191") from meta.alertCounter
// in the SAME transaction, so numbers are never reused or duplicated.

import { run, requestToPromise, prefixRange } from "../database.js";
import { buildAlert } from "../records.js";
import { nextAlertNumber } from "../ids.js";
import { OPEN_ALERT_STATUSES } from "../constants.js";
import { getOne, updateIn, asList, newestFirst, MIN_TS, MAX_TS } from "./_common.js";

const STORE = "alerts";

/** getAll() for several keys of one index, merged into one list. */
async function getAllForKeys(index, keys) {
  const lists = await Promise.all(keys.map((key) => requestToPromise(index.getAll(key))));
  return lists.flat();
}

export const alertsRepo = {
  /**
   * Create an alert. Any `number` you pass is ignored — a new one is assigned.
   * Needs stores ["alerts", "meta"] when you pass { tx }.
   */
  async add(record, opts) {
    return run([STORE, "meta"], "readwrite", opts, async (tx, s) => {
      const number = await nextAlertNumber(s.meta);
      const built = buildAlert({ ...record, number });
      await requestToPromise(s.alerts.add(built));
      return built;
    });
  },

  async update(id, changes, opts) {
    return run([STORE], "readwrite", opts, async (tx, s) => updateIn(s.alerts, STORE, id, changes));
  },

  async getById(id, opts) {
    return run([STORE], "readonly", opts, async (tx, s) => getOne(s.alerts, id));
  },

  /**
   * The OPEN alert (new or acknowledged) for a dedupeKey, or null.
   * Use it before creating a new alert to avoid duplicates.
   */
  async getOpenByDedupeKey(dedupeKey, opts) {
    return run([STORE], "readonly", opts, async (tx, s) => {
      const keys = OPEN_ALERT_STATUSES.map((status) => [dedupeKey, status]);
      const open = newestFirst(await getAllForKeys(s.alerts.index("by_dedupe_status"), keys), "detectedAt");
      return open[0] ?? null;
    });
  },

  /**
   * Find alerts. Every filter is optional; status/severity may be a string
   * or an array. Sorted by detectedAt, newest first.
   * @param {import("../types.js").AlertQuery} [filters]
   */
  async query(filters = {}, opts) {
    const { astronautId, fromTs = MIN_TS, toTs = MAX_TS, limit = Infinity } = filters;
    const statuses = asList(filters.status);
    const severities = asList(filters.severity);

    return run([STORE], "readonly", opts, async (tx, s) => {
      // 1) use the most selective index we can…
      let found;
      if (astronautId && statuses) {
        found = await getAllForKeys(s.alerts.index("by_astronaut_status"), statuses.map((st) => [astronautId, st]));
      } else if (astronautId) {
        found = await requestToPromise(s.alerts.index("by_astronaut_status").getAll(prefixRange(astronautId)));
      } else if (statuses) {
        found = await getAllForKeys(s.alerts.index("by_status"), statuses);
      } else if (severities) {
        found = await getAllForKeys(s.alerts.index("by_severity"), severities);
      } else {
        found = await requestToPromise(s.alerts.index("by_detected").getAll(IDBKeyRange.bound(fromTs, toTs)));
      }
      // 2) …then apply every filter in plain JS (cheap: alerts are few).
      const matches = found.filter(
        (a) =>
          (!astronautId || a.astronautId === astronautId) &&
          (!statuses || statuses.includes(a.status)) &&
          (!severities || severities.includes(a.severity)) &&
          a.detectedAt >= fromTs &&
          a.detectedAt <= toTs
      );
      return newestFirst(matches, "detectedAt").slice(0, limit);
    });
  },

  /** Number of open alerts (new + acknowledged), optionally for one astronaut. */
  async countOpen({ astronautId } = {}, opts) {
    return run([STORE], "readonly", opts, async (tx, s) => {
      const counts = await Promise.all(
        OPEN_ALERT_STATUSES.map((status) =>
          astronautId
            ? requestToPromise(s.alerts.index("by_astronaut_status").count([astronautId, status]))
            : requestToPromise(s.alerts.index("by_status").count(status))
        )
      );
      return counts.reduce((sum, n) => sum + n, 0);
    });
  },
};
