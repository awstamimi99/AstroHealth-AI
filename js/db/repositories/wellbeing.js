// js/db/repositories/wellbeing.js — store "wellbeingAssessments"
// Daily check-ins. `sharedWithMedical` is 0/1 (default 0 = private).
// Medical-officer views must use getSharedRange().

import { run, requestToPromise, collect, prefixRange } from "../database.js";
import { buildWellbeing } from "../records.js";
import { MIN_TS, MAX_TS } from "./_common.js";

const STORE = "wellbeingAssessments";

export const wellbeingRepo = {
  async add(record, opts) {
    const built = buildWellbeing(record);
    await run([STORE], "readwrite", opts, async (tx, s) => requestToPromise(s.wellbeingAssessments.add(built)));
    return built;
  },

  /** One astronaut's check-ins, oldest → newest. */
  async getRange(astronautId, fromTs = MIN_TS, toTs = MAX_TS, opts) {
    return run([STORE], "readonly", opts, async (tx, s) =>
      requestToPromise(
        s.wellbeingAssessments.index("by_astronaut_time").getAll(IDBKeyRange.bound([astronautId, fromTs], [astronautId, toTs]))
      )
    );
  },

  /** Newest check-in of an astronaut, or null. */
  async getLatest(astronautId, opts) {
    return run([STORE], "readonly", opts, async (tx, s) => {
      const [latest] = await collect(s.wellbeingAssessments.index("by_astronaut_time"), prefixRange(astronautId), {
        direction: "prev",
        limit: 1,
      });
      return latest ?? null;
    });
  },

  /** ALL astronauts' check-ins with sharedWithMedical = 1, oldest → newest. */
  async getSharedRange(fromTs = MIN_TS, toTs = MAX_TS, opts) {
    return run([STORE], "readonly", opts, async (tx, s) =>
      requestToPromise(s.wellbeingAssessments.index("by_shared_time").getAll(IDBKeyRange.bound([1, fromTs], [1, toTs])))
    );
  },
};
