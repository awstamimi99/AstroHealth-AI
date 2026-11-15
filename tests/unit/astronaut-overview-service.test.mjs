// tests/unit/astronaut-overview-service.test.mjs — Sprint 4 Overview service.
// Uses the in-memory mock repositories (same seed as the real database) and
// small hand-built fake repositories for edge cases.
// Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// js/db/index.js expects these globals (no IndexedDB is touched in these tests).
globalThis.self = globalThis;
globalThis.BroadcastChannel = class { postMessage() {} addEventListener() {} close() {} };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

const svc = await import("../../js/services/astronaut-overview-service.js");
const mock = await import("../../js/db/mock-repositories.js");
const { describeMission } = await import("../../js/services/mission-service.js");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 14, 15, 30); // 14 Nov 2026, 15:30 UTC (after the 08:00 check-in)

const session = (overrides = {}) => ({
  version: 1, userId: "u-haddad", username: "haddad", displayName: "Cmdr. Sami Haddad",
  role: "astronaut", astronautId: "a-01", createdAt: NOW - HOUR, expiresAt: NOW + 11 * HOUR, ...overrides,
});
const SESSIONS = {
  "a-01": session(),
  "a-02": session({ userId: "u-karim", username: "karim", displayName: "Dr. Aisha Karim", astronautId: "a-02" }),
  "a-03": session({ userId: "u-chen", username: "chen", displayName: "Mei Chen", astronautId: "a-03" }),
  "a-04": session({ userId: "u-reyes", username: "reyes", displayName: "Jonas Reyes", astronautId: "a-04" }),
};

/** Repositories wrapped so every call is recorded: [{ repo, method, args }]. */
function spy(repos) {
  const calls = [];
  const wrapped = {};
  for (const [name, repo] of Object.entries(repos)) {
    wrapped[name] = new Proxy(repo, {
      get(target, prop) {
        const value = target[prop];
        if (typeof value !== "function") return value;
        return (...args) => {
          calls.push({ repo: name, method: String(prop), args });
          return value.apply(target, args);
        };
      },
    });
  }
  return { repos: wrapped, calls };
}

const mockRepos = () => ({
  usersRepo: mock.usersRepo, astronautsRepo: mock.astronautsRepo, measurementsRepo: mock.measurementsRepo,
  dailySummariesRepo: mock.dailySummariesRepo, alertsRepo: mock.alertsRepo, messagesRepo: mock.messagesRepo,
  wellbeingRepo: mock.wellbeingRepo, cognitiveRepo: mock.cognitiveRepo,
});
const mockMission = async () => describeMission(await mock.settingsRepo.get("mission"), NOW);

function seededService() {
  const s = spy(mockRepos());
  return { ...s, service: svc.createAstronautOverviewService({ repos: s.repos, getMissionContext: mockMission }) };
}

// ---- Hand-built fake repositories for edge cases ------------------------------

const ASTRONAUT = Object.freeze({
  id: "a-01", crewId: "AH-01", name: "Sami Haddad", missionRole: "Commander", age: 41, initials: "SH",
  baseline: Object.freeze({ heartRate: 72, spo2: 98, bpSystolic: 118, bpDiastolic: 76, sleepDuration: 7 }),
  latest: Object.freeze({}),
});
const USER = Object.freeze({ id: "u-haddad", username: "haddad", displayName: "Cmdr. Sami Haddad", role: "astronaut", astronautId: "a-01" });

let seq = 0;
const reading = (metric, value, ago, extra = {}) => ({
  id: `msr_t_${++seq}`, astronautId: "a-01", metric, value, unit: { heartRate: "bpm", spo2: "%", bpSystolic: "mmHg", bpDiastolic: "mmHg", sleepDuration: "h" }[metric],
  timestamp: NOW - ago, source: "seed", quality: "ok", sampleId: `smp_t_${seq}`, simulationRunId: "", ...extra,
});
const alert = (number, severity, status, extra = {}) => ({
  id: `alr_${number}`, number, astronautId: "a-01", ruleId: "R", type: "test_alert", category: "physical",
  severity, status, title: `${severity} alert`, detectedAt: NOW - HOUR, explanation: "Because.", ...extra,
});

/** Minimal valid repositories; pass overrides like { measurements: { heartRate: [...] } }. */
const MO = Object.freeze({ id: "u-medofficer", username: "medofficer", displayName: "Dr. Lena Ortiz", role: "medical_officer", astronautId: "" });

/**
 * Minimal valid repositories; pass overrides like { measurements: { heartRate: [...] } }.
 * `users` = other accounts (message senders); `fail.senders` makes sender lookups fail.
 * `lookups` records every usersRepo.getById id.
 */
function fakeRepos({ user = USER, astronaut = ASTRONAUT, users = { [MO.id]: MO }, measurements = {}, alerts = [], messages = [], checkin = null, cognitive = [], sleepSummaries = [], fail = {}, lookups = [] } = {}) {
  const maybeFail = (key, value) => (fail[key] ? Promise.reject(new Error(`${key} failed`)) : Promise.resolve(value));
  return {
    usersRepo: {
      getById: (id) => {
        lookups.push(id);
        if (user && id === user.id) return maybeFail("user", user);
        return maybeFail("senders", users[id] ?? null);
      },
    },
    astronautsRepo: { getById: (id) => maybeFail("astronaut", astronaut && astronaut.id === id ? astronaut : null) },
    measurementsRepo: { getRecent: (aid, metric) => maybeFail(metric, measurements[metric] || []) },
    dailySummariesRepo: { getRange: () => maybeFail("sleepSummaries", sleepSummaries) },
    alertsRepo: { query: () => maybeFail("alerts", alerts) },
    messagesRepo: { getUnacknowledged: () => maybeFail("messages", messages) },
    wellbeingRepo: { getLatest: () => maybeFail("checkin", checkin) },
    cognitiveRepo: { getRange: () => maybeFail("cognitive", cognitive) },
  };
}
const fakeService = (opts) =>
  svc.createAstronautOverviewService({ repos: fakeRepos(opts), getMissionContext: async () => ({ available: true, name: "TEST-1", missionDay: 5 }) });
const msg = (extra = {}) => ({ astronautId: "a-01", fromUserId: MO.id, sentAt: NOW - HOUR, acknowledgedAt: 0, body: "Hello", ...extra });
const vital = (result, key) => result.vitals.items.find((i) => i.key === key);

// Seed once (hashing the demo passwords is the slow part).
await mock.resetMock({ now: NOW });

// =================================================================================
// Identity, authorization and privacy
// =================================================================================

test("1. an astronaut sees only their own data (seeded data, all four astronauts)", async () => {
  for (const [aid, s] of Object.entries(SESSIONS)) {
    const { service, calls } = seededService();
    const result = await service.getAstronautOverview(s, { now: NOW });
    assert.equal(result.status, "ready", aid);
    const crew = { "a-01": "AH-01", "a-02": "AH-02", "a-03": "AH-03", "a-04": "AH-04" }[aid];
    assert.equal(result.astronaut.crewId, crew);
    // every health read asked for this astronaut only
    for (const call of calls.filter((c) => c.repo !== "usersRepo")) {
      const asked = call.repo === "alertsRepo" ? call.args[0].astronautId : call.args[0];
      assert.equal(asked, aid, `${call.repo}.${call.method}`);
    }
  }
});

test("1b. records that belong to another astronaut are dropped even if a repository returns them", async () => {
  const foreign = { astronautId: "a-03" };
  const service = fakeService({
    measurements: { heartRate: [reading("heartRate", 70, 2 * HOUR), reading("heartRate", 140, HOUR, foreign)] },
    alerts: [alert("ALT-0001", "critical", "new", foreign)],
    messages: [{ astronautId: "a-03", sentAt: NOW - HOUR, acknowledgedAt: 0, body: "Not yours" }],
    checkin: { astronautId: "a-03", timestamp: NOW - HOUR, sharedWithMedical: 1 },
    cognitive: [{ astronautId: "a-03", timestamp: NOW - HOUR }],
    sleepSummaries: [{ astronautId: "a-03", date: "2026-11-14", avg: 3, count: 1 }],
  });
  const r = await service.getAstronautOverview(session(), { now: NOW });
  assert.equal(vital(r, "heartRate").value, 70);
  assert.equal(r.alerts.openCount, 0);
  assert.equal(r.overall.level, "clear");
  assert.equal(r.messages.latest, null);
  assert.equal(r.routine.checkin.state, "not_done");
  assert.equal(r.routine.cognitive.state, "none");
  assert.equal(r.sleep.recorded, 0);
});

test("2. a missing or malformed session is refused before any health read", async () => {
  const cases = [
    [null, "no_session"], [undefined, "no_session"], ["haddad", "no_session"],
    [session({ astronautId: "" }), "invalid_session"], [session({ userId: "" }), "invalid_session"],
    [session({ astronautId: 7 }), "invalid_session"], [{ role: "astronaut" }, "invalid_session"],
  ];
  for (const [s, reason] of cases) {
    const { service, calls } = seededService();
    const r = await service.getAstronautOverview(s, { now: NOW });
    assert.deepEqual({ status: r.status, reason: r.reason }, { status: "forbidden", reason }, JSON.stringify(s));
    assert.equal(calls.length, 0, "no repository was called");
    assert.equal(r.vitals, undefined);
  }
});

test("3. a medical_officer session can't receive a personal Overview", async () => {
  for (const s of [
    session({ role: "medical_officer", userId: "u-medofficer", astronautId: "" }),
    session({ role: "medical_officer", userId: "u-medofficer", astronautId: "a-01" }),
    session({ role: "medical-officer" }), session({ role: "admin" }),
  ]) {
    const { service, calls } = seededService();
    const r = await service.getAstronautOverview(s, { now: NOW });
    assert.deepEqual({ status: r.status, reason: r.reason }, { status: "forbidden", reason: "not_astronaut" });
    assert.equal(calls.length, 0);
  }
});

test("4. a session whose user and astronautId don't match the stored account is refused", async () => {
  const cases = [
    session({ astronautId: "a-03" }),                 // haddad's user id with Chen's astronaut id
    session({ userId: "u-chen" }),                    // Chen's user id with haddad's astronaut id
    session({ userId: "u-medofficer" }),              // a medical officer's user id
    session({ userId: "u-nobody" }),                  // unknown user
  ];
  for (const s of cases) {
    const { service, calls } = seededService();
    const r = await service.getAstronautOverview(s, { now: NOW });
    assert.deepEqual({ status: r.status, reason: r.reason }, { status: "forbidden", reason: "account_mismatch" }, JSON.stringify(s));
    assert.deepEqual(calls.map((c) => c.repo), ["usersRepo"], "only the identity check ran");
  }
});

test("4b. a missing astronaut profile and database failures give 'unavailable' without health reads", async () => {
  let r = await fakeService({ astronaut: null }).getAstronautOverview(session(), { now: NOW });
  assert.deepEqual({ status: r.status, reason: r.reason }, { status: "unavailable", reason: "profile_missing" });
  r = await fakeService({ fail: { user: true } }).getAstronautOverview(session(), { now: NOW });
  assert.deepEqual({ status: r.status, reason: r.reason }, { status: "unavailable", reason: "database_error" });
  r = await fakeService({ fail: { astronaut: true } }).getAstronautOverview(session(), { now: NOW });
  assert.deepEqual({ status: r.status, reason: r.reason }, { status: "unavailable", reason: "database_error" });
});

test("5. an astronautId passed in options can't override the session identity", async () => {
  const { service, calls } = seededService();
  const r = await service.getAstronautOverview(session(), { now: NOW, astronautId: "a-03", userId: "u-chen", repos: {} });
  assert.equal(r.astronaut.crewId, "AH-01");
  assert.ok(calls.every((c) => !JSON.stringify(c.args).includes("a-03")), "a-03 was never queried");
});

test("24. the service never imports or calls journalRepo (and no other unapproved repository)", () => {
  const source = read("js/services/astronaut-overview-service.js");
  assert.doesNotMatch(source, /journalRepo|privateJournal|reportsRepo|eventsRepo|simulationRunsRepo|alertActionsRepo/);
  const imports = [...source.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["../db/index.js", "./mission-service.js"]);
  // Read-only: no repository write method and no write transaction.
  assert.doesNotMatch(source, /Repo\.(add|addMany|update|updateLatest|set|upsert)\(|withTransaction|"readwrite"/, "read-only");
  const repoCalls = [...source.matchAll(/repos\.(\w+)\.(\w+)\(/g)].map((m) => `${m[1]}.${m[2]}`);
  assert.deepEqual([...new Set(repoCalls)].sort(), [
    "alertsRepo.query", "astronautsRepo.getById", "cognitiveRepo.getRange", "dailySummariesRepo.getRange",
    "measurementsRepo.getRecent", "messagesRepo.getUnacknowledged", "usersRepo.getById", "wellbeingRepo.getLatest",
  ]);
});

test("7b. wellbeing scores never leave the service", async () => {
  const { service } = seededService();
  const r = await service.getAstronautOverview(SESSIONS["a-03"], { now: NOW });
  const keys = new Set();
  const walk = (o) => { if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { keys.add(k); walk(v); } };
  walk(r);
  for (const field of ["mood", "stress", "sleepQuality", "isolation", "wellbeing", "fatigue", "text", "sharedWithMedical"]) {
    assert.ok(!keys.has(field), `no "${field}" field anywhere in the result`);
  }
  assert.deepEqual(Object.keys(r.routine.checkin).sort(), ["completedAt", "lastAt", "shared", "state", "status"]);
});

// =================================================================================
// Vital signs
// =================================================================================

test("6. the newest usable reading is selected", async () => {
  const service = fakeService({ measurements: { heartRate: [reading("heartRate", 60, 3 * HOUR), reading("heartRate", 65, 2 * HOUR), reading("heartRate", 70, HOUR)] } });
  const hr = vital(await service.getAstronautOverview(session(), { now: NOW }), "heartRate");
  assert.deepEqual({ state: hr.state, value: hr.value, timestamp: hr.timestamp }, { state: "ok", value: 70, timestamp: NOW - HOUR });
});

test("7. invalid readings are excluded; invalid-only lists are honest empties", async () => {
  const service = fakeService({
    measurements: {
      heartRate: [reading("heartRate", 64, 3 * HOUR), reading("heartRate", 250, HOUR, { quality: "invalid" })],
      spo2: [reading("spo2", 10, HOUR, { quality: "invalid" })],
    },
  });
  const r = await service.getAstronautOverview(session(), { now: NOW });
  assert.equal(vital(r, "heartRate").value, 64);
  assert.deepEqual(vital(r, "spo2"), { key: "spo2", label: "SpO₂", unit: "%", baseline: 98, state: "empty", invalidOnly: true });
});

test("8. suspect readings stay visible and are marked suspect (seeded a-03 SpO₂ 72 %)", async () => {
  const service = fakeService({ measurements: { spo2: [reading("spo2", 97, 2 * HOUR), reading("spo2", 72, HOUR, { quality: "suspect" })] } });
  const spo2 = vital(await service.getAstronautOverview(session(), { now: NOW }), "spo2");
  assert.equal(spo2.value, 72);
  assert.equal(spo2.quality, "suspect");
  // The seeded suspect reading is selected when it is the newest usable one.
  const list = await mock.measurementsRepo.getRecent("a-03", "spo2", 500);
  const suspect = list.find((m) => m.quality === "suspect");
  assert.equal(suspect.value, 72);
  const picked = svc.selectLatestUsable(list.filter((m) => m.timestamp <= suspect.timestamp), { now: NOW, staleMs: svc.VITALS_STALE_MS });
  assert.deepEqual({ value: picked.value, quality: picked.quality }, { value: 72, quality: "suspect" });
});

test("9. units, timestamps and ages are preserved", async () => {
  const { service } = seededService();
  const r = await service.getAstronautOverview(session(), { now: NOW });
  const units = Object.fromEntries(r.vitals.items.map((i) => [i.key, i.unit]));
  assert.deepEqual(units, { heartRate: "bpm", spo2: "%", bloodPressure: "mmHg", sleepDuration: "h" });
  const latestHr = (await mock.measurementsRepo.getRecent("a-01", "heartRate", 1))[0];
  const hr = vital(r, "heartRate");
  assert.equal(hr.timestamp, latestHr.timestamp);
  assert.equal(hr.value, latestHr.value);
  assert.equal(hr.ageMs, NOW - latestHr.timestamp);
  assert.equal(hr.baseline, 72);
});

test("10. blood pressure is paired only by sampleId, with the worse quality", async () => {
  const sysA = reading("bpSystolic", 120, 2 * HOUR, { sampleId: "S1" });
  const diaA = reading("bpDiastolic", 80, 2 * HOUR, { sampleId: "S1", quality: "suspect" });
  const sysB = reading("bpSystolic", 150, HOUR, { sampleId: "S2" });   // newer, but no diastolic for S2
  const diaC = reading("bpDiastolic", 99, 30 * 60 * 1000, { sampleId: "S3" }); // unrelated newer diastolic
  const r = await fakeService({ measurements: { bpSystolic: [sysA, sysB], bpDiastolic: [diaA, diaC] } }).getAstronautOverview(session(), { now: NOW });
  const bp = vital(r, "bloodPressure");
  assert.deepEqual(
    { state: bp.state, systolic: bp.systolic, diastolic: bp.diastolic, quality: bp.quality, timestamp: bp.timestamp },
    { state: "ok", systolic: 120, diastolic: 80, quality: "suspect", timestamp: NOW - 2 * HOUR }
  );
  assert.deepEqual(bp.baseline, { systolic: 118, diastolic: 76 });
});

test("11. an incomplete blood-pressure pair is reported honestly, never invented", async () => {
  let bp = vital(await fakeService({ measurements: { bpSystolic: [reading("bpSystolic", 120, HOUR, { sampleId: "S1" })] } }).getAstronautOverview(session(), { now: NOW }), "bloodPressure");
  assert.equal(bp.state, "incomplete");
  assert.equal(bp.systolic, undefined);
  bp = vital(await fakeService({
    measurements: { bpSystolic: [reading("bpSystolic", 120, HOUR, { sampleId: "S1" })], bpDiastolic: [reading("bpDiastolic", 80, HOUR, { sampleId: "S1", quality: "invalid" })] },
  }).getAstronautOverview(session(), { now: NOW }), "bloodPressure");
  assert.equal(bp.state, "incomplete", "an invalid half doesn't complete a pair");
  bp = vital(await fakeService().getAstronautOverview(session(), { now: NOW }), "bloodPressure");
  assert.deepEqual({ state: bp.state, invalidOnly: bp.invalidOnly }, { state: "empty", invalidOnly: false });
});

test("16. no measurements → honest empty states (no zeros, no invented values)", async () => {
  const r = await fakeService().getAstronautOverview(session(), { now: NOW });
  for (const item of r.vitals.items) {
    assert.equal(item.state, "empty", item.key);
    assert.equal(item.value, undefined, item.key);
  }
  assert.equal(r.vitals.status, "ok");
  assert.equal(r.routine.vitals.state, "none");
  assert.deepEqual(r.sleep.nights.map((n) => n.hours), [null, null, null, null, null, null, null]);
  assert.equal(r.sleep.average, null);
});

test("18–19. seed and simulation readings are simulated; manual readings are not", async () => {
  const r = await fakeService({
    measurements: {
      heartRate: [reading("heartRate", 70, HOUR, { source: "seed" })],
      spo2: [reading("spo2", 97, HOUR, { source: "simulation" })],
      sleepDuration: [reading("sleepDuration", 7, HOUR, { source: "manual" })],
      bpSystolic: [reading("bpSystolic", 120, HOUR, { sampleId: "S", source: "manual" })],
      bpDiastolic: [reading("bpDiastolic", 80, HOUR, { sampleId: "S", source: "manual" })],
    },
  }).getAstronautOverview(session(), { now: NOW });
  assert.deepEqual(
    r.vitals.items.map((i) => [i.key, i.source, i.simulated]),
    [["heartRate", "seed", true], ["spo2", "simulation", true], ["bloodPressure", "manual", false], ["sleepDuration", "manual", false]]
  );
  // Every alert is marked synthetic (all prototype data is synthetic).
  const seeded = await seededService().service.getAstronautOverview(SESSIONS["a-04"], { now: NOW });
  assert.ok(seeded.alerts.items.every((a) => a.synthetic === true));
});

test("20. stale rules: vitals after 24 h, sleep after 36 h", async () => {
  const r = await fakeService({
    measurements: {
      heartRate: [reading("heartRate", 70, 24 * HOUR)],                // exactly 24 h → not stale
      spo2: [reading("spo2", 97, 24 * HOUR + 1)],                      // just over → stale
      sleepDuration: [reading("sleepDuration", 7, 36 * HOUR + 1)],    // just over 36 h → stale
    },
  }).getAstronautOverview(session(), { now: NOW });
  assert.equal(vital(r, "heartRate").stale, false);
  assert.equal(vital(r, "spo2").stale, true);
  assert.equal(vital(r, "sleepDuration").stale, true);
  const fresh = await fakeService({ measurements: { sleepDuration: [reading("sleepDuration", 7, 30 * HOUR)] } }).getAstronautOverview(session(), { now: NOW });
  assert.equal(vital(fresh, "sleepDuration").stale, false, "30 h old sleep is still current");
  assert.deepEqual(svc.describeAge(NOW + HOUR, NOW, svc.VITALS_STALE_MS), { ageMs: -HOUR, stale: false });
  // Seed data viewed 3 days later is stale but still shown.
  const later = await seededService().service.getAstronautOverview(session(), { now: NOW + 3 * DAY });
  assert.ok(later.vitals.items.every((i) => i.state === "ok" && i.stale === true));
});

// =================================================================================
// Alerts and overall status
// =================================================================================

test("12. critical > warning > info, regardless of input order or acknowledgement", () => {
  const a = (severity, status = "new") => ({ severity, status, detectedAt: NOW });
  assert.equal(svc.deriveOverallStatus([a("info"), a("critical", "acknowledged"), a("warning")]).level, "critical");
  assert.equal(svc.deriveOverallStatus([a("warning", "acknowledged"), a("info")]).level, "watch");
  assert.equal(svc.deriveOverallStatus([a("info")]).level, "info");
  const watch = svc.deriveOverallStatus([a("warning", "acknowledged")]);
  assert.deepEqual({ label: watch.label, icon: watch.icon, tone: watch.tone }, { label: "Watch", icon: "triangle-alert", tone: "warning" });
  const crit = svc.deriveOverallStatus([a("critical")]);
  assert.deepEqual({ label: crit.label, icon: crit.icon, tone: crit.tone }, { label: "Critical", icon: "circle-alert", tone: "critical" });
});

test("13. resolved alerts never affect the current status (seeded a-01 ALT-0181)", async () => {
  assert.equal(svc.deriveOverallStatus([{ severity: "critical", status: "resolved", detectedAt: NOW }]).level, "clear");
  const r = await seededService().service.getAstronautOverview(session(), { now: NOW });
  assert.equal(r.overall.level, "clear");
  assert.equal(r.alerts.openCount, 0);
  assert.deepEqual(r.alerts.items.map((a) => [a.number, a.status]), [["ALT-0181", "resolved"]], "recently resolved alert remains visible on the body map");
  const service = fakeService({ alerts: [alert("ALT-1", "critical", "resolved")] }); // even if a repository returns it
  assert.equal((await service.getAstronautOverview(session(), { now: NOW })).overall.level, "clear");
});

test("14. no open alerts → 'No open alerts', never a health claim", async () => {
  const r = await fakeService().getAstronautOverview(session(), { now: NOW });
  assert.equal(r.overall.label, "No open alerts");
  assert.equal(r.overall.note, "Based on your open alerts only. This is not a health assessment.");
  const words = JSON.stringify(r.overall).toLowerCase();
  for (const banned of ["healthy", "safe", "normal", "nominal", "cleared", "no health risk"]) {
    assert.ok(!words.includes(banned), `overall status never says "${banned}"`);
  }
});

test("15. a failed alert query → 'Status unavailable', never 'No open alerts'", async () => {
  const r = await fakeService({ fail: { alerts: true } }).getAstronautOverview(session(), { now: NOW });
  assert.equal(r.status, "ready");
  assert.equal(r.overall.level, "unavailable");
  assert.equal(r.overall.label, "Status unavailable");
  assert.equal(r.overall.openAlertCount, null);
  assert.equal(r.alerts.status, "error");
});

test("seeded alert states per astronaut: a-03 Info (ALT-0189), a-04 Watch (ALT-0190)", async () => {
  const chen = await seededService().service.getAstronautOverview(SESSIONS["a-03"], { now: NOW });
  assert.equal(chen.overall.level, "info");
  assert.deepEqual(chen.alerts.items.map((a) => [a.number, a.severity, a.status]), [["ALT-0189", "info", "new"]]);
  const reyes = await seededService().service.getAstronautOverview(SESSIONS["a-04"], { now: NOW });
  assert.equal(reyes.overall.level, "watch");
  assert.deepEqual(reyes.alerts.items.map((a) => [a.number, a.title, a.status]), [["ALT-0190", "Reduced sleep duration", "acknowledged"]]);
  assert.match(reyes.alerts.items[0].explanation, /below 6\.5 h/);
});

test("body-map alerts: up to four current/recent alerts, most severe first, title falls back to type", async () => {
  const r = await fakeService({
    alerts: [
      alert("ALT-0001", "info", "new", { detectedAt: NOW - 1 }),
      alert("ALT-0002", "warning", "acknowledged", { detectedAt: NOW - 5 }),
      alert("ALT-0003", "critical", "new", { detectedAt: NOW - 9, title: "" }),
      alert("ALT-0004", "warning", "new", { detectedAt: NOW - 2 }),
    ],
  }).getAstronautOverview(session(), { now: NOW });
  assert.deepEqual(r.alerts.items.map((a) => a.number), ["ALT-0003", "ALT-0004", "ALT-0002", "ALT-0001"]);
  assert.equal(r.alerts.items[0].title, "Test alert");
  assert.equal(r.alerts.openCount, 4);
  assert.equal(r.alerts.moreCount, 0);
  assert.equal(r.overall.openAlertCount, 4);
});

// =================================================================================
// Routine, messages, sleep, UTC rules
// =================================================================================

test("17. check-in completion uses the UTC calendar day (around midnight)", () => {
  const midnight = Date.UTC(2026, 10, 15);
  const checkin = (t, shared = 1) => ({ astronautId: "a-01", timestamp: t, sharedWithMedical: shared });
  assert.equal(svc.describeCheckin(checkin(midnight - 30 * 60 * 1000), midnight - 60 * 1000).state, "done", "23:30 → 23:59 same UTC day");
  const next = svc.describeCheckin(checkin(midnight - 30 * 60 * 1000), midnight + 30 * 60 * 1000);
  assert.deepEqual({ state: next.state, shared: next.shared }, { state: "not_done", shared: null }, "00:30 next day → not done");
  assert.equal(svc.describeCheckin(checkin(midnight + 60 * 1000), midnight + 30 * 60 * 1000).state, "done");
  assert.equal(svc.describeCheckin(checkin(midnight, 0), midnight + HOUR).shared, false, "private check-in");
  assert.equal(svc.describeCheckin(null, NOW).state, "not_done");
  assert.equal(svc.utcDateKey(midnight - 1), "2026-11-14");
  assert.ok(svc.isSameUtcDay(midnight, midnight + DAY - 1));
  assert.ok(!svc.isSameUtcDay(midnight - 1, midnight));
});

test("routine from seeded data: check-in done & shared, vitals today, cognitive last completed", async () => {
  const r = await seededService().service.getAstronautOverview(session(), { now: NOW });
  assert.equal(r.today, "2026-11-14");
  assert.deepEqual({ state: r.routine.checkin.state, shared: r.routine.checkin.shared }, { state: "done", shared: true });
  assert.equal(r.routine.vitals.state, "today");
  assert.equal(r.routine.cognitive.state, "recorded");
  assert.equal(r.routine.cognitive.lastAt, Date.UTC(2026, 10, 13, 8, 30), "yesterday 08:30 UTC");
  const routineJson = JSON.stringify(r.routine);
  assert.ok(!/due|overdue/i.test(routineJson), "never due/overdue");
  // Before 08:00 UTC the newest check-in is yesterday's → not done today.
  await mock.resetMock({ now: Date.UTC(2026, 10, 14, 7, 0) });
  const early = await seededService().service.getAstronautOverview(session(), { now: Date.UTC(2026, 10, 14, 7, 0) });
  assert.equal(early.routine.checkin.state, "not_done");
  assert.ok(early.routine.checkin.lastAt > 0);
  await mock.resetMock({ now: NOW });
});

test("messages: newest unacknowledged one, read-only, plus a count of the rest", async () => {
  const r = await seededService().service.getAstronautOverview(session(), { now: NOW });
  assert.equal(r.messages.status, "ok");
  assert.match(r.messages.latest.body, /vital-signs reading/);
  assert.equal(r.messages.latest.from, "Medical Officer");
  assert.equal(r.messages.moreCount, 0);
  const reyes = await seededService().service.getAstronautOverview(SESSIONS["a-04"], { now: NOW });
  assert.equal(reyes.messages.latest, null, "a-04's message is already acknowledged");
  const many = await fakeService({
    messages: [
      msg({ sentAt: NOW - 3 * HOUR, body: "older" }),
      msg({ sentAt: NOW - HOUR, body: "newest" }),
      msg({ sentAt: NOW - 2 * HOUR, acknowledgedAt: NOW, body: "acked" }),
    ],
  }).getAstronautOverview(session(), { now: NOW });
  assert.deepEqual({ body: many.messages.latest.body, more: many.messages.moreCount }, { body: "newest", more: 1 });
});

test("sleep: last 7 UTC dates, missing nights stay null, average and nights below baseline", async () => {
  const s = svc.summarizeSleep(
    [
      { date: "2026-11-14", avg: 6.0, count: 1 },
      { date: "2026-11-12", avg: 7.5, count: 1 },
      { date: "2026-11-08", avg: 7.0, count: 1 },
      { date: "2026-11-07", avg: 2.0, count: 1 }, // outside the window
    ],
    7, NOW
  );
  assert.deepEqual(s.nights.map((n) => n.date), ["2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14"]);
  assert.deepEqual(s.nights.map((n) => n.hours), [7, null, null, null, 7.5, null, 6]);
  assert.deepEqual({ recorded: s.recorded, average: s.average, baseline: s.baseline, below: s.belowBaseline }, { recorded: 3, average: 6.833333333333333, baseline: 7, below: 1 });
  // Seeded a-04: the last three nights are short.
  const reyes = await seededService().service.getAstronautOverview(SESSIONS["a-04"], { now: NOW });
  assert.equal(reyes.sleep.recorded, 7);
  assert.deepEqual(reyes.sleep.nights.slice(-3).map((n) => n.hours), [5.6, 5.3, 5.8]);
  assert.ok(reyes.sleep.belowBaseline >= 3);
});

// =================================================================================
// Partial failures, mutation, mission
// =================================================================================

test("21. a failed section stays partial; the other sections still load", async () => {
  const r = await fakeService({
    measurements: { heartRate: [reading("heartRate", 70, HOUR)] },
    fail: { spo2: true, messages: true, cognitive: true, sleepSummaries: true },
  }).getAstronautOverview(session(), { now: NOW });
  assert.equal(r.status, "ready");
  assert.equal(r.vitals.status, "partial");
  assert.equal(vital(r, "heartRate").state, "ok");
  assert.equal(vital(r, "spo2").state, "error");
  assert.equal(r.messages.status, "error");
  assert.equal(r.sleep.status, "error");
  assert.equal(r.routine.status, "partial");
  assert.equal(r.routine.cognitive.status, "error");
  assert.equal(r.routine.vitals.partial, true);
  assert.equal(r.overall.level, "clear", "alerts loaded fine");
  // A synchronous throw inside a repository is also contained.
  const repos = fakeRepos();
  repos.wellbeingRepo.getLatest = () => { throw new Error("sync boom"); };
  const r2 = await svc.createAstronautOverviewService({ repos, getMissionContext: async () => { throw new Error("x"); } }).getAstronautOverview(session(), { now: NOW });
  assert.equal(r2.routine.checkin.status, "error");
  assert.deepEqual(r2.mission, { available: false, name: "Not available", missionDay: null });
});

test("22. inputs and raw records are not mutated", async () => {
  const deepFreeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
  const measurements = deepFreeze({
    heartRate: [reading("heartRate", 64, 2 * HOUR), reading("heartRate", 70, HOUR)],
    bpSystolic: [reading("bpSystolic", 120, HOUR, { sampleId: "S" })],
    bpDiastolic: [reading("bpDiastolic", 80, HOUR, { sampleId: "S" })],
  });
  const alerts = deepFreeze([alert("ALT-1", "warning", "new"), alert("ALT-2", "critical", "new")]);
  const s = deepFreeze(session());
  const before = JSON.stringify({ measurements, alerts, s });
  const r = await fakeService({ measurements, alerts, sleepSummaries: deepFreeze([{ astronautId: "a-01", date: "2026-11-14", avg: 7, count: 1 }]) })
    .getAstronautOverview(s, { now: NOW });
  assert.equal(r.status, "ready");
  assert.equal(JSON.stringify({ measurements, alerts, s }), before);
});

test("mission context comes from the mission service and production export is bound to the real database", async () => {
  const r = await seededService().service.getAstronautOverview(session(), { now: NOW });
  assert.deepEqual(r.mission, { available: true, name: "ODYSSEY-7", missionDay: 147 });
  // The production function has no repository parameter; in Node (no IndexedDB) it fails safely.
  assert.equal(svc.getAstronautOverview.length, 2);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const prod = await svc.getAstronautOverview(session(), { now: NOW, repos: fakeRepos() });
    assert.deepEqual({ status: prod.status, reason: prod.reason }, { status: "unavailable", reason: "database_error" }, "options.repos is ignored");
  } finally {
    console.warn = warn;
  }
});

test("23. the Overview page imports no database module and only the production service function", () => {
  const page = read("js/pages/astronaut-overview.js");
  const imports = [...page.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const path of imports) assert.doesNotMatch(path, /\/db\//, path);
  assert.doesNotMatch(page, /createAstronautOverviewService|mock-repositories|indexedDB|innerHTML/);
  assert.match(page, /import \{ getAstronautOverview \} from "\.\.\/services\/astronaut-overview-service\.js"/);
});

// =================================================================================
// Message senders are verified, never assumed
// =================================================================================

const ASTRONAUT_SENDER = Object.freeze({ id: "u-chen", username: "chen", displayName: "Mei Chen", role: "astronaut", astronautId: "a-03" });

test("messages: a verified medical_officer message is shown (seeded haddad and hand-built)", async () => {
  const seeded = await seededService().service.getAstronautOverview(session(), { now: NOW });
  assert.equal(seeded.messages.latest.from, "Medical Officer");
  assert.match(seeded.messages.latest.body, /vital-signs reading/);
  const r = await fakeService({ messages: [msg({ body: "Verified" })] }).getAstronautOverview(session(), { now: NOW });
  assert.deepEqual(r.messages, { status: "ok", latest: { sentAt: NOW - HOUR, body: "Verified", from: "Medical Officer" }, moreCount: 0 });
});

test("messages: astronaut-authored, unknown, invalid-role and astronaut-linked 'officer' senders are excluded", async () => {
  const cases = {
    "astronaut sender": { users: { [ASTRONAUT_SENDER.id]: ASTRONAUT_SENDER }, from: ASTRONAUT_SENDER.id },
    "unknown sender": { users: {}, from: "u-ghost" },
    "invalid role": { users: { "u-x": { id: "u-x", role: "medical-officer", astronautId: "" } }, from: "u-x" },
    "admin role": { users: { "u-y": { id: "u-y", role: "admin", astronautId: "" } }, from: "u-y" },
    "officer linked to an astronaut": { users: { "u-z": { id: "u-z", role: "medical_officer", astronautId: "a-02" } }, from: "u-z" },
    "lookup returns a different id": { users: { "u-w": { ...MO, id: "u-other" } }, from: "u-w" },
    "the astronaut themself": { users: {}, from: USER.id },
  };
  for (const [name, { users, from }] of Object.entries(cases)) {
    const r = await fakeService({ users, messages: [msg({ fromUserId: from, body: "Not from the MO" })] }).getAstronautOverview(session(), { now: NOW });
    assert.deepEqual(r.messages, { status: "ok", latest: null, moreCount: 0 }, name);
  }
  // A verified message is still chosen when a newer unverified one exists; counts only verified ones.
  const mixed = await fakeService({
    users: { [MO.id]: MO, [ASTRONAUT_SENDER.id]: ASTRONAUT_SENDER },
    messages: [
      msg({ fromUserId: ASTRONAUT_SENDER.id, sentAt: NOW - 10 * 60 * 1000, body: "from an astronaut" }),
      msg({ sentAt: NOW - HOUR, body: "officer newest" }),
      msg({ sentAt: NOW - 2 * HOUR, body: "officer older" }),
    ],
  }).getAstronautOverview(session(), { now: NOW });
  assert.deepEqual({ body: mixed.messages.latest.body, more: mixed.messages.moreCount }, { body: "officer newest", more: 1 });
});

test("messages: malformed fromUserId, other astronaut, acknowledged and invalid sentAt are rejected before any sender lookup", async () => {
  const lookups = [];
  const r = await fakeService({
    lookups,
    messages: [
      msg({ astronautId: "a-03", fromUserId: "u-for-other-astronaut" }),
      msg({ acknowledgedAt: NOW, fromUserId: "u-acknowledged" }),
      msg({ sentAt: "yesterday", fromUserId: "u-bad-time" }),
      msg({ sentAt: NaN, fromUserId: "u-nan-time" }),
      msg({ fromUserId: "" }),
      msg({ fromUserId: 42 }),
      msg({ fromUserId: null }),
    ],
  }).getAstronautOverview(session(), { now: NOW });
  assert.deepEqual(r.messages, { status: "ok", latest: null, moreCount: 0 });
  assert.deepEqual(lookups, [USER.id], "only the identity check looked up a user");
});

test("messages: duplicate senders are looked up once, after identity validation", async () => {
  const lookups = [];
  const r = await fakeService({
    lookups,
    messages: [msg({ sentAt: NOW - HOUR }), msg({ sentAt: NOW - 2 * HOUR }), msg({ sentAt: NOW - 3 * HOUR })],
  }).getAstronautOverview(session(), { now: NOW });
  assert.equal(r.messages.moreCount, 2);
  assert.deepEqual(lookups, [USER.id, MO.id], "identity first, then one lookup per distinct sender");
  // No message lookup at all when identity fails.
  const refused = [];
  const bad = await fakeService({ lookups: refused, messages: [msg()] }).getAstronautOverview(session({ astronautId: "a-03" }), { now: NOW });
  assert.equal(bad.reason, "account_mismatch");
  assert.deepEqual(refused, [USER.id]);
});

test("messages: a failed sender lookup marks only the messages section as error", async () => {
  const r = await fakeService({
    fail: { senders: true },
    messages: [msg()],
    measurements: { heartRate: [reading("heartRate", 70, HOUR)], sleepDuration: [reading("sleepDuration", 7, 8 * HOUR)] },
    alerts: [alert("ALT-1", "warning", "new")],
    checkin: { astronautId: "a-01", timestamp: NOW - HOUR, sharedWithMedical: 1 },
    sleepSummaries: [{ astronautId: "a-01", date: "2026-11-14", avg: 7, count: 1 }],
  }).getAstronautOverview(session(), { now: NOW });
  assert.equal(r.status, "ready");
  assert.deepEqual(r.messages, { status: "error", latest: null, moreCount: 0 });
  assert.equal(vital(r, "heartRate").value, 70, "vitals still visible");
  assert.equal(r.alerts.status, "ok");
  assert.equal(r.overall.level, "watch", "alerts still visible");
  assert.equal(r.routine.status, "ok");
  assert.equal(r.routine.checkin.state, "done", "routine still visible");
  assert.equal(r.sleep.status, "ok");
  assert.equal(r.sleep.recorded, 1, "sleep still visible");
});

test("messages: no sender id (or any user id) reaches the page", async () => {
  const r = await seededService().service.getAstronautOverview(session(), { now: NOW });
  assert.deepEqual(Object.keys(r.messages.latest).sort(), ["body", "from", "sentAt"]);
  const json = JSON.stringify(r);
  for (const id of ["u-medofficer", "u-medbackup", "u-haddad", "fromUserId", "userId"]) assert.ok(!json.includes(id), id);
});
