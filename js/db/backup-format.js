// js/db/backup-format.js
// The backup file format and its validation. Pure module (works in Node) —
// js/db/backup.js uses it before touching the database, so an invalid file
// is rejected BEFORE anything is deleted or written.
//
// A backup must pass every check that a normal write would: valid primary
// keys, indexable fields (no boolean/null/undefined/NaN), documented enum
// values, the user role ↔ astronautId rule — plus no duplicate primary keys
// and no duplicate values in unique indexes.

import { DB_VERSION } from "../core/config.js";
import { DatabaseError } from "./errors.js";
import { SCHEMA, STORE_NAMES } from "./schema.js";
import { findRecordProblems } from "./records.js";

export const BACKUP_APP_NAME = "AstroHealth AI";

/** Throw INCOMPATIBLE_BACKUP with a clear reason. */
function reject(reason) {
  throw new DatabaseError(`This backup can't be imported: ${reason}`, { code: "INCOMPATIBLE_BACKUP", operation: "import" });
}

/** The unique indexes of a store as [indexName, field]. */
function uniqueIndexes(storeName) {
  return SCHEMA[storeName].indexes.filter(([, , options]) => options?.unique).map(([name, keyPath]) => [name, keyPath]);
}

/**
 * Parse (if needed) and check a backup file.
 * @param {object|string} json  the backup object or its JSON text
 * @returns {{ file: object, stores: Record<string, object[]> }} a store map with every store present
 * @throws {DatabaseError} code INCOMPATIBLE_BACKUP with the first problem found
 */
export function validateBackup(json) {
  let file = json;
  if (typeof json === "string") {
    try {
      file = JSON.parse(json);
    } catch (err) {
      reject(`it is not valid JSON (${err.message})`);
    }
  }
  if (!file || typeof file !== "object" || Array.isArray(file)) reject("expected a JSON object");
  if (file.app !== BACKUP_APP_NAME) reject(`it was not made by ${BACKUP_APP_NAME} (app = ${JSON.stringify(file.app)})`);
  if (file.schemaVersion !== DB_VERSION) {
    reject(`it uses schema version ${JSON.stringify(file.schemaVersion)}, but this app uses version ${DB_VERSION}`);
  }
  if (!file.stores || typeof file.stores !== "object" || Array.isArray(file.stores)) reject('the "stores" object is missing');

  const unknown = Object.keys(file.stores).filter((name) => !STORE_NAMES.includes(name));
  if (unknown.length) reject(`unknown store(s): ${unknown.join(", ")}`);

  const stores = {};
  for (const name of STORE_NAMES) {
    const records = file.stores[name] ?? []; // a missing store imports as empty
    if (!Array.isArray(records)) reject(`"${name}" must be an array`);

    const keyPath = SCHEMA[name].keyPath;
    const seenKeys = new Set();
    const seenUnique = Object.fromEntries(uniqueIndexes(name).map(([index]) => [index, new Set()]));

    records.forEach((record, i) => {
      if (!record || typeof record !== "object" || Array.isArray(record)) reject(`record #${i} in "${name}" is not an object`);
      const problems = findRecordProblems(name, record);
      if (problems.length) reject(`record #${i} in "${name}": ${problems[0]}`);

      const key = record[keyPath];
      if (seenKeys.has(key)) reject(`duplicate ${keyPath} ${JSON.stringify(key)} in "${name}"`);
      seenKeys.add(key);

      for (const [index, field] of uniqueIndexes(name)) {
        if (seenUnique[index].has(record[field])) reject(`duplicate ${field} ${JSON.stringify(record[field])} in "${name}"`);
        seenUnique[index].add(record[field]);
      }
    });
    stores[name] = records;
  }
  return { file, stores };
}
