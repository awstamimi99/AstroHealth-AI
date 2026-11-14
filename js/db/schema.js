// js/db/schema.js
// Store and index definitions + migrations. Pure module (works in Node).
//
// GOLDEN RULE: never edit a past version. Devices that already ran
// MIGRATIONS[1] will never run it again, so changing it would leave them
// with a different database than new devices. Any change =
//   1. bump DB_VERSION in js/core/config.js (shared file),
//   2. add MIGRATIONS[2] = (db, tx) => { …create/alter… },
//   3. update SCHEMA below to describe the NEW latest shape,
//   4. update docs/DATA-MODEL.md.

import { DatabaseError } from "./errors.js";

/**
 * Version 1 of the schema — FROZEN.
 * Each store: keyPath + list of indexes [name, keyPath, options].
 * Compound indexes use an array keyPath, e.g. ["astronautId", "timestamp"].
 */
const SCHEMA_V1 = Object.freeze({
  users: {
    keyPath: "id",
    indexes: [["username", "username", { unique: true }]],
  },
  astronauts: {
    keyPath: "id",
    indexes: [["crewId", "crewId", { unique: true }]],
  },
  measurements: {
    keyPath: "id",
    indexes: [
      ["by_astronaut_metric_time", ["astronautId", "metric", "timestamp"]],
      ["by_astronaut_time", ["astronautId", "timestamp"]],
      ["by_time", "timestamp"],
      ["by_sample", "sampleId"],
    ],
  },
  dailySummaries: {
    keyPath: "id",
    indexes: [["by_astronaut_metric_date", ["astronautId", "metric", "date"]]],
  },
  wellbeingAssessments: {
    keyPath: "id",
    indexes: [
      ["by_astronaut_time", ["astronautId", "timestamp"]],
      ["by_shared_time", ["sharedWithMedical", "timestamp"]],
    ],
  },
  privateJournal: {
    keyPath: "id",
    indexes: [["by_astronaut_time", ["astronautId", "timestamp"]]],
  },
  cognitiveChecks: {
    keyPath: "id",
    indexes: [["by_astronaut_time", ["astronautId", "timestamp"]]],
  },
  simulationRuns: {
    keyPath: "id",
    indexes: [
      ["by_astronaut", "astronautId"],
      ["by_started", "startedAt"],
      ["by_status", "status"],
    ],
  },
  alerts: {
    keyPath: "id",
    indexes: [
      ["by_number", "number", { unique: true }],
      ["by_astronaut_status", ["astronautId", "status"]],
      ["by_status", "status"],
      ["by_severity", "severity"],
      ["by_detected", "detectedAt"],
      ["by_dedupe_status", ["dedupeKey", "status"]],
    ],
  },
  alertActions: {
    keyPath: "id",
    indexes: [
      ["by_alert", "alertId"],
      ["by_time", "timestamp"],
    ],
  },
  messages: {
    keyPath: "id",
    indexes: [
      ["by_astronaut_time", ["astronautId", "sentAt"]],
      ["by_alert", "relatedAlertId"],
    ],
  },
  missionEvents: {
    keyPath: "id",
    indexes: [
      ["by_time", "timestamp"],
      ["by_astronaut_time", ["astronautId", "timestamp"]],
      ["by_type_time", ["type", "timestamp"]],
    ],
  },
  reports: {
    keyPath: "id",
    indexes: [
      ["by_type_created", ["type", "createdAt"]],
      ["by_astronaut", "astronautId"],
    ],
  },
  settings: { keyPath: "key", indexes: [] },
  meta: { keyPath: "key", indexes: [] },
});

/** Describes the LATEST schema (today: version 1). Used for checks & docs. */
export const SCHEMA = SCHEMA_V1;

/** All store names, in a stable order. */
export const STORE_NAMES = Object.freeze(Object.keys(SCHEMA));

/**
 * Upgrade steps. MIGRATIONS[n] turns a version n−1 database into version n.
 * They run inside the "versionchange" transaction (`tx`), so they can read
 * and rewrite existing data with tx.objectStore(...).
 */
export const MIGRATIONS = Object.freeze({
  1: (db, tx) => {
    for (const [name, def] of Object.entries(SCHEMA_V1)) {
      const store = db.createObjectStore(name, { keyPath: def.keyPath });
      for (const [indexName, keyPath, options] of def.indexes) {
        store.createIndex(indexName, keyPath, options || {});
      }
    }
    tx.objectStore("meta").put({ key: "schemaVersion", value: 1 });
  },
});

/**
 * Run every migration from oldVersion+1 up to newVersion.
 * Called by database.js inside onupgradeneeded.
 */
export function runMigrations(db, tx, oldVersion, newVersion) {
  for (let v = oldVersion + 1; v <= newVersion; v++) {
    const step = MIGRATIONS[v];
    if (!step) {
      throw new DatabaseError(`No migration defined for schema version ${v}`, { code: "VERSION" });
    }
    step(db, tx);
    if (v > 1) tx.objectStore("meta").put({ key: "schemaVersion", value: v });
  }
}

// ---- Index safety checks -------------------------------------------------

/** Is this a value IndexedDB can use as a key? (booleans/null/NaN are NOT) */
function isValidKeyPart(value) {
  if (typeof value === "string") return true;
  if (typeof value === "number") return !Number.isNaN(value);
  return false;
}

/**
 * List problems that would make `record` invisible in an index (or fail as a
 * primary key) in `storeName`. Empty array = fine.
 */
export function findIndexProblems(storeName, record) {
  const def = SCHEMA[storeName];
  if (!def) return [`unknown store "${storeName}"`];
  if (!record || typeof record !== "object") return ["record must be an object"];

  // field → where it is used (primary key and/or index names)
  const usedBy = new Map([[def.keyPath, ["the primary key"]]]);
  for (const [indexName, keyPath] of def.indexes) {
    for (const field of [].concat(keyPath)) {
      usedBy.set(field, [...(usedBy.get(field) || []), `index "${indexName}"`]);
    }
  }

  const problems = [];
  for (const [field, where] of usedBy) {
    const value = record[field];
    if (!isValidKeyPart(value)) {
      const shown = value === undefined ? "missing" : JSON.stringify(value);
      problems.push(`"${field}" is ${shown} — ${where.join(" and ")} need a string or number (store flags as 0/1)`);
    }
  }
  return problems;
}

/** Throw a DatabaseError (code INVALID) if the record can't be indexed. */
export function assertIndexable(storeName, record) {
  const problems = findIndexProblems(storeName, record);
  if (problems.length) {
    throw new DatabaseError(`Cannot store record in "${storeName}": ${problems.join("; ")}`, {
      code: "INVALID",
      store: storeName,
    });
  }
  return record;
}
