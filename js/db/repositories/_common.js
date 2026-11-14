// js/db/repositories/_common.js
// Tiny helpers shared by the repositories (not exported from index.js).

import { DatabaseError } from "../errors.js";
import { requestToPromise } from "../database.js";
import { mergeChanges } from "../records.js";

/** store.get(key) → record or null (never undefined). */
export async function getOne(source, key) {
  const value = await requestToPromise(source.get(key));
  return value ?? null;
}

/**
 * Read → shallow-merge → write, for update(id, changes).
 * Throws NOT_FOUND if the record doesn't exist.
 */
export async function updateIn(store, storeName, id, changes, now = Date.now()) {
  const existing = await getOne(store, id);
  if (!existing) {
    throw new DatabaseError(`${storeName}: no record with id "${id}"`, {
      code: "NOT_FOUND",
      store: storeName,
      operation: "update",
    });
  }
  const updated = mergeChanges(storeName, existing, changes, now);
  await requestToPromise(store.put(updated));
  return updated;
}

/** Equal times are ordered by id (ascending), so results are always deterministic. */
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Sort helpers (return the same array, sorted in place). */
export const oldestFirst = (list, field = "timestamp") => list.sort((a, b) => a[field] - b[field] || byId(a, b));
export const newestFirst = (list, field = "timestamp") => list.sort((a, b) => b[field] - a[field] || byId(a, b));

/** Accept "x" or ["x", "y"] or undefined → array or null. */
export const asList = (value) => (value === undefined || value === null ? null : [].concat(value));

/** Default time bounds: everything. ±Infinity are valid IndexedDB keys. */
export const MIN_TS = -Infinity;
export const MAX_TS = Infinity;
