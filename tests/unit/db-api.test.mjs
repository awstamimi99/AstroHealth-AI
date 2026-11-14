// Frozen Database API checks — run with: npm run test:unit
// Covers: migrations, storage rules, backup validation, mock behaviour,
// mock ↔ real API parity, and encapsulation (nothing outside js/db may reach
// into database internals).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// js/db/index.js pulls in the event bus, which expects a browser. Nothing
// touches IndexedDB at import time, so two tiny stand-ins are enough.
globalThis.self = globalThis;
globalThis.BroadcastChannel = class { postMessage() {} addEventListener() {} close() {} };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const real = await import("../../js/db/index.js");
const mock = await import("../../js/db/mock-repositories.js");
const { SCHEMA, STORE_NAMES, MIGRATIONS, runMigrations } = await import("../../js/db/schema.js");
const { findRecordProblems, mergeChanges, ENUM_FIELDS, toSafeUser } = await import("../../js/db/records.js");
const { validateBackup, BACKUP_APP_NAME } = await import("../../js/db/backup-format.js");
const { buildSeedData } = await import("../../js/db/seed-data.js");
const { DB_NAME, DB_VERSION } = await import("../../js/core/config.js");
const { DatabaseError, ROLES, METRICS, METRIC_UNITS } = real;

const NOW = Date.UTC(2026, 10, 14, 15, 37, 0);
const isCode = (code) => (err) => err instanceof DatabaseError && err.code === code;

// ---- Contract constants -----------------------------------------------------

test("contract: database name, version, roles", () => {
  assert.equal(DB_NAME, "astrohealth");
  assert.equal(DB_VERSION, 1);
  assert.deepEqual({ ...ROLES }, { ASTRONAUT: "astronaut", MEDICAL_OFFICER: "medical_officer" });
  for (const metric of METRICS) assert.ok(METRIC_UNITS[metric], metric);
  assert.equal(STORE_NAMES.length, 15);
});

// ---- Migrations (fake IndexedDB objects record what gets created) -------------

function fakeUpgradeTarget() {
  const stores = {};
  const meta = new Map();
  const db = {
    createObjectStore(name, { keyPath }) {
      const store = { keyPath, indexes: {}, createIndex(i, kp, opts) { this.indexes[i] = { keyPath: kp, unique: Boolean(opts?.unique) }; } };
      stores[name] = store;
      return store;
    },
  };
  const tx = { objectStore: (name) => (name === "meta" ? { put: (row) => meta.set(row.key, row.value) } : stores[name]) };
  return { db, tx, stores, meta };
}

test("migration 0 → 1 creates all 15 stores, every index, unique flags and meta.schemaVersion", () => {
  const { db, tx, stores, meta } = fakeUpgradeTarget();
  runMigrations(db, tx, 0, 1);
  assert.deepEqual(Object.keys(stores), STORE_NAMES);
  for (const [name, def] of Object.entries(SCHEMA)) {
    assert.equal(stores[name].keyPath, def.keyPath, `${name} keyPath`);
    assert.deepEqual(Object.keys(stores[name].indexes), def.indexes.map((i) => i[0]), `${name} indexes`);
  }
  const unique = Object.entries(stores).flatMap(([n, s]) => Object.entries(s.indexes).filter(([, i]) => i.unique).map(([i]) => `${n}.${i}`));
  assert.deepEqual(unique.sort(), ["alerts.by_number", "astronauts.crewId", "users.username"]);
  assert.equal(meta.get("schemaVersion"), 1);
});

test("a missing migration fails clearly with code VERSION", () => {
  const { db, tx } = fakeUpgradeTarget();
  assert.equal(MIGRATIONS[2], undefined);
  assert.throws(() => runMigrations(db, tx, 1, 2), isCode("VERSION"));
});

// ---- Storage rules ----------------------------------------------------------------

test("every seed record passes all storage rules", () => {
  const data = buildSeedData({ now: NOW });
  for (const name of STORE_NAMES) {
    for (const record of data[name]) assert.deepEqual(findRecordProblems(name, record), [], `${name} ${record.id ?? record.key}`);
  }
});

test("enum fields reject undocumented values", () => {
  const data = buildSeedData({ now: NOW });
  const alert = data.alerts[0];
  assert.equal(findRecordProblems("alerts", { ...alert, status: "Acknowledged" }).length, 1);
  assert.equal(findRecordProblems("alerts", { ...alert, severity: "high" }).length, 1);
  assert.equal(findRecordProblems("missionEvents", { ...data.missionEvents[0], type: "made_up" }).length, 1);
  assert.equal(findRecordProblems("measurements", { ...data.measurements[0], quality: "bad" }).length, 1);
  assert.ok(Object.keys(ENUM_FIELDS).every((store) => STORE_NAMES.includes(store)));
});

test("users: exact roles and the role ↔ astronautId rule", () => {
  const base = { id: "u", username: "u", displayName: "U", createdAt: 1, updatedAt: 1, createdBy: "system" };
  assert.deepEqual(findRecordProblems("users", { ...base, role: "astronaut", astronautId: "a-01" }), []);
  assert.deepEqual(findRecordProblems("users", { ...base, role: "medical_officer", astronautId: "" }), []);
  assert.ok(findRecordProblems("users", { ...base, role: "medical-officer", astronautId: "" }).length);
  assert.ok(findRecordProblems("users", { ...base, role: "astronaut", astronautId: "" }).length);
  assert.ok(findRecordProblems("users", { ...base, role: "medical_officer", astronautId: "a-01" }).length);
});

test("immutable identifiers can't change on update (same value is fine)", () => {
  const a = buildSeedData({ now: NOW }).astronauts[0];
  assert.throws(() => mergeChanges("astronauts", a, { crewId: "AH-99" }), isCode("INVALID"));
  assert.equal(mergeChanges("astronauts", a, { crewId: a.crewId, age: 42 }).age, 42);
  const alert = buildSeedData({ now: NOW }).alerts[0];
  assert.throws(() => mergeChanges("alerts", alert, { number: "ALT-9999" }), isCode("INVALID"));
});

test("safe users never contain password material", () => {
  assert.deepEqual(toSafeUser({ id: "u", password: "p", passwordHash: "h", salt: "s", role: "astronaut" }), { id: "u", role: "astronaut" });
});

// ---- Backup validation -------------------------------------------------------------

const backupOf = (mutate = (s) => s) => {
  const stores = buildSeedData({ now: NOW });
  return { app: BACKUP_APP_NAME, schemaVersion: DB_VERSION, exportedAt: NOW, stores: mutate(stores) };
};

test("a well-formed backup validates, as an object or JSON text", () => {
  const ok = backupOf();
  assert.equal(validateBackup(ok).stores.measurements.length, ok.stores.measurements.length);
  assert.equal(validateBackup(JSON.stringify(ok)).stores.users.length, 6);
  const { reports, ...withoutReports } = ok.stores;
  assert.deepEqual(validateBackup({ ...ok, stores: withoutReports }).stores.reports, []); // missing store = empty
});

test("backup: malformed INDEXED fields are rejected (not just primary keys)", () => {
  const bad = [
    (s) => { s.wellbeingAssessments[0].sharedWithMedical = true; return s; },   // boolean in an index
    (s) => { s.alerts[0].status = null; return s; },                           // null in an index
    (s) => { delete s.measurements[0].timestamp; return s; },                  // missing indexed field
    (s) => { s.missionEvents[0].timestamp = Number.NaN; return s; },           // NaN
    (s) => { s.alerts[0].severity = "high"; return s; },                       // undocumented enum
    (s) => { s.users[0].role = "medical-officer"; return s; },                 // wrong role spelling
  ];
  for (const mutate of bad) assert.throws(() => validateBackup(backupOf(mutate)), isCode("INCOMPATIBLE_BACKUP"), mutate.toString());
});

test("backup: duplicate primary keys and duplicate unique values are rejected", () => {
  assert.throws(() => validateBackup(backupOf((s) => { s.alerts.push({ ...s.alerts[0] }); return s; })), /duplicate id/);
  assert.throws(() => validateBackup(backupOf((s) => { s.users[1] = { ...s.users[1], username: s.users[0].username }; return s; })), /duplicate username/);
  assert.throws(() => validateBackup(backupOf((s) => { s.alerts[1] = { ...s.alerts[1], number: s.alerts[0].number }; return s; })), /duplicate number/);
});

test("backup: wrong app, version, shape or store names are rejected", () => {
  const ok = backupOf();
  for (const file of [
    { ...ok, app: "Other" },
    { ...ok, schemaVersion: 2 },
    { ...ok, stores: [] },
    { ...ok, stores: { ...ok.stores, hacks: [] } },
    { ...ok, stores: { ...ok.stores, users: {} } },
    "{not json",
    null,
  ]) {
    assert.throws(() => validateBackup(file), isCode("INCOMPATIBLE_BACKUP"));
  }
});

// ---- Mock repositories: behaviour --------------------------------------------------

test("mock: six demo accounts, one login per astronaut, safe users only", async () => {
  await mock.resetMock({ now: NOW });
  const expected = { haddad: "a-01", karim: "a-02", chen: "a-03", reyes: "a-04", medofficer: "", medbackup: "" };
  for (const [username, astronautId] of Object.entries(expected)) {
    const user = await mock.usersRepo.verifyPassword(username, "demo");
    assert.ok(user, username);
    assert.equal(user.astronautId, astronautId);
    assert.equal(user.role, astronautId ? "astronaut" : "medical_officer");
    assert.ok(!("passwordHash" in user) && !("salt" in user));
  }
  const users = await mock.usersRepo.getAll();
  assert.equal(users.length, 6);
  const astronautIds = users.filter((u) => u.role === "astronaut").map((u) => u.astronautId);
  assert.deepEqual([...new Set(astronautIds)].sort(), ["a-01", "a-02", "a-03", "a-04"]);
  assert.equal(astronautIds.length, 4);
  assert.ok(users.every((u) => !("passwordHash" in u)));
});

test("mock: user add/update enforce roles; duplicate usernames fail with CONSTRAINT", async () => {
  await mock.resetMock({ now: NOW });
  await assert.rejects(mock.usersRepo.add({ username: "x", displayName: "X", role: "medical-officer", password: "p" }), isCode("INVALID"));
  await assert.rejects(mock.usersRepo.add({ username: "x", displayName: "X", role: "astronaut", password: "p" }), isCode("INVALID"));
  await assert.rejects(mock.usersRepo.add({ username: "x", displayName: "X", role: "medical_officer", astronautId: "a-01", password: "p" }), isCode("INVALID"));
  await assert.rejects(mock.usersRepo.add({ username: "HADDAD", displayName: "Dup", role: "astronaut", astronautId: "a-01", password: "p" }), isCode("CONSTRAINT"));
  await assert.rejects(mock.usersRepo.update("u-medofficer", { astronautId: "a-01" }), isCode("INVALID"));
});

test("mock: addMany is atomic — one bad record saves nothing", async () => {
  await mock.resetMock({ now: NOW });
  const before = await mock.measurementsRepo.countAll();
  const latestBefore = (await mock.astronautsRepo.getById("a-01")).latest;
  await assert.rejects(mock.measurementsRepo.addMany([
    { astronautId: "a-01", metric: "heartRate", value: 80, timestamp: NOW + 1 },
    { astronautId: "a-99", metric: "heartRate", value: 80, timestamp: NOW + 1 },
  ]), isCode("NOT_FOUND"));
  await assert.rejects(mock.measurementsRepo.addMany([
    { astronautId: "a-01", metric: "heartRate", value: 80, timestamp: NOW + 1 },
    { astronautId: "a-01", metric: "heartRate", value: 80, unit: "bps", timestamp: NOW + 1 },
  ]), isCode("INVALID"));
  assert.equal(await mock.measurementsRepo.countAll(), before);
  assert.deepEqual((await mock.astronautsRepo.getById("a-01")).latest, latestBefore);
});

test("mock: latest only moves forward; invalid readings skip latest + summaries; suspect is stored", async () => {
  await mock.resetMock({ now: NOW });
  const t = NOW + 60_000;
  await mock.measurementsRepo.add({ astronautId: "a-02", metric: "spo2", value: 50, timestamp: t + 1, quality: "invalid" });
  assert.notEqual((await mock.astronautsRepo.getById("a-02")).latest.spo2.value, 50);
  const suspect = await mock.measurementsRepo.add({ astronautId: "a-02", metric: "spo2", value: 80, timestamp: t, quality: "suspect" });
  assert.equal(suspect.quality, "suspect");
  assert.equal((await mock.astronautsRepo.getById("a-02")).latest.spo2.value, 80);
  await mock.astronautsRepo.updateLatest("a-02", "spo2", 99, t - 1000); // older → ignored
  assert.equal((await mock.astronautsRepo.getById("a-02")).latest.spo2.value, 80);
  await assert.rejects(mock.astronautsRepo.updateLatest("a-02", "temperature", 37, t + 5), isCode("INVALID"));
  await assert.rejects(mock.astronautsRepo.update("a-02", { crewId: "AH-77" }), isCode("INVALID"));
});

test("mock: shared wellbeing query returns shared check-ins only", async () => {
  await mock.resetMock({ now: NOW });
  const shared = await mock.wellbeingRepo.getSharedRange();
  assert.ok(shared.length > 0 && shared.every((w) => w.sharedWithMedical === 1));
  const all = (await Promise.all(["a-01", "a-02", "a-03", "a-04"].map((id) => mock.wellbeingRepo.getRange(id)))).flat();
  assert.equal(all.length - shared.length, 3);
});

test("mock: reports store a frozen snapshot copy; missing settings/meta keys are null", async () => {
  await mock.resetMock({ now: NOW });
  const snapshot = { heartRate: { avg: 72 } };
  const report = await mock.reportsRepo.add({ type: "astronaut_health", generatedBy: "u-medofficer", astronautId: "a-01", snapshot });
  snapshot.heartRate.avg = 999;
  assert.equal((await mock.reportsRepo.getById(report.id)).snapshot.heartRate.avg, 72);
  assert.equal(await mock.settingsRepo.get("nope"), null);
  assert.equal(await mock.metaRepo.get("nope"), null);
});

test("mock: alert actions come back in chronological order (ties by id)", async () => {
  await mock.resetMock({ now: NOW });
  const alert = await mock.alertsRepo.add({ astronautId: "a-01", ruleId: "PHY-02", severity: "critical", category: "physical" });
  await mock.alertActionsRepo.add({ id: "act_b", alertId: alert.id, action: "acknowledged", timestamp: 2000 });
  await mock.alertActionsRepo.add({ id: "act_c", alertId: alert.id, action: "created", timestamp: 1000 });
  await mock.alertActionsRepo.add({ id: "act_a", alertId: alert.id, action: "escalated", timestamp: 2000 });
  assert.deepEqual((await mock.alertActionsRepo.getByAlert(alert.id)).map((a) => a.id), ["act_c", "act_a", "act_b"]);
  assert.equal((await mock.alertsRepo.getById(alert.id)).status, "new"); // actions never change the alert
});

// ---- Mock ↔ real parity ---------------------------------------------------------------

test("mock and real expose the same repositories and function names", () => {
  const realRepos = Object.keys(real).filter((k) => k.endsWith("Repo")).sort();
  const mockRepos = Object.keys(mock).filter((k) => k.endsWith("Repo")).sort();
  assert.equal(realRepos.length, 15);
  assert.deepEqual(mockRepos, realRepos);
  for (const name of realRepos) assert.deepEqual(Object.keys(mock[name]).sort(), Object.keys(real[name]).sort(), name);
  assert.equal(typeof mock.withTransaction, "function");
});

// ---- Encapsulation: only js/db/index.js is public -----------------------------------------

function filesUnder(dir, exts) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}
const appFiles = [
  ...filesUnder(join(ROOT, "js"), [".js"]).filter((f) => !relative(ROOT, f).startsWith(join("js", "db"))),
  ...readdirSync(ROOT).filter((f) => f.endsWith(".html")).map((f) => join(ROOT, f)),
];
/** Source without // and /* comments (so explanations don't trip the checks). */
const code = (file) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("app code imports the database only through js/db/index.js", () => {
  for (const file of appFiles) {
    for (const [, path] of code(file).matchAll(/(?:from|import)\s*\(?\s*["']([^"']*\/db\/[^"']*)["']/g)) {
      assert.match(path, /\/db\/index\.js$/, `${relative(ROOT, file)} imports ${path}`);
    }
  }
});

test("no IndexedDB, password material or hyphenated role outside the database layer", () => {
  for (const file of appFiles) {
    const src = code(file);
    const name = relative(ROOT, file);
    assert.doesNotMatch(src, /indexedDB|IDBKeyRange|objectStore\(/, `${name} touches IndexedDB`);
    assert.doesNotMatch(src, /medical-officer/, `${name} uses "medical-officer"`);
    // session-core.js names the secret fields only to REJECT them.
    if (!name.endsWith("session-core.js")) assert.doesNotMatch(src, /passwordHash|\bsalt\b/, `${name} handles password material`);
  }
});
