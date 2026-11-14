// js/db/errors.js
// The ONE error type the database layer throws. Pure module (works in Node).
//
//   try { … } catch (err) {
//     if (err instanceof DatabaseError && err.code === "NOT_FOUND") { … }
//     console.error(err.message, err.cause);   // cause = original browser error
//   }
//
// Error codes are listed in docs/DATA-MODEL.md (section 6).

export class DatabaseError extends Error {
  /**
   * @param {string} message  clear, human-readable explanation
   * @param {object} [details]
   * @param {string} [details.code]       e.g. "NOT_FOUND", "INVALID", "QUOTA"
   * @param {unknown} [details.cause]     the original error, if any
   * @param {string} [details.store]      store involved, if known
   * @param {string} [details.operation]  e.g. "add", "update", "open"
   */
  constructor(message, { code = "UNKNOWN", cause, store = "", operation = "" } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DatabaseError";
    this.code = code;
    this.store = store;
    this.operation = operation;
    // Older browsers ignore the `cause` option — set it ourselves.
    if (cause !== undefined && this.cause === undefined) this.cause = cause;
  }
}

// Browser error names (DOMException.name) → our codes + a friendlier hint.
const KNOWN = {
  ConstraintError: ["CONSTRAINT", "a record with the same unique key already exists"],
  QuotaExceededError: ["QUOTA", "device storage is full — compact or delete data"],
  VersionError: ["VERSION", "this device has a newer database than this app — reload or update the app"],
  TransactionInactiveError: [
    "TRANSACTION_INACTIVE",
    "the transaction already finished — inside withTransaction() only await database calls",
  ],
  InvalidStateError: ["INVALID_STATE", "the database connection is closed or busy"],
  NotFoundError: ["NOT_FOUND", "the store or index does not exist in this transaction"],
  DataError: ["INVALID", "a key or indexed value is not a valid IndexedDB key"],
  DataCloneError: ["INVALID", "the value can't be stored (functions, DOM nodes and class instances are not allowed)"],
  AbortError: ["ABORTED", "the transaction was aborted and rolled back"],
  UnknownError: ["UNKNOWN", "the browser reported an internal storage error"],
};

/**
 * Turn any thrown value into a DatabaseError (returns it unchanged if it
 * already is one). `message` describes what we were trying to do.
 */
export function toDatabaseError(err, message, details = {}) {
  if (err instanceof DatabaseError) return err;
  const name = err && typeof err === "object" ? err.name : "";
  const [code, hint] = KNOWN[name] || [details.code || "UNKNOWN", ""];
  const original = err && err.message ? err.message : String(err);
  const text = `${message}${hint ? ` (${hint})` : ""}: ${original}`;
  // A known browser error name wins; otherwise use the caller's code.
  return new DatabaseError(text, { ...details, code, cause: err });
}
