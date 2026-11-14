// js/db/repositories/daily-summaries.js — store "dailySummaries"
// One record per astronaut + metric + UTC day: { min, max, avg, count }.
// Kept up to date automatically by measurementsRepo; use these for
// 7d / 14d / 30d charts. For "activity", the day's max = daily step total.

import { run, requestToPromise } from "../database.js";
import { buildDailySummary } from "../records.js";

const STORE = "dailySummaries";

export const dailySummariesRepo = {
  /**
   * Summaries from fromDate to toDate (inclusive), oldest → newest.
   * @param {string} fromDate "YYYY-MM-DD" (UTC)
   * @param {string} toDate   "YYYY-MM-DD" (UTC)
   */
  async getRange(astronautId, metric, fromDate = "0000-00-00", toDate = "9999-99-99", opts) {
    return run([STORE], "readonly", opts, async (tx, s) =>
      requestToPromise(
        s.dailySummaries.index("by_astronaut_metric_date").getAll(IDBKeyRange.bound([astronautId, metric, fromDate], [astronautId, metric, toDate]))
      )
    );
  },

  /** Insert or replace one summary (its id is computed for you). */
  async upsert(summary, opts) {
    const record = buildDailySummary(summary);
    await run([STORE], "readwrite", opts, async (tx, s) => requestToPromise(s.dailySummaries.put(record)));
    return record;
  },
};
