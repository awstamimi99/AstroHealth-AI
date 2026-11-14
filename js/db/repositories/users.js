// js/db/repositories/users.js — store "users"
// ⚠️ Demo authentication only (see js/db/password.js). Getters NEVER return
// passwordHash / salt. add/update/verifyPassword don't accept { tx }:
// hashing is async and would end a transaction early.

import { run, requestToPromise } from "../database.js";
import { DatabaseError } from "../errors.js";
import { buildUser, mergeChanges, normalizeUsername, toSafeUser } from "../records.js";
import { hashPassword, checkPassword } from "../password.js";
import { getOne } from "./_common.js";

const STORE = "users";

export const usersRepo = {
  /** @returns {Promise<import("../types.js").SafeUser|null>} */
  async getById(id, opts) {
    return run([STORE], "readonly", opts, async (tx, s) => toSafeUser(await getOne(s.users, id)));
  },

  /** Case-insensitive. @returns {Promise<import("../types.js").SafeUser|null>} */
  async getByUsername(username, opts) {
    return run([STORE], "readonly", opts, async (tx, s) =>
      toSafeUser(await getOne(s.users.index("username"), normalizeUsername(username)))
    );
  },

  /** All users, sorted by username. @returns {Promise<import("../types.js").SafeUser[]>} */
  async getAll(opts) {
    return run([STORE], "readonly", opts, async (tx, s) =>
      (await requestToPromise(s.users.index("username").getAll())).map(toSafeUser)
    );
  },

  /**
   * Create a user. Pass the plain `password`; only its hash is stored.
   * @param {{ username: string, displayName: string, role: string, astronautId?: string, password: string, createdBy?: string }} input
   */
  async add(input) {
    const { password, ...rest } = input || {};
    if (!password) throw new DatabaseError("users: a password is required", { code: "INVALID", store: STORE });
    const secret = await hashPassword(password); // BEFORE the transaction
    const user = { ...buildUser(rest), ...secret };
    await run([STORE], "readwrite", null, async (tx, s) => requestToPromise(s.users.add(user)));
    return toSafeUser(user);
  },

  /** Update fields; `changes.password` re-hashes the password. */
  async update(id, changes = {}) {
    const { password, passwordHash, salt, ...rest } = changes;
    if (rest.username !== undefined) rest.username = normalizeUsername(rest.username);
    const secret = password ? await hashPassword(password) : {};
    const updated = await run([STORE], "readwrite", null, async (tx, s) => {
      const existing = await getOne(s.users, id);
      if (!existing) throw new DatabaseError(`users: no record with id "${id}"`, { code: "NOT_FOUND", store: STORE });
      const record = { ...mergeChanges(STORE, existing, rest), ...secret };
      await requestToPromise(s.users.put(record));
      return record;
    });
    return toSafeUser(updated);
  },

  /**
   * Check a username + password.
   * @returns {Promise<import("../types.js").SafeUser|null>} the user, or null if wrong
   */
  async verifyPassword(username, password) {
    const user = await run([STORE], "readonly", null, async (tx, s) =>
      getOne(s.users.index("username"), normalizeUsername(username))
    );
    if (!user) return null;
    return (await checkPassword(password, user.passwordHash, user.salt)) ? toSafeUser(user) : null;
  },
};
