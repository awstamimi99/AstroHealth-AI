// js/db/repositories/journal.js — store "privateJournal"
// Private reflections. Its own store so Medical Officer queries can never
// touch it by accident. Services must only show entries to their owner.
// NOT encrypted (out of scope for this prototype). Never log these in
// missionEvents.

import { run, requestToPromise, prefixRange } from "../database.js";
import { buildJournalEntry } from "../records.js";
import { newestFirst } from "./_common.js";

const STORE = "privateJournal";

export const journalRepo = {
  async add(record, opts) {
    const built = buildJournalEntry(record);
    await run([STORE], "readwrite", opts, async (tx, s) => requestToPromise(s.privateJournal.add(built)));
    return built;
  },

  /** One astronaut's entries, newest → oldest. */
  async getByAstronaut(astronautId, opts) {
    return run([STORE], "readonly", opts, async (tx, s) =>
      newestFirst(await requestToPromise(s.privateJournal.index("by_astronaut_time").getAll(prefixRange(astronautId))))
    );
  },
};
