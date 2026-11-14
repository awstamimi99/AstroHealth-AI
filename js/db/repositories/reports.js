// js/db/repositories/reports.js — store "reports"
// `snapshot` is a frozen copy of the numbers shown in the report, so a
// report reads the same even after data is compacted.

import { run, requestToPromise, prefixRange } from "../database.js";
import { buildReport } from "../records.js";
import { getOne, newestFirst } from "./_common.js";

const STORE = "reports";

export const reportsRepo = {
  async add(record, opts) {
    const built = buildReport(record);
    await run([STORE], "readwrite", opts, async (tx, s) => requestToPromise(s.reports.add(built)));
    return built;
  },

  async getById(id, opts) {
    return run([STORE], "readonly", opts, async (tx, s) => getOne(s.reports, id));
  },

  /** Reports filtered by type and/or astronautId ("crew" allowed), newest first. */
  async getAll({ type, astronautId } = {}, opts) {
    return run([STORE], "readonly", opts, async (tx, s) => {
      let found;
      if (type) found = await requestToPromise(s.reports.index("by_type_created").getAll(prefixRange(type)));
      else if (astronautId) found = await requestToPromise(s.reports.index("by_astronaut").getAll(astronautId));
      else found = await requestToPromise(s.reports.getAll());
      const matches = found.filter((r) => !astronautId || r.astronautId === astronautId);
      return newestFirst(matches, "createdAt");
    });
  },
};
