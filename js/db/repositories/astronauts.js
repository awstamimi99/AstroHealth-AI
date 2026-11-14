// js/db/repositories/astronauts.js — store "astronauts"
// `latest` is a cache of the newest value per metric. measurementsRepo keeps
// it up to date automatically; updateLatest() is for special cases.

import { run, requestToPromise } from "../database.js";
import { DatabaseError } from "../errors.js";
import { applyToLatest } from "../summaries.js";
import { buildMeasurement } from "../records.js";
import { getOne, updateIn } from "./_common.js";

const STORE = "astronauts";

export const astronautsRepo = {
  /** All astronauts sorted by crewId (AH-01, AH-02, …). */
  async getAll(opts) {
    return run([STORE], "readonly", opts, async (tx, s) => requestToPromise(s.astronauts.index("crewId").getAll()));
  },

  async getById(id, opts) {
    return run([STORE], "readonly", opts, async (tx, s) => getOne(s.astronauts, id));
  },

  /** e.g. getByCrewId("AH-01") */
  async getByCrewId(crewId, opts) {
    return run([STORE], "readonly", opts, async (tx, s) => getOne(s.astronauts.index("crewId"), crewId));
  },

  /** Shallow merge: pass the WHOLE `baseline` object if you change it. */
  async update(id, changes, opts) {
    return run([STORE], "readwrite", opts, async (tx, s) => updateIn(s.astronauts, STORE, id, changes));
  },

  /**
   * Set latest[metric] only if `timestamp` is newer than what's cached.
   * @returns {Promise<import("../types.js").Astronaut>} (unchanged if not newer)
   */
  async updateLatest(astronautId, metric, value, timestamp, opts) {
    // Same rules as a stored reading: known metric, finite number, valid timestamp.
    buildMeasurement({ astronautId, metric, value, timestamp });
    return run([STORE], "readwrite", opts, async (tx, s) => {
      const astronaut = await getOne(s.astronauts, astronautId);
      if (!astronaut) {
        throw new DatabaseError(`astronauts: no astronaut "${astronautId}"`, { code: "NOT_FOUND", store: STORE });
      }
      const { changed, latest } = applyToLatest(astronaut.latest, { metric, value, timestamp, quality: "ok" });
      if (!changed) return astronaut;
      const updated = { ...astronaut, latest, updatedAt: Date.now() };
      await requestToPromise(s.astronauts.put(updated));
      return updated;
    });
  },
};
