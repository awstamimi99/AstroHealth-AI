// js/db/repositories/cognitive.js — store "cognitiveChecks"
// Reaction-time checks (non-diagnostic demo).

import { run, requestToPromise } from "../database.js";
import { buildCognitiveCheck } from "../records.js";
import { MIN_TS, MAX_TS } from "./_common.js";

const STORE = "cognitiveChecks";

export const cognitiveRepo = {
  async add(record, opts) {
    const built = buildCognitiveCheck(record);
    await run([STORE], "readwrite", opts, async (tx, s) => requestToPromise(s.cognitiveChecks.add(built)));
    return built;
  },

  /** One astronaut's checks, oldest → newest. */
  async getRange(astronautId, fromTs = MIN_TS, toTs = MAX_TS, opts) {
    return run([STORE], "readonly", opts, async (tx, s) =>
      requestToPromise(s.cognitiveChecks.index("by_astronaut_time").getAll(IDBKeyRange.bound([astronautId, fromTs], [astronautId, toTs])))
    );
  },
};
