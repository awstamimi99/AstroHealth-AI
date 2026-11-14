// js/db/repositories/simulation-runs.js — store "simulationRuns"
// endedAt is 0 until the run stops or completes.

import { run, requestToPromise } from "../database.js";
import { buildSimulationRun } from "../records.js";
import { ACTIVE_SIMULATION_STATUSES } from "../constants.js";
import { getOne, updateIn, newestFirst } from "./_common.js";

const STORE = "simulationRuns";

export const simulationRunsRepo = {
  async add(record, opts) {
    const built = buildSimulationRun(record);
    await run([STORE], "readwrite", opts, async (tx, s) => requestToPromise(s.simulationRuns.add(built)));
    return built;
  },

  async update(id, changes, opts) {
    return run([STORE], "readwrite", opts, async (tx, s) => updateIn(s.simulationRuns, STORE, id, changes));
  },

  async getById(id, opts) {
    return run([STORE], "readonly", opts, async (tx, s) => getOne(s.simulationRuns, id));
  },

  /** Runs that are "running" or "paused", newest start first. */
  async getActive(opts) {
    return run([STORE], "readonly", opts, async (tx, s) => {
      const lists = await Promise.all(
        ACTIVE_SIMULATION_STATUSES.map((status) => requestToPromise(s.simulationRuns.index("by_status").getAll(status)))
      );
      return newestFirst(lists.flat(), "startedAt");
    });
  },

  /** All runs for one astronaut, newest start first. */
  async getByAstronaut(astronautId, opts) {
    return run([STORE], "readonly", opts, async (tx, s) =>
      newestFirst(await requestToPromise(s.simulationRuns.index("by_astronaut").getAll(astronautId)), "startedAt")
    );
  },
};
