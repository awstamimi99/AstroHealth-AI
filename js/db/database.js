// js/db/database.js
// Opens the IndexedDB database, runs migrations, and provides
// withTransaction() — the one way to do several writes all-or-nothing.
// Browser only.
//
//   const db = await openDatabase();
//   await withTransaction(["alerts", "alertActions"], "readwrite", async (tx, stores) => {
//     await alertsRepo.update(id, { status: "acknowledged" }, { tx });
//     await alertActionsRepo.add({ alertId: id, action: "acknowledged" }, { tx });
//   });   // if anything throws, NOTHING is saved
//
// ⚠️ Inside withTransaction() only `await` database calls. Awaiting anything
// else (fetch, timers, crypto.subtle, prompts) lets the browser commit the
// transaction early and the next call fails with TRANSACTION_INACTIVE.

import { DB_NAME, DB_VERSION } from "../core/config.js";
import { bus } from "../core/event-bus.js";
import { DatabaseError, toDatabaseError } from "./errors.js";
import { runMigrations } from "./schema.js";

let databaseName = DB_NAME;
/** @type {Promise<IDBDatabase> | null} cached connection (singleton) */
let dbPromise = null;

// ---- Small IndexedDB helpers ---------------------------------------------

/** Wrap an IDBRequest in a Promise that resolves with its result. */
export function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Key range for "every compound key that starts with these parts".
 * prefixRange("a-01") on [astronautId, status] matches ["a-01", anything].
 * Trick: an empty array sorts after every string and number.
 */
export function prefixRange(...parts) {
  return IDBKeyRange.bound(parts, [...parts, []]);
}

/**
 * Walk a store/index with a cursor and collect values.
 * @param {IDBObjectStore|IDBIndex} source
 * @param {IDBKeyRange|null} range
 * @param {object} [options]
 * @param {"next"|"prev"} [options.direction]  "prev" = highest key first
 * @param {number} [options.limit]             stop after this many
 */
export function collect(source, range, { direction = "next", limit = Infinity } = {}) {
  return new Promise((resolve, reject) => {
    const results = [];
    const request = source.openCursor(range, direction);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || results.length >= limit) return resolve(results);
      results.push(cursor.value);
      cursor.continue();
    };
  });
}

// ---- Opening & closing ----------------------------------------------------

/**
 * Open (and if needed create/upgrade) the database. Cached: every call
 * returns the same connection.
 * @returns {Promise<IDBDatabase>}
 */
export function openDatabase() {
  if (dbPromise) return dbPromise;

  if (typeof indexedDB === "undefined") {
    return Promise.reject(
      new DatabaseError("IndexedDB is not available in this browser (or it is disabled, e.g. in some private modes).", {
        code: "UNSUPPORTED",
        operation: "open",
      })
    );
  }

  const name = databaseName;
  const opening = new Promise((resolve, reject) => {
    let upgradeError = null;
    let request;
    try {
      request = indexedDB.open(name, DB_VERSION);
    } catch (err) {
      reject(toDatabaseError(err, `Could not open database "${name}"`, { code: "OPEN_FAILED", operation: "open" }));
      return;
    }

    // First visit or new DB_VERSION: create/alter stores.
    request.onupgradeneeded = (event) => {
      try {
        runMigrations(request.result, request.transaction, event.oldVersion, event.newVersion ?? DB_VERSION);
      } catch (err) {
        upgradeError = err;
        request.transaction.abort(); // nothing half-migrated is kept
      }
    };

    // Another tab still has the old version open and didn't close it.
    request.onblocked = () => {
      console.warn("[db] upgrade blocked — close other AstroHealth tabs to continue.");
      bus.emit("db:blocked", { name, version: DB_VERSION }, { local: true });
    };

    request.onsuccess = () => {
      const db = request.result;
      // A newer version was opened in another tab: let it upgrade.
      db.onversionchange = () => {
        db.close();
        if (dbPromise === opening) dbPromise = null;
        bus.emit("db:versionchange", { name }, { local: true });
      };
      // The browser closed the connection (e.g. storage cleared).
      db.onclose = () => {
        if (dbPromise === opening) dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      const cause = upgradeError || request.error;
      reject(
        toDatabaseError(cause, `Could not open database "${name}" (version ${DB_VERSION})`, {
          code: "OPEN_FAILED",
          operation: "open",
        })
      );
    };
  });

  dbPromise = opening;
  // If opening fails, forget the promise so the next call can retry.
  opening.catch(() => {
    if (dbPromise === opening) dbPromise = null;
  });
  return opening;
}

/** Close the connection (a later call to openDatabase() reopens it). */
export async function closeDatabase() {
  if (!dbPromise) return;
  const pending = dbPromise;
  dbPromise = null;
  try {
    (await pending).close();
  } catch {
    /* it never opened — nothing to close */
  }
}

/** Delete the whole database (tests, "factory reset"). */
export async function deleteDatabase() {
  await closeDatabase();
  const name = databaseName;
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(toDatabaseError(request.error, `Could not delete database "${name}"`, { operation: "delete" }));
    request.onblocked = () =>
      console.warn("[db] delete is waiting for other tabs to close the database…");
  });
}

/**
 * TESTS ONLY: use a different database name (e.g. "astrohealth-test") so
 * tests never touch the real demo data. Closes the current connection.
 */
export async function useDatabaseName(name) {
  await closeDatabase();
  databaseName = name || DB_NAME;
}

/** Name of the database currently in use. */
export function getDatabaseName() {
  return databaseName;
}

/**
 * Ask the browser to keep our data even when storage runs low.
 * @returns {Promise<boolean>} true if storage is (now) persistent
 */
export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

// ---- Transactions -----------------------------------------------------------

/** Turn a list of store names into { name: IDBObjectStore } for a transaction. */
function storesOf(tx, names) {
  const stores = {};
  for (const name of names) {
    try {
      stores[name] = tx.objectStore(name);
    } catch (err) {
      // InvalidStateError = the transaction already finished (auto-committed).
      if (err?.name === "InvalidStateError") {
        throw new DatabaseError(
          "The transaction already finished — inside withTransaction() only await database calls " +
            "(do fetch/timers/crypto before starting the transaction)",
          { code: "TRANSACTION_INACTIVE", store: name, cause: err }
        );
      }
      throw new DatabaseError(
        `This transaction does not include the "${name}" store — add it to withTransaction([...])`,
        { code: "INVALID", store: name, cause: err }
      );
    }
  }
  return stores;
}

/**
 * Run `work` inside ONE transaction. All writes succeed together, or —
 * if `work` throws or any request fails — none are saved.
 *
 * @template T
 * @param {string|string[]} storeNames  stores the work will use
 * @param {"readonly"|"readwrite"} mode
 * @param {(tx: IDBTransaction, stores: Record<string, IDBObjectStore>) => Promise<T>} work
 * @returns {Promise<T>} whatever `work` returns, after the transaction COMMITTED
 */
export async function withTransaction(storeNames, mode, work) {
  const names = [].concat(storeNames);
  const db = await openDatabase();

  let tx;
  try {
    tx = db.transaction(names, mode);
  } catch (err) {
    throw toDatabaseError(err, `Could not start a ${mode} transaction on [${names.join(", ")}]`, {
      operation: "transaction",
    });
  }

  // Resolves when the browser has committed everything.
  const committed = new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    // A failed request aborts the whole transaction (browser default) —
    // we deliberately do NOT call preventDefault(), so nothing half-done is kept.
    tx.onabort = () => reject(tx.error || new DOMException("Transaction aborted", "AbortError"));
  });

  let result;
  try {
    result = await work(tx, storesOf(tx, names));
  } catch (err) {
    try {
      tx.abort(); // roll back everything done so far
    } catch {
      /* already finished or aborted */
    }
    committed.catch(() => {}); // the abort is expected — don't warn about it
    if (err instanceof DatabaseError) throw err;
    throw toDatabaseError(err, "Transaction rolled back", { code: "TRANSACTION_FAILED", operation: "transaction" });
  }

  try {
    await committed;
  } catch (err) {
    throw toDatabaseError(err, `Transaction on [${names.join(", ")}] failed and was rolled back`, {
      code: "TRANSACTION_FAILED",
      operation: "transaction",
    });
  }
  return result;
}

/**
 * Used by repositories: run `work` in the caller's transaction if they
 * passed `{ tx }`, otherwise in a new one.
 * @param {string[]} storeNames
 * @param {"readonly"|"readwrite"} mode
 * @param {{ tx?: IDBTransaction }} [opts]
 * @param {(tx: IDBTransaction, stores: Record<string, IDBObjectStore>) => Promise<any>} work
 */
export async function run(storeNames, mode, opts, work) {
  const tx = opts?.tx;
  if (!tx) return withTransaction(storeNames, mode, work);

  if (mode === "readwrite" && tx.mode === "readonly") {
    throw new DatabaseError(`This call writes to [${storeNames.join(", ")}] but the transaction is readonly`, {
      code: "INVALID",
      operation: "transaction",
    });
  }
  try {
    return await work(tx, storesOf(tx, storeNames));
  } catch (err) {
    throw toDatabaseError(err, `Database ${mode} on [${storeNames.join(", ")}] failed`, { operation: mode });
  }
}
