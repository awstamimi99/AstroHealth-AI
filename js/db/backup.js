// js/db/backup.js
// Export / import / reset the whole database.
//
//   const file = await exportAll();                 // plain object
//   const text = JSON.stringify(file);              // UI saves it as a file
//   await importAll(text);                          // replaces EVERYTHING
//   await resetDatabase({ userId });                // back to fresh demo data
//
// ⚠️ A backup contains EVERYTHING — password hashes/salts (demo only) and the
// private journal. Treat backup files as private.

import { DB_VERSION } from "../core/config.js";
import { withTransaction, requestToPromise } from "./database.js";
import { STORE_NAMES } from "./schema.js";
import { buildEvent } from "./records.js";
import { prepareSeedData, writeSeedData } from "./seed.js";
import { CREW, SYSTEM_USER } from "./constants.js";
import { BACKUP_APP_NAME, validateBackup } from "./backup-format.js";

// The file format + validation live in backup-format.js (pure, Node-testable).
export { BACKUP_APP_NAME, validateBackup };

/**
 * Read every store in ONE read-only transaction (a consistent snapshot).
 * @returns {Promise<import("./types.js").BackupFile>}
 */
export async function exportAll() {
  const stores = await withTransaction(STORE_NAMES, "readonly", async (tx, s) => {
    const lists = await Promise.all(STORE_NAMES.map((name) => requestToPromise(s[name].getAll())));
    return Object.fromEntries(STORE_NAMES.map((name, i) => [name, lists[i]]));
  });
  return { app: BACKUP_APP_NAME, schemaVersion: DB_VERSION, exportedAt: Date.now(), stores };
}

/**
 * Replace ALL data with the backup, in one transaction (all or nothing),
 * then log a `data_imported` event. The file is fully validated FIRST
 * (validateBackup) — an invalid file never deletes or writes anything.
 * @param {object|string} json  the backup object or its JSON text
 * @param {{ userId?: string }} [options]
 */
export async function importAll(json, { userId = SYSTEM_USER } = {}) {
  const { file, stores } = validateBackup(json);
  const exportedAt = Number.isFinite(file.exportedAt) ? file.exportedAt : 0;
  const counts = Object.fromEntries(STORE_NAMES.map((name) => [name, stores[name].length]));
  const event = buildEvent({
    type: "data_imported",
    astronautId: CREW,
    actorUserId: userId,
    summary: "Data imported from a backup file",
    data: { exportedAt, records: Object.values(counts).reduce((a, b) => a + b, 0) },
  });

  await withTransaction(STORE_NAMES, "readwrite", async (tx, s) => {
    await Promise.all(STORE_NAMES.map((name) => requestToPromise(s[name].clear())));
    const writes = [];
    for (const name of STORE_NAMES) {
      for (const record of stores[name]) writes.push(requestToPromise(s[name].put(record)));
    }
    await Promise.all(writes);
    await requestToPromise(s.missionEvents.add(event));
  });
  return { counts };
}

/**
 * Delete all data and load fresh demo data — one transaction, so a crash
 * can never leave an empty database. Logs a `data_reset` event.
 * @param {{ userId?: string, now?: number }} [options]
 */
export async function resetDatabase({ userId = SYSTEM_USER, now = Date.now() } = {}) {
  const data = await prepareSeedData({ now }); // hashing BEFORE the transaction
  const event = buildEvent({
    type: "data_reset",
    timestamp: now,
    astronautId: CREW,
    actorUserId: userId,
    summary: "All data reset to the demo data set",
  });

  const counts = await withTransaction(STORE_NAMES, "readwrite", async (tx, s) => {
    await Promise.all(STORE_NAMES.map((name) => requestToPromise(s[name].clear())));
    const written = await writeSeedData(s, data);
    await requestToPromise(s.missionEvents.add(event));
    return { ...written, missionEvents: written.missionEvents + 1 };
  });
  return { counts };
}
