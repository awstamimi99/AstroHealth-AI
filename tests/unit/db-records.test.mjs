// Unit tests for js/db/records.js, schema.js and password.js — run with: npm run test:unit
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMeasurement, buildWellbeing, buildAlert, buildMessage, buildEvent, mergeChanges, toSafeUser, toFlag, normalizeUsername,
} from "../../js/db/records.js";
import { SCHEMA, STORE_NAMES, MIGRATIONS, findIndexProblems } from "../../js/db/schema.js";
import { hashPassword, checkPassword, PBKDF2_ITERATIONS } from "../../js/db/password.js";
import { DatabaseError } from "../../js/db/errors.js";

test("schema v1 has the 15 documented stores and a migration", () => {
  assert.deepEqual(STORE_NAMES, [
    "users", "astronauts", "measurements", "dailySummaries", "wellbeingAssessments", "privateJournal",
    "cognitiveChecks", "simulationRuns", "alerts", "alertActions", "messages", "missionEvents",
    "reports", "settings", "meta",
  ]);
  assert.equal(typeof MIGRATIONS[1], "function");
  assert.equal(SCHEMA.settings.keyPath, "key");
});

test("index check rejects booleans, null and missing indexed fields", () => {
  const ok = { id: "x", astronautId: "a-01", timestamp: 1, sharedWithMedical: 1 };
  assert.deepEqual(findIndexProblems("wellbeingAssessments", ok), []);
  assert.equal(findIndexProblems("wellbeingAssessments", { ...ok, sharedWithMedical: true }).length, 1);
  assert.equal(findIndexProblems("wellbeingAssessments", { ...ok, astronautId: null }).length, 1);
  assert.equal(findIndexProblems("wellbeingAssessments", { ...ok, timestamp: Number.NaN }).length, 1);
  const { timestamp, ...missing } = ok;
  assert.ok(findIndexProblems("wellbeingAssessments", missing)[0].includes("timestamp"));
});

test("buildMeasurement fills defaults and the canonical unit", () => {
  const r = buildMeasurement({ astronautId: "a-01", metric: "heartRate", value: 72, timestamp: 1000 }, 5000);
  assert.match(r.id, /^msr_/);
  assert.match(r.sampleId, /^smp_/);
  assert.equal(r.unit, "bpm");
  assert.equal(r.quality, "ok");
  assert.equal(r.source, "manual");
  assert.equal(r.simulationRunId, "");
  assert.equal(r.createdAt, 5000);
  assert.equal(r.createdBy, "system");
});

test("buildMeasurement enforces canonical units and known metrics", () => {
  const base = { astronautId: "a-01", value: 98, timestamp: 1 };
  assert.throws(() => buildMeasurement({ ...base, metric: "spo2", unit: "ratio" }), /must be stored in "%"/);
  assert.throws(() => buildMeasurement({ ...base, metric: "temperature" }), /unknown metric/);
  assert.throws(() => buildMeasurement({ ...base, metric: "spo2", value: "98" }), DatabaseError);
  assert.throws(() => buildMeasurement({ metric: "spo2", value: 98, timestamp: 1 }), /astronautId/);
});

test("flags become 0/1 (never booleans)", () => {
  assert.equal(toFlag(true), 1);
  assert.equal(toFlag(false), 0);
  assert.equal(toFlag(undefined), 0);
  const w = buildWellbeing({ astronautId: "a-01", sharedWithMedical: true, mood: 3 });
  assert.equal(w.sharedWithMedical, 1);
  assert.equal(buildWellbeing({ astronautId: "a-01" }).sharedWithMedical, 0); // private by default
});

test("buildAlert: documented defaults", () => {
  const a = buildAlert({ number: "ALT-0001", astronautId: "a-01", ruleId: "PHY-02", severity: "critical", category: "physical" }, 10);
  assert.equal(a.status, "new");
  assert.equal(a.dedupeKey, "a-01:PHY-02");
  assert.equal(a.detectedAt, 10);
  assert.equal(a.lastTriggeredAt, 10);
  assert.equal(a.occurrenceCount, 1);
  assert.equal(a.conditionCleared, 0);
  assert.equal(a.acknowledgedAt, 0);
  assert.equal(a.acknowledgedBy, "");
  assert.deepEqual(a.triggeringMeasurements, []);
});

test("message / event defaults ('' and 0 instead of null for indexed or time fields)", () => {
  const msg = buildMessage({ astronautId: "a-01", fromUserId: "u-medofficer", body: "hi" }, 7);
  assert.equal(msg.relatedAlertId, "");
  assert.equal(msg.acknowledgedAt, 0);
  assert.equal(msg.response, null); // allowed: not indexed
  assert.equal(msg.createdBy, "u-medofficer");
  const evt = buildEvent({ type: "data_reset" }, 7);
  assert.equal(evt.astronautId, "crew");
  assert.equal(evt.actorUserId, "system");
});

test("mergeChanges never changes id / createdAt / createdBy", () => {
  const existing = buildMessage({ astronautId: "a-01", fromUserId: "u-1" }, 1);
  const updated = mergeChanges("messages", existing, { id: "hack", createdAt: 0, createdBy: "x", acknowledgedAt: 50 }, 99);
  assert.equal(updated.id, existing.id);
  assert.equal(updated.createdAt, 1);
  assert.equal(updated.createdBy, "u-1");
  assert.equal(updated.acknowledgedAt, 50);
  assert.equal(updated.updatedAt, 99);
});

test("usernames are normalized and secrets are stripped", () => {
  assert.equal(normalizeUsername("  MedOfficer "), "medofficer");
  assert.deepEqual(toSafeUser({ id: "u", passwordHash: "h", salt: "s", username: "x" }), { id: "u", username: "x" });
  assert.equal(toSafeUser(null), null);
});

test("PBKDF2 password hashing: right/wrong password, random salt", async () => {
  assert.equal(PBKDF2_ITERATIONS, 100000);
  const a = await hashPassword("demo");
  const b = await hashPassword("demo");
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.passwordHash, b.passwordHash);
  assert.equal(Buffer.from(a.salt, "base64").length, 16);
  assert.ok(await checkPassword("demo", a.passwordHash, a.salt));
  assert.equal(await checkPassword("Demo", a.passwordHash, a.salt), false);
  assert.equal(await checkPassword("demo", "", ""), false);
});
