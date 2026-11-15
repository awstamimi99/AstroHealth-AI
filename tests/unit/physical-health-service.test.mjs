// tests/unit/physical-health-service.test.mjs — Sprint 6 access control + Physical Health.
// Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

globalThis.self = globalThis;
globalThis.BroadcastChannel = class { postMessage() {} addEventListener() {} close() {} };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const code = (p) => read(p).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

const access = await import("../../js/services/access-control.js");
const svc = await import("../../js/services/physical-health-service.js");
const mock = await import("../../js/db/mock-repositories.js");

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 14, 15, 30);
const REYES = Object.freeze({ role: "astronaut", userId: "u-reyes", astronautId: "a-04" });
const HADDAD = Object.freeze({ role: "astronaut", userId: "u-haddad", astronautId: "a-01" });
const MO = Object.freeze({ role: "medical_officer", userId: "u-medofficer", astronautId: "" });
const BANNED = /\b(healthy|unhealthy|safe\b|normal|abnormal|diagnos|medically cleared|fit for duty|risk score|health score)/i;

function spy(repos) {
  const calls = [];
  const wrapped = {};
  for (const [name, repo] of Object.entries(repos)) {
    wrapped[name] = new Proxy(repo, { get(t, p) { const v = t[p]; return typeof v !== "function" ? v : (...a) => { calls.push({ repo: name, method: String(p), args: a }); return v.apply(t, a); }; } });
  }
  return { repos: wrapped, calls };
}
const mockRepos = () => ({ usersRepo: mock.usersRepo, astronautsRepo: mock.astronautsRepo, measurementsRepo: mock.measurementsRepo, dailySummariesRepo: mock.dailySummariesRepo, alertsRepo: mock.alertsRepo });
const seeded = () => { const s = spy(mockRepos()); return { ...s, service: svc.createPhysicalHealthService({ repos: s.repos }) }; };

// ---- Hand-built fake repositories ---------------------------------------------------
const ASTRO = Object.freeze({ id: "a-01", crewId: "AH-01", name: "Crew One", missionRole: "Commander", baseline: { heartRate: 72, spo2: 98, bpSystolic: 118, bpDiastolic: 76, sleepDuration: 7 } });
const USER = Object.freeze({ id: "u-1", role: "astronaut", astronautId: "a-01", displayName: "Crew One" });
const SESSION = Object.freeze({ role: "astronaut", userId: "u-1", astronautId: "a-01" });
let seq = 0;
const reading = (metric, value, ago, extra = {}) => ({ id: `m${++seq}`, astronautId: "a-01", metric, value, unit: { heartRate: "bpm", spo2: "%", bpSystolic: "mmHg", bpDiastolic: "mmHg", sleepDuration: "h" }[metric], timestamp: NOW - ago, source: "seed", quality: "ok", sampleId: `s${seq}`, ...extra });
const summary = (metric, date, avg, extra = {}) => ({ astronautId: "a-01", metric, date, avg, min: avg - 2, max: avg + 2, count: 4, ...extra });
function fakeRepos({ readings = {}, summaries = [], alerts = [], fail = {} } = {}) {
  const maybe = (k, v) => (fail[k] ? Promise.reject(new Error(k)) : Promise.resolve(v));
  return {
    usersRepo: { getById: (id) => maybe("user", id === USER.id ? USER : null) },
    astronautsRepo: { getById: (id) => maybe("astro", id === ASTRO.id ? ASTRO : null), getByCrewId: (c) => maybe("astro", c === ASTRO.crewId ? ASTRO : null), getAll: () => maybe("all", [ASTRO]) },
    measurementsRepo: { getRecent: (aid, metric) => maybe(`m:${metric}`, readings[metric] || []) },
    dailySummariesRepo: { getRange: (aid, metric) => maybe(`s:${metric}`, summaries.filter((s) => s.metric === metric)) },
    alertsRepo: { query: () => maybe("alerts", alerts) },
  };
}
const fake = (o) => svc.createPhysicalHealthService({ repos: fakeRepos(o) });
const card = (r, key) => r.latest.items.find((i) => i.key === key);

await mock.resetMock({ now: NOW });

// ===================================================================================
// Authorization (access-control.js)
// ===================================================================================

test("1–2. missing or wrong-role sessions are refused before any data read", async () => {
  for (const [session, reason] of [[null, "no_session"], ["x", "no_session"], [MO, "not_astronaut"], [{ ...REYES, role: "medical-officer" }, "not_astronaut"], [{ ...REYES, astronautId: "" }, "invalid_session"]]) {
    const { service, calls } = seeded();
    const r = await service.getOwnPhysicalHealth(session, { now: NOW });
    assert.deepEqual({ status: r.status, reason: r.reason }, { status: "forbidden", reason }, JSON.stringify(session));
    assert.equal(calls.length, 0);
  }
  for (const [session, reason] of [[null, "no_session"], [REYES, "not_medical_officer"], [{ ...MO, astronautId: "a-01" }, "invalid_session"]]) {
    const { service, calls } = seeded();
    const r = await service.getCrewMemberPhysicalHealth(session, "AH-01", { now: NOW });
    assert.deepEqual({ status: r.status, reason: r.reason }, { status: "forbidden", reason });
    assert.equal(calls.length, 0);
    const picker = await service.listCrewForPhysicalSelection(session);
    assert.equal(picker.status, "forbidden");
  }
});

test("3. stored-account mismatches are refused after only the identity lookup", async () => {
  for (const session of [{ ...REYES, astronautId: "a-01" }, { ...REYES, userId: "u-haddad" }, { ...REYES, userId: "u-medofficer" }, { ...MO, userId: "u-reyes" }]) {
    const { service, calls } = seeded();
    const r = session.role === "astronaut" ? await service.getOwnPhysicalHealth(session, { now: NOW }) : await service.getCrewMemberPhysicalHealth(session, "AH-01", { now: NOW });
    assert.deepEqual({ status: r.status, reason: r.reason }, { status: "forbidden", reason: "account_mismatch" }, JSON.stringify(session));
    assert.deepEqual(calls.map((c) => c.repo), ["usersRepo"]);
  }
  const missing = await svc.createPhysicalHealthService({ repos: { ...fakeRepos(), astronautsRepo: { getById: async () => null } } }).getOwnPhysicalHealth(SESSION, { now: NOW });
  assert.deepEqual({ status: missing.status, reason: missing.reason }, { status: "unavailable", reason: "profile_missing" });
});

test("4 + 7. an astronaut can't override their astronaut id or read another astronaut", async () => {
  const { service, calls } = seeded();
  const r = await service.getOwnPhysicalHealth(REYES, { now: NOW, astronautId: "a-01", crewId: "AH-01" });
  assert.equal(r.profile.crewId, "AH-04");
  for (const c of calls.filter((x) => x.repo !== "usersRepo")) {
    const asked = c.repo === "alertsRepo" ? c.args[0].astronautId : c.args[0];
    assert.equal(asked, "a-04", `${c.repo}.${c.method}`);
  }
  // Foreign records returned by a faulty repository are dropped.
  const foreign = { astronautId: "a-09" };
  const f = await fake({ readings: { heartRate: [reading("heartRate", 70, 2 * HOUR), reading("heartRate", 150, HOUR, foreign)] }, summaries: [summary("heartRate", "2026-11-14", 99, foreign)], alerts: [{ astronautId: "a-09", number: "ALT-9", severity: "critical", status: "new", category: "physical" }] }).getOwnPhysicalHealth(SESSION, { now: NOW });
  assert.equal(card(f, "heartRate").value, 70);
  assert.equal(f.trends.metrics[0].windows[7].daysWithData, 0);
  assert.deepEqual(f.alerts.items, []);
});

test("5–6. the officer is verified before crew resolution; invalid and unknown crew IDs are not found", async () => {
  const { service, calls } = seeded();
  await service.getCrewMemberPhysicalHealth(MO, "AH-03", { now: NOW });
  assert.deepEqual(calls.slice(0, 2).map((c) => `${c.repo}.${c.method}`), ["usersRepo.getById", "astronautsRepo.getByCrewId"]);
  for (const id of ["a-01", "AH-1", "ah-01", "AH-001", " AH-01", "", null, 1]) {
    const s = seeded();
    const r = await s.service.getCrewMemberPhysicalHealth(MO, id, { now: NOW });
    assert.deepEqual({ status: r.status, reason: r.reason }, { status: "not_found", reason: "invalid_crew_id" }, String(id));
    assert.deepEqual(s.calls.map((c) => c.repo), ["usersRepo"]);
  }
  const unknown = await seeded().service.getCrewMemberPhysicalHealth(MO, "AH-99", { now: NOW });
  assert.deepEqual({ status: unknown.status, reason: unknown.reason }, { status: "not_found", reason: "unknown_crew_id" });
  const repos = fakeRepos();
  repos.usersRepo.getById = async (id) => (id === "u-mo" ? { id: "u-mo", role: "medical_officer", astronautId: "" } : null);
  repos.astronautsRepo.getByCrewId = async () => ({ ...ASTRO, crewId: "AH-02" });
  const mismatch = await svc.createPhysicalHealthService({ repos }).getCrewMemberPhysicalHealth({ role: "medical_officer", userId: "u-mo", astronautId: "" }, "AH-01", { now: NOW });
  assert.equal(mismatch.status, "not_found", "returned crewId must match");
});

test("access-control returns safe objects (no raw user, no password material)", async () => {
  const who = await access.verifyAstronaut(REYES, mockRepos(), NOW);
  assert.equal(who.ok, true);
  assert.deepEqual(Object.keys(who.user).sort(), ["displayName", "id"]);
  assert.deepEqual(Object.keys(who.astronaut).sort(), ["baseline", "crewId", "id", "missionRole", "name"]);
  const picker = await access.listCrewForSelection(MO, mockRepos(), NOW);
  assert.deepEqual(picker.crew, [{ crewId: "AH-01", name: "Sami Haddad" }, { crewId: "AH-02", name: "Aisha Karim" }, { crewId: "AH-03", name: "Mei Chen" }, { crewId: "AH-04", name: "Jonas Reyes" }]);
});

// ===================================================================================
// Physical data
// ===================================================================================

test("8–13. latest readings: newest usable, invalid excluded, suspect/stale labelled, BP paired by sampleId, missing stays missing", async () => {
  const r = await fake({
    readings: {
      heartRate: [reading("heartRate", 64, 3 * HOUR), reading("heartRate", 250, HOUR, { quality: "invalid" })],
      spo2: [reading("spo2", 91, HOUR, { quality: "suspect" })],
      sleepDuration: [reading("sleepDuration", 6, 40 * HOUR)],
      bpSystolic: [reading("bpSystolic", 121, 2 * HOUR, { sampleId: "S1" }), reading("bpSystolic", 150, HOUR, { sampleId: "S2" })],
      bpDiastolic: [reading("bpDiastolic", 78, 2 * HOUR, { sampleId: "S1" })],
    },
  }).getOwnPhysicalHealth(SESSION, { now: NOW });
  assert.equal(card(r, "heartRate").value, 64);
  assert.deepEqual([card(r, "spo2").quality, card(r, "spo2").value], ["suspect", 91]);
  assert.equal(card(r, "sleepDuration").stale, true);
  assert.deepEqual([card(r, "bloodPressure").systolic, card(r, "bloodPressure").diastolic], [121, 78], "S2 has no diastolic → not combined");
  const empty = await fake().getOwnPhysicalHealth(SESSION, { now: NOW });
  assert.ok(empty.latest.items.every((i) => i.state === "empty" && i.value === undefined));
  assert.ok(empty.quality.items.every((q) => q.state === "empty"));
});

test("14–15. trends: scoped, 30 UTC days oldest first, missing days marked, deterministic 7/30 windows", async () => {
  const summaries = [summary("heartRate", "2026-11-14", 70), summary("heartRate", "2026-11-12", 74), summary("heartRate", "2026-10-20", 60), summary("heartRate", "2026-10-10", 10)];
  const r = await fake({ summaries }).getOwnPhysicalHealth(SESSION, { now: NOW });
  const hr = r.trends.metrics.find((m) => m.key === "heartRate");
  assert.equal(hr.days.length, 30);
  assert.equal(hr.days[0].date, "2026-10-16");
  assert.equal(hr.days[29].date, "2026-11-14");
  assert.deepEqual(hr.days.find((d) => d.date === "2026-11-13"), { date: "2026-11-13", missing: true });
  assert.deepEqual(hr.windows[7], { days: 7, daysWithData: 2, missingDays: 5, average: 72, differenceFromBaseline: 0 });
  assert.deepEqual(hr.windows[30], { days: 30, daysWithData: 3, missingDays: 27, average: 68, differenceFromBaseline: -4 });
  const again = await fake({ summaries: [...summaries].reverse() }).getOwnPhysicalHealth(SESSION, { now: NOW });
  assert.deepEqual(again.trends.metrics[0], hr);
  assert.deepEqual(r.trends.metrics.map((m) => m.key), ["heartRate", "spo2", "bpSystolic", "bpDiastolic", "sleepDuration", "bodyTemperature"]);
  assert.match(r.trends.note, /include readings marked suspect; invalid readings are excluded/);
});

test("16. baseline comparison is a number only, never a category", async () => {
  const r = await fake({ readings: { heartRate: [reading("heartRate", 76, HOUR)], sleepDuration: [reading("sleepDuration", 6.2, 8 * HOUR)], bpSystolic: [reading("bpSystolic", 121, HOUR, { sampleId: "S" })], bpDiastolic: [reading("bpDiastolic", 74, HOUR, { sampleId: "S" })] } }).getOwnPhysicalHealth(SESSION, { now: NOW });
  assert.equal(card(r, "heartRate").differenceFromBaseline, 4);
  assert.equal(card(r, "sleepDuration").differenceFromBaseline, -0.8);
  assert.deepEqual(card(r, "bloodPressure").differenceFromBaseline, { systolic: 3, diastolic: -2 });
  assert.equal(svc.baselineDifference(70, null), null);
  assert.match(r.baselineNote, /not a clinical assessment/);
  assert.doesNotMatch(JSON.stringify(r), BANNED);
});

test("17–18. alerts: selected astronaut, open, physical category only; resolved excluded", async () => {
  const a = (number, extra) => ({ astronautId: "a-01", number, severity: "warning", status: "new", category: "physical", detectedAt: NOW - HOUR, title: number, explanation: "", ...extra });
  const r = await fake({ alerts: [a("ALT-1"), a("ALT-2", { category: "wellbeing" }), a("ALT-3", { status: "resolved" }), a("ALT-4", { status: "acknowledged", severity: "critical" })] }).getOwnPhysicalHealth(SESSION, { now: NOW });
  assert.deepEqual(r.alerts.items.map((x) => x.number), ["ALT-4", "ALT-1"]);
  const reyes = await seeded().service.getOwnPhysicalHealth(REYES, { now: NOW });
  assert.deepEqual(reyes.alerts.items.map((x) => x.number), ["ALT-0190"]);
  const chen = await seeded().service.getCrewMemberPhysicalHealth(MO, "AH-03", { now: NOW });
  assert.deepEqual(chen.alerts.items, [], "ALT-0189 is a wellbeing alert");
  const haddad = await seeded().service.getOwnPhysicalHealth(HADDAD, { now: NOW });
  assert.ok(!JSON.stringify(haddad).includes("ALT-0181"), "resolved");
});

test("19. a failed section keeps the others", async () => {
  const r = await fake({ readings: { heartRate: [reading("heartRate", 70, HOUR)] }, fail: { "m:spo2": true, "s:sleepDuration": true, alerts: true } }).getOwnPhysicalHealth(SESSION, { now: NOW });
  assert.equal(r.status, "ready");
  assert.equal(r.latest.status, "partial");
  assert.equal(card(r, "spo2").state, "error");
  assert.equal(card(r, "heartRate").value, 70);
  assert.equal(r.trends.metrics.find((m) => m.key === "sleepDuration").status, "error");
  assert.equal(r.trends.metrics.find((m) => m.key === "heartRate").status, "ok");
  assert.equal(r.alerts.status, "error");
  assert.equal(r.quality.items.find((q) => q.key === "sleepDuration").missingDays30, null);
});

test("20. no daily steps / activity anywhere; no writes; no journal", () => {
  for (const file of ["js/services/physical-health-service.js", "js/pages/physical-health.js", "js/components/health-view.js"]) {
    const src = code(file);
    assert.doesNotMatch(src, /activity|steps/i, file);
    assert.doesNotMatch(src, /journalRepo|privateJournal|eventsRepo|withTransaction|Repo\.(add|update|set|upsert)\(/, file);
  }
});

test("seeded: the officer view of Reyes matches Reyes's own view (same data, different viewer)", async () => {
  const own = await seeded().service.getOwnPhysicalHealth(REYES, { now: NOW });
  const officer = await seeded().service.getCrewMemberPhysicalHealth(MO, "AH-04", { now: NOW });
  assert.equal(own.viewer, "astronaut");
  assert.equal(officer.viewer, "officer");
  assert.deepEqual({ ...officer, viewer: "x" }, { ...own, viewer: "x" });
  const json = JSON.stringify(own);
  for (const bad of ['"a-0', "u-reyes", "msr_", "sampleId", "createdBy", "passwordHash"]) assert.ok(!json.includes(bad), bad);
});

test("inputs and repository records are not mutated", async () => {
  const deepFreeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
  const opts = deepFreeze({ readings: { heartRate: [reading("heartRate", 70, HOUR)] }, summaries: [summary("heartRate", "2026-11-14", 70)], alerts: [{ astronautId: "a-01", number: "A", severity: "info", status: "new", category: "physical", detectedAt: NOW }] });
  const before = JSON.stringify(opts);
  assert.equal((await fake(opts).getOwnPhysicalHealth(deepFreeze({ ...SESSION }), { now: NOW })).status, "ready");
  assert.equal(JSON.stringify(opts), before);
});
