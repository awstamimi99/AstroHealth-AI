// js/db/repositories/events.js — store "missionEvents" (the timeline)
// astronautId is an astronaut id or "crew" for crew-wide events.
// Privacy: never put private journal text or un-shared check-in scores here.

import { run, requestToPromise } from "../database.js";
import { buildEvent } from "../records.js";
import { asList, newestFirst, MIN_TS, MAX_TS } from "./_common.js";

const STORE = "missionEvents";

export const eventsRepo = {
  async add(record, opts) {
    const built = buildEvent(record);
    await run([STORE], "readwrite", opts, async (tx, s) => requestToPromise(s.missionEvents.add(built)));
    return built;
  },

  /** Add several events in one transaction. */
  async addMany(records, opts) {
    const now = Date.now();
    const built = (records || []).map((r) => buildEvent(r, now));
    await run([STORE], "readwrite", opts, async (tx, s) =>
      Promise.all(built.map((e) => requestToPromise(s.missionEvents.add(e))))
    );
    return built;
  },

  /**
   * Timeline query, newest first. All filters optional.
   * `astronautId` and `types` may be a string or an array
   * (e.g. astronautId: ["a-01", "crew"]).
   * @param {import("../types.js").EventQuery} [filters]
   */
  async getRange(filters = {}, opts) {
    const { fromTs = MIN_TS, toTs = MAX_TS, limit = Infinity } = filters;
    const astronautIds = asList(filters.astronautId);
    const types = asList(filters.types);

    return run([STORE], "readonly", opts, async (tx, s) => {
      const store = s.missionEvents;
      let found;
      if (astronautIds) {
        const lists = await Promise.all(
          astronautIds.map((id) => requestToPromise(store.index("by_astronaut_time").getAll(IDBKeyRange.bound([id, fromTs], [id, toTs]))))
        );
        found = lists.flat();
      } else if (types) {
        const lists = await Promise.all(
          types.map((type) => requestToPromise(store.index("by_type_time").getAll(IDBKeyRange.bound([type, fromTs], [type, toTs]))))
        );
        found = lists.flat();
      } else {
        found = await requestToPromise(store.index("by_time").getAll(IDBKeyRange.bound(fromTs, toTs)));
      }
      const matches = types ? found.filter((e) => types.includes(e.type)) : found;
      return newestFirst(matches).slice(0, limit);
    });
  },
};
