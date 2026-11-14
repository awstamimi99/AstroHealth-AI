// js/db/mock-repositories.js
// In-memory repositories with the SAME names and signatures as the real ones
// (js/db/index.js). Use them in unit tests or while prototyping:
//
//   import { alertsRepo, resetMock } from "../db/mock-repositories.js";
//   await resetMock();               // fresh demo data (default)
//   await resetMock({ seed: false }); // empty
//
// Same defaults and index checks as the real database (shared records.js),
// same seed data, same sort orders. Differences: data lives in memory only,
// no cross-tab sharing, and the `{ tx }` option is accepted but ignored.
// withTransaction() snapshots the data and restores it if your callback throws.
// Works in browsers and Node 18+ (no IndexedDB needed).

import { buildSeedData, DEMO_PASSWORD } from "./seed-data.js";
import { SCHEMA, STORE_NAMES } from "./schema.js";
import { DatabaseError } from "./errors.js";
import { formatAlertNumber } from "./ids.js";
import { hashPassword, checkPassword } from "./password.js";
import { applyToLatest, mergeIntoSummary, summaryId, toDateKey, isUsable } from "./summaries.js";
import { OPEN_ALERT_STATUSES, ACTIVE_SIMULATION_STATUSES, SYSTEM_USER } from "./constants.js";
import {
  buildAlert, buildAlertAction, buildCognitiveCheck, buildDailySummary, buildEvent, buildJournalEntry,
  buildMeasurement, buildMessage, buildReport, buildSimulationRun, buildUser, buildWellbeing,
  mergeChanges, normalizeUsername, toSafeUser,
} from "./records.js";

// ---- In-memory "database": one Map per store ------------------------------

const emptyData = () => Object.fromEntries(STORE_NAMES.map((name) => [name, new Map()]));
let data = emptyData();
let loading = null;

/** Unique indexes to enforce, like IndexedDB does. */
const UNIQUE = { users: "username", astronauts: "crewId", alerts: "number" };

const clone = (value) => (value == null ? null : structuredClone(value));
const keyOf = (store, record) => record[SCHEMA[store].keyPath];
const all = (store) => [...data[store].values()].map(clone);
const getOne = (store, key) => clone(data[store].get(key));
// Same ordering as the real repositories: by field, equal values by id (ascending).
const byField = (field, dir = 1) => (a, b) => dir * (a[field] - b[field]) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const asList = (v) => (v === undefined || v === null ? null : [].concat(v));
const between = (t, from = -Infinity, to = Infinity) => t >= from && t <= to;

function checkUnique(store, record) {
  const field = UNIQUE[store];
  if (!field) return;
  for (const other of data[store].values()) {
    if (other[field] === record[field] && keyOf(store, other) !== keyOf(store, record)) {
      throw new DatabaseError(`${store}: "${field}" ${JSON.stringify(record[field])} already exists`, {
        code: "CONSTRAINT",
        store,
      });
    }
  }
}

/** put = insert or replace. */
function put(store, record) {
  checkUnique(store, record);
  data[store].set(keyOf(store, record), structuredClone(record));
  return clone(record);
}

/** add = insert only (fails on an existing key, like IndexedDB add()). */
function insert(store, record) {
  if (data[store].has(keyOf(store, record))) {
    throw new DatabaseError(`${store}: a record with key "${keyOf(store, record)}" already exists`, {
      code: "CONSTRAINT",
      store,
    });
  }
  return put(store, record);
}

function update(store, id, changes) {
  const existing = data[store].get(id);
  if (!existing) throw new DatabaseError(`${store}: no record with id "${id}"`, { code: "NOT_FOUND", store });
  return put(store, mergeChanges(store, existing, changes));
}

async function load({ seed = true, now = Date.now() } = {}) {
  const fresh = emptyData();
  if (seed) {
    const seedData = buildSeedData({ now });
    seedData.users = await Promise.all(seedData.users.map(async (u) => ({ ...u, ...(await hashPassword(DEMO_PASSWORD)) })));
    for (const name of STORE_NAMES) {
      for (const record of seedData[name]) fresh[name].set(keyOf(name, record), record);
    }
  }
  data = fresh;
}

/**
 * Replace the in-memory data. Called automatically (with seed) on first use.
 * @param {{ seed?: boolean, now?: number }} [options]
 */
export function resetMock(options) {
  loading = load(options);
  return loading;
}

const ready = () => loading || resetMock();

/** Same signature as the real withTransaction(); rolls back on error. */
export async function withTransaction(storeNames, mode, work) {
  await ready();
  const snapshot = structuredClone(data);
  try {
    return await work(null, {});
  } catch (err) {
    data = snapshot;
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`Transaction rolled back: ${err?.message ?? err}`, { code: "TRANSACTION_FAILED", cause: err });
  }
}

// ---- Repositories (same API as js/db/repositories/*) ------------------------

export const usersRepo = {
  async getById(id, opts) { await ready(); return toSafeUser(getOne("users", id)); },
  async getByUsername(username, opts) {
    await ready();
    const name = normalizeUsername(username);
    return toSafeUser(all("users").find((u) => u.username === name) ?? null);
  },
  async getAll(opts) {
    await ready();
    return all("users").sort((a, b) => a.username.localeCompare(b.username)).map(toSafeUser);
  },
  async add(input) {
    await ready();
    const { password, ...rest } = input || {};
    if (!password) throw new DatabaseError("users: a password is required", { code: "INVALID", store: "users" });
    const user = { ...buildUser(rest), ...(await hashPassword(password)) };
    return toSafeUser(insert("users", user));
  },
  async update(id, changes = {}) {
    await ready();
    const { password, passwordHash, salt, ...rest } = changes;
    if (rest.username !== undefined) rest.username = normalizeUsername(rest.username);
    const secret = password ? await hashPassword(password) : {};
    const updated = update("users", id, rest);
    return toSafeUser(put("users", { ...updated, ...secret }));
  },
  async verifyPassword(username, password) {
    await ready();
    const user = all("users").find((u) => u.username === normalizeUsername(username));
    if (!user) return null;
    return (await checkPassword(password, user.passwordHash, user.salt)) ? toSafeUser(user) : null;
  },
};

export const astronautsRepo = {
  async getAll(opts) { await ready(); return all("astronauts").sort((a, b) => a.crewId.localeCompare(b.crewId)); },
  async getById(id, opts) { await ready(); return getOne("astronauts", id); },
  async getByCrewId(crewId, opts) { await ready(); return all("astronauts").find((a) => a.crewId === crewId) ?? null; },
  async update(id, changes, opts) { await ready(); return update("astronauts", id, changes); },
  async updateLatest(astronautId, metric, value, timestamp, opts) {
    await ready();
    buildMeasurement({ astronautId, metric, value, timestamp }); // same validation as the real repo
    const astronaut = getOne("astronauts", astronautId);
    if (!astronaut) throw new DatabaseError(`astronauts: no astronaut "${astronautId}"`, { code: "NOT_FOUND", store: "astronauts" });
    const { changed, latest } = applyToLatest(astronaut.latest, { metric, value, timestamp, quality: "ok" });
    return changed ? put("astronauts", { ...astronaut, latest, updatedAt: Date.now() }) : astronaut;
  },
};

function saveMeasurements(records) {
  const now = Date.now();
  const built = records.map((r) => buildMeasurement(r, now));
  // Check everything first, so a bad record saves nothing (like a transaction).
  for (const m of built) {
    if (!data.astronauts.has(m.astronautId)) {
      throw new DatabaseError(`measurements: unknown astronautId "${m.astronautId}"`, { code: "NOT_FOUND", store: "astronauts" });
    }
    if (data.measurements.has(m.id)) throw new DatabaseError(`measurements: id "${m.id}" already exists`, { code: "CONSTRAINT" });
  }
  for (const m of built) {
    insert("measurements", m);
    const astronaut = data.astronauts.get(m.astronautId);
    const { changed, latest } = applyToLatest(astronaut.latest, m);
    if (changed) put("astronauts", { ...astronaut, latest, updatedAt: now });
    if (isUsable(m)) {
      const id = summaryId(m.astronautId, m.metric, toDateKey(m.timestamp));
      put("dailySummaries", mergeIntoSummary(data.dailySummaries.get(id) ?? null, m, now));
    }
  }
  return built.map(clone);
}

const readings = (astronautId, metric) =>
  all("measurements").filter((m) => m.astronautId === astronautId && m.metric === metric).sort(byField("timestamp"));

export const measurementsRepo = {
  async add(record, opts) { await ready(); return saveMeasurements([record])[0]; },
  async addMany(records, opts) { await ready(); return saveMeasurements(records || []); },
  async getRange(astronautId, metric, fromTs, toTs, opts) {
    await ready();
    return readings(astronautId, metric).filter((m) => between(m.timestamp, fromTs, toTs));
  },
  async getLatest(astronautId, metric, opts) { await ready(); return readings(astronautId, metric).at(-1) ?? null; },
  async getRecent(astronautId, metric, limit = 50, opts) { await ready(); return readings(astronautId, metric).slice(-limit); },
  async getBySample(sampleId, opts) { await ready(); return all("measurements").filter((m) => m.sampleId === sampleId); },
  async countAll(opts) { await ready(); return data.measurements.size; },
};

export const dailySummariesRepo = {
  async getRange(astronautId, metric, fromDate = "0000-00-00", toDate = "9999-99-99", opts) {
    await ready();
    return all("dailySummaries")
      .filter((s) => s.astronautId === astronautId && s.metric === metric && s.date >= fromDate && s.date <= toDate)
      .sort((a, b) => a.date.localeCompare(b.date));
  },
  async upsert(summary, opts) { await ready(); return put("dailySummaries", buildDailySummary(summary)); },
};

export const wellbeingRepo = {
  async add(record, opts) { await ready(); return insert("wellbeingAssessments", buildWellbeing(record)); },
  async getRange(astronautId, fromTs, toTs, opts) {
    await ready();
    return all("wellbeingAssessments")
      .filter((w) => w.astronautId === astronautId && between(w.timestamp, fromTs, toTs))
      .sort(byField("timestamp"));
  },
  async getLatest(astronautId, opts) {
    await ready();
    return all("wellbeingAssessments").filter((w) => w.astronautId === astronautId).sort(byField("timestamp")).at(-1) ?? null;
  },
  async getSharedRange(fromTs, toTs, opts) {
    await ready();
    return all("wellbeingAssessments")
      .filter((w) => w.sharedWithMedical === 1 && between(w.timestamp, fromTs, toTs))
      .sort(byField("timestamp"));
  },
};

export const journalRepo = {
  async add(record, opts) { await ready(); return insert("privateJournal", buildJournalEntry(record)); },
  async getByAstronaut(astronautId, opts) {
    await ready();
    return all("privateJournal").filter((j) => j.astronautId === astronautId).sort(byField("timestamp", -1));
  },
};

export const cognitiveRepo = {
  async add(record, opts) { await ready(); return insert("cognitiveChecks", buildCognitiveCheck(record)); },
  async getRange(astronautId, fromTs, toTs, opts) {
    await ready();
    return all("cognitiveChecks")
      .filter((c) => c.astronautId === astronautId && between(c.timestamp, fromTs, toTs))
      .sort(byField("timestamp"));
  },
};

export const simulationRunsRepo = {
  async add(record, opts) { await ready(); return insert("simulationRuns", buildSimulationRun(record)); },
  async update(id, changes, opts) { await ready(); return update("simulationRuns", id, changes); },
  async getById(id, opts) { await ready(); return getOne("simulationRuns", id); },
  async getActive(opts) {
    await ready();
    return all("simulationRuns").filter((r) => ACTIVE_SIMULATION_STATUSES.includes(r.status)).sort(byField("startedAt", -1));
  },
  async getByAstronaut(astronautId, opts) {
    await ready();
    return all("simulationRuns").filter((r) => r.astronautId === astronautId).sort(byField("startedAt", -1));
  },
};

export const alertsRepo = {
  async add(record, opts) {
    await ready();
    const counter = (data.meta.get("alertCounter")?.value ?? 0) + 1;
    const built = buildAlert({ ...record, number: formatAlertNumber(counter) });
    insert("alerts", built);
    put("meta", { key: "alertCounter", value: counter });
    return clone(built);
  },
  async update(id, changes, opts) { await ready(); return update("alerts", id, changes); },
  async getById(id, opts) { await ready(); return getOne("alerts", id); },
  async getOpenByDedupeKey(dedupeKey, opts) {
    await ready();
    return all("alerts")
      .filter((a) => a.dedupeKey === dedupeKey && OPEN_ALERT_STATUSES.includes(a.status))
      .sort(byField("detectedAt", -1))[0] ?? null;
  },
  async query(filters = {}, opts) {
    await ready();
    const { astronautId, fromTs, toTs, limit = Infinity } = filters;
    const statuses = asList(filters.status);
    const severities = asList(filters.severity);
    return all("alerts")
      .filter(
        (a) =>
          (!astronautId || a.astronautId === astronautId) &&
          (!statuses || statuses.includes(a.status)) &&
          (!severities || severities.includes(a.severity)) &&
          between(a.detectedAt, fromTs, toTs)
      )
      .sort(byField("detectedAt", -1))
      .slice(0, limit);
  },
  async countOpen({ astronautId } = {}, opts) {
    await ready();
    return all("alerts").filter((a) => OPEN_ALERT_STATUSES.includes(a.status) && (!astronautId || a.astronautId === astronautId)).length;
  },
};

export const alertActionsRepo = {
  async add(record, opts) { await ready(); return insert("alertActions", buildAlertAction(record)); },
  async getByAlert(alertId, opts) {
    await ready();
    return all("alertActions").filter((a) => a.alertId === alertId).sort(byField("timestamp"));
  },
};

const messagesOf = (astronautId) =>
  all("messages").filter((m) => m.astronautId === astronautId).sort(byField("sentAt", -1));

export const messagesRepo = {
  async add(record, opts) { await ready(); return insert("messages", buildMessage(record)); },
  async update(id, changes, opts) { await ready(); return update("messages", id, changes); },
  async getById(id, opts) { await ready(); return getOne("messages", id); },
  async getByAstronaut(astronautId, opts) { await ready(); return messagesOf(astronautId); },
  async getByAlert(alertId, opts) {
    await ready();
    return all("messages").filter((m) => m.relatedAlertId === alertId).sort(byField("sentAt", -1));
  },
  async getUnacknowledged(astronautId, opts) { await ready(); return messagesOf(astronautId).filter((m) => m.acknowledgedAt === 0); },
};

export const eventsRepo = {
  async add(record, opts) { await ready(); return insert("missionEvents", buildEvent(record)); },
  async addMany(records, opts) {
    await ready();
    const now = Date.now();
    const built = (records || []).map((r) => buildEvent(r, now));
    return built.map((e) => insert("missionEvents", e));
  },
  async getRange(filters = {}, opts) {
    await ready();
    const { fromTs, toTs, limit = Infinity } = filters;
    const ids = asList(filters.astronautId);
    const types = asList(filters.types);
    return all("missionEvents")
      .filter((e) => (!ids || ids.includes(e.astronautId)) && (!types || types.includes(e.type)) && between(e.timestamp, fromTs, toTs))
      .sort(byField("timestamp", -1))
      .slice(0, limit);
  },
};

export const reportsRepo = {
  async add(record, opts) { await ready(); return insert("reports", buildReport(record)); },
  async getById(id, opts) { await ready(); return getOne("reports", id); },
  async getAll({ type, astronautId } = {}, opts) {
    await ready();
    return all("reports")
      .filter((r) => (!type || r.type === type) && (!astronautId || r.astronautId === astronautId))
      .sort(byField("createdAt", -1));
  },
};

export const settingsRepo = {
  async get(key, opts) { await ready(); return data.settings.get(key)?.value ?? null; },
  async set(key, value, userId = SYSTEM_USER, opts) {
    await ready();
    return put("settings", { key, value, updatedAt: Date.now(), updatedBy: userId || SYSTEM_USER });
  },
  async getAll(opts) {
    await ready();
    return Object.fromEntries(all("settings").map((s) => [s.key, s.value]));
  },
};

export const metaRepo = {
  async get(key, opts) { await ready(); return clone(data.meta.get(key)?.value ?? null); },
  async set(key, value, opts) { await ready(); put("meta", { key, value }); return value; },
};
