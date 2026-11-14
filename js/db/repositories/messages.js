// js/db/repositories/messages.js — store "messages"
// Medical officer ↔ astronaut messages. acknowledgedAt is 0 until the
// astronaut acknowledges; `response` is null until they reply.

import { run, requestToPromise, prefixRange } from "../database.js";
import { buildMessage } from "../records.js";
import { getOne, updateIn, newestFirst } from "./_common.js";

const STORE = "messages";

async function byAstronaut(store, astronautId) {
  return newestFirst(await requestToPromise(store.index("by_astronaut_time").getAll(prefixRange(astronautId))), "sentAt");
}

export const messagesRepo = {
  async add(record, opts) {
    const built = buildMessage(record);
    await run([STORE], "readwrite", opts, async (tx, s) => requestToPromise(s.messages.add(built)));
    return built;
  },

  async update(id, changes, opts) {
    return run([STORE], "readwrite", opts, async (tx, s) => updateIn(s.messages, STORE, id, changes));
  },

  async getById(id, opts) {
    return run([STORE], "readonly", opts, async (tx, s) => getOne(s.messages, id));
  },

  /** Newest first. */
  async getByAstronaut(astronautId, opts) {
    return run([STORE], "readonly", opts, async (tx, s) => byAstronaut(s.messages, astronautId));
  },

  /** Messages about one alert (by alert id, not number), newest first. */
  async getByAlert(alertId, opts) {
    return run([STORE], "readonly", opts, async (tx, s) =>
      newestFirst(await requestToPromise(s.messages.index("by_alert").getAll(alertId)), "sentAt")
    );
  },

  /** Messages the astronaut hasn't acknowledged yet, newest first. */
  async getUnacknowledged(astronautId, opts) {
    return run([STORE], "readonly", opts, async (tx, s) =>
      (await byAstronaut(s.messages, astronautId)).filter((m) => m.acknowledgedAt === 0)
    );
  },
};
