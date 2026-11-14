// js/db/index.js
// THE single import point for the database layer (Team 1 imports from here):
//
//   import { alertsRepo, measurementsRepo, withTransaction, DatabaseError } from "../db/index.js";
//
// Contract & full API: docs/DATA-MODEL.md

// Connection & transactions
export {
  openDatabase,
  closeDatabase,
  deleteDatabase,
  withTransaction,
  requestPersistentStorage,
  requestToPromise,
  useDatabaseName,
  getDatabaseName,
} from "./database.js";

// Errors, ids, constants, schema
export { DatabaseError } from "./errors.js";
export { newId, nextAlertNumber, formatAlertNumber, parseAlertNumber } from "./ids.js";
export * from "./constants.js";
export { SCHEMA, STORE_NAMES, MIGRATIONS } from "./schema.js";
export { toDateKey, dateKeyToStart, startOfUtcDay, summarize } from "./summaries.js";

// Repositories (one per store)
export { usersRepo } from "./repositories/users.js";
export { astronautsRepo } from "./repositories/astronauts.js";
export { measurementsRepo, MEASUREMENT_WRITE_STORES } from "./repositories/measurements.js";
export { dailySummariesRepo } from "./repositories/daily-summaries.js";
export { wellbeingRepo } from "./repositories/wellbeing.js";
export { journalRepo } from "./repositories/journal.js";
export { cognitiveRepo } from "./repositories/cognitive.js";
export { simulationRunsRepo } from "./repositories/simulation-runs.js";
export { alertsRepo } from "./repositories/alerts.js";
export { alertActionsRepo } from "./repositories/alert-actions.js";
export { messagesRepo } from "./repositories/messages.js";
export { eventsRepo } from "./repositories/events.js";
export { reportsRepo } from "./repositories/reports.js";
export { settingsRepo } from "./repositories/settings.js";
export { metaRepo } from "./repositories/meta.js";

// Seed, backup, maintenance
export { seedDemoData, SEED_VERSION, DEMO_PASSWORD } from "./seed.js";
export { exportAll, importAll, resetDatabase, validateBackup, BACKUP_APP_NAME } from "./backup.js";
export { compactMeasurements, getStorageInfo } from "./maintenance.js";
