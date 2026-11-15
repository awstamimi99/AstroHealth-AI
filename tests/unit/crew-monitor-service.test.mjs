// tests/unit/crew-monitor-service.test.mjs — Sprint 5 Medical Officer crew service.
// Seeded in-memory mock (same seed as the real database) + small hand-built
// fake crews for edge cases. Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

globalThis.self = globalThis;
globalThis.BroadcastChannel = class { postMessage() {} addEventListener() {} close() {} };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

const svc = await import("../../js/services/crew-monitor-service.js");
const mock = await import("../../js/db/mock-repositories.js");
const { describeMission } = await import("../../js/services/mission-service.js");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 14, 15, 30);

const MO_SESSION = Object.freeze({ version: 1, userId: "u-medofficer", username: "medofficer", displayName: "Dr. Lena Ortiz", role: "medical_officer", astronautId: "", createdAt: NOW - HOUR, expiresAt: NOW + HOUR });
const BACKUP_SESSION = Object.freeze({ ...MO_SESSION, userId: "u-medbackup", username: "medbackup", displayName: "Medical Officer (backup)" });
const ASTRONAUT_SESSION = Object.freeze({ ...MO_SESSION, userId: "u-haddad", username: "haddad", role: "astronaut", astronautId: "a-01" });
const BANNED = /\b(healthy|safe\b|normal health|medically cleared|fit for duty|no health risk|health score|nominal|diagnos)/i;

/** Wrap repositories so every call is recorded. */
function spy(repos) {
  const calls = [];
  const wrapped = {};
  for (const [name, repo] of Object.entries(repos)) {
    wrapped[name] = new Proxy(repo, {
      get(target, prop) {
        const value = target[prop];
        if (typeof value !== "function") return value;
        return (...args) => { calls.push({ repo: name, method: String(prop), args }); return value.apply(target, args); };
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
function seeded() {
  const s = spy(mockRepos());
  return { ...s, service: svc.createCrewMonitorService({ repos: s.repos, getMissionContext: async () => describeMission(await mock.settingsRepo.get("mission"), NOW) }) };
}
const HEALTH_REPOS = ["astronautsRepo", "measurementsRepo", "dailySummariesRepo", "alertsRepo", "messagesRepo", "wellbeingRepo", "cognitiveRepo"];

// ---- Hand-built fake crew --------------------------------------------------------------
const MO = Object.freeze({ id: "u-mo", role: "medical_officer", astronautId: "", displayName: "Dr. Test" });
const MO_FAKE_SESSION = Object.freeze({ role: "medical_officer", userId: "u-mo", astronautId: "" });
const astronaut = (n, extra = {}) => ({
  id: `a-0${n}`, crewId: `AH-0${n}`, name: `Crew ${n}`, missionRole: "Specialist", initials: `C${n}`,
  baseline: { heartRate: 70, spo2: 98, bpSystolic: 118, bpDiastolic: 76, sleepDuration: 7 }, latest: {}, ...extra,
});
let seq = 0;
const reading = (aid, metric, value, ago, extra = {}) => ({
  id: `msr_${++seq}`, astronautId: aid, metric, value, unit: { heartRate: "bpm", spo2: "%", bpSystolic: "mmHg", bpDiastolic: "mmHg", sleepDuration: "h" }[metric],
  timestamp: NOW - ago, source: "seed", quality: "ok", sampleId: `smp_${seq}`, simulationRunId: "", ...extra,
});
/** Fresh readings for every list vital, so "Data needs review" only appears when a test wants it. */
const freshVitals = (aid) => ({ heartRate: [reading(aid, "heartRate", 70, HOUR)], spo2: [reading(aid, "spo2", 98, HOUR)], sleepDuration: [reading(aid, "sleepDuration", 7, 8 * HOUR)] });
const alert = (aid, number, severity, status, extra = {}) => ({
  id: `alr_${number}`, number, astronautId: aid, ruleId: "R", type: "test_alert", category: "physical",
  severity, status, title: `${severity} alert`, detectedAt: NOW - HOUR, explanation: "Because.", ...extra,
});

function fakeRepos({
  officer = MO, crew = [astronaut(1), astronaut(2)], users = {}, measurements = {}, alerts = [], shared = [],
  messages = {}, cognitive = [], summaries = [], fail = {}, lookups = [],
} = {}) {
  const maybe = (key, value) => (fail[key] ? Promise.reject(new Error(`${key} failed`)) : Promise.resolve(value));
  const vitalsFor = (aid) => ({ ...freshVitals(aid), ...(measurements[aid] || {}) });
  return {
    usersRepo: { getById: (id) => { lookups.push(id); if (officer && id === officer.id) return maybe("officer", officer); return maybe("senders", users[id] ?? null); } },
    astronautsRepo: {
      getAll: () => maybe("crew", crew),
      getByCrewId: (crewId) => maybe("byCrewId", crew.find((a) => a.crewId === crewId) ?? null),
    },
    measurementsRepo: { getRecent: (aid, metric) => maybe(`m:${aid}:${metric}`, vitalsFor(aid)[metric] || []) },
    dailySummariesRepo: { getRange: () => maybe("summaries", summaries) },
    alertsRepo: { query: () => maybe("alerts", alerts) },
    messagesRepo: { getByAstronaut: (aid) => maybe(`messages:${aid}`, messages[aid] || []) },
    wellbeingRepo: { getSharedRange: () => maybe("shared", shared) },
    cognitiveRepo: { getRange: () => maybe("cognitive", cognitive) },
  };
}
const fake = (opts) => svc.createCrewMonitorService({ repos: fakeRepos(opts), getMissionContext: async () => ({ available: true, name: "TEST-1", missionDay: 3 }) });
const member = (snapshot, crewId) => snapshot.crew.find((m) => m.crewId === crewId);

await mock.resetMock({ now: NOW });

// =====================================================================================
// Authorization
// =====================================================================================

test("1–2. missing/malformed sessions and astronaut sessions are refused before any health read", async () => {
  const cases = [
    [null, "no_session"], [undefined, "no_session"], ["medofficer", "no_session"],
    [ASTRONAUT_SESSION, "not_medical_officer"], [{ ...MO_SESSION, role: "medical-officer" }, "not_medical_officer"], [{ ...MO_SESSION, role: "admin" }, "not_medical_officer"],
    [{ ...MO_SESSION, userId: "" }, "invalid_session"], [{ ...MO_SESSION, astronautId: "a-01" }, "invalid_session"],
  ];
  for (const [session, reason] of cases) {
    for (const call of [(s) => s.getCrewSnapshot(session, { now: NOW }), (s) => s.getCrewMemberDetail(session, "AH-01", { now: NOW })]) {
      const { service, calls } = seeded();
      const r = await call(service);
      assert.deepEqual({ status: r.status, reason: r.reason }, { status: "forbidden", reason }, JSON.stringify(session));
      assert.equal(calls.length, 0, "no repository call at all");
      assert.equal(r.crew, undefined);
    }
  }
});

test("3–4. a stored-account mismatch, or an officer with an astronautId, is refused after only the identity lookup", async () => {
  const cases = [
    { ...MO_SESSION, userId: "u-haddad" },   // an astronaut's user id
    { ...MO_SESSION, userId: "u-nobody" },   // unknown user
  ];
  for (const session of cases) {
    const { service, calls } = seeded();
    const r = await service.getCrewSnapshot(session, { now: NOW });
    assert.deepEqual({ status: r.status, reason: r.reason }, { status: "forbidden", reason: "account_mismatch" });
    assert.deepEqual(calls.map((c) => `${c.repo}.${c.method}`), ["usersRepo.getById"]);
  }
  for (const officer of [{ ...MO, astronautId: "a-01" }, { ...MO, role: "astronaut" }, { ...MO, id: "u-other" }]) {
    const lookups = [];
    const repos = fakeRepos({ officer: { ...officer, id: officer.id === "u-other" ? "u-other" : "u-mo" }, lookups });
    if (officer.id === "u-other") repos.usersRepo.getById = (id) => { lookups.push(id); return Promise.resolve({ ...officer }); };
    const r = await svc.createCrewMonitorService({ repos, getMissionContext: async () => null }).getCrewSnapshot(MO_FAKE_SESSION, { now: NOW });
    assert.deepEqual({ status: r.status, reason: r.reason }, { status: "forbidden", reason: "account_mismatch" }, JSON.stringify(officer));
    assert.deepEqual(lookups, ["u-mo"]);
  }
  const r = await fake({ fail: { officer: true } }).getCrewSnapshot(MO_FAKE_SESSION, { now: NOW });
  assert.deepEqual({ status: r.status, reason: r.reason }, { status: "unavailable", reason: "database_error" });
});

test("5–7. both seeded Medical Officer accounts read the snapshot; every astronaut appears exactly once", async () => {
  for (const session of [MO_SESSION, BACKUP_SESSION]) {
    const { service, calls } = seeded();
    const r = await service.getCrewSnapshot(session, { now: NOW });
    assert.equal(r.status, "ready", session.username);
    assert.deepEqual(r.crew.map((m) => m.crewId).sort(), ["AH-01", "AH-02", "AH-03", "AH-04"]);
    assert.equal(new Set(r.crew.map((m) => m.crewId)).size, 4);
    assert.equal(r.summary.crewCount, 4);
    assert.equal(calls[0].repo, "usersRepo", "identity check first");
    assert.ok(calls.slice(1).some((c) => HEALTH_REPOS.includes(c.repo)));
  }
  const dup = await fake({ crew: [astronaut(1), astronaut(1), astronaut(2), { id: "x", crewId: "BAD" }] }).getCrewSnapshot(MO_FAKE_SESSION, { now: NOW });
  assert.deepEqual(dup.crew.map((m) => m.crewId), ["AH-01", "AH-02"], "duplicates and malformed profiles dropped");
});

// =====================================================================================
// Ranking and status
// =====================================================================================

test("8. seeded order: Reyes (Watch) before Chen (Info), then Haddad and Karim; deterministic across runs", async () => {
  const first = await seeded().service.getCrewSnapshot(MO_SESSION, { now: NOW });
  assert.deepEqual(first.crew.map((m) => [m.crewId, m.state.label]), [["AH-04", "Watch"], ["AH-03", "Info"], ["AH-01", "No open alerts"], ["AH-02", "No open alerts"]]);
  assert.deepEqual(first.summary, { crewCount: 4, withOpenAlerts: 2, critical: 0, watch: 1, info: 1, unavailable: 0, dataNeedsReview: 0, noOpenAlerts: 2, alertsBySeverity: { info: 1, warning: 1, critical: 0 } });
  const again = await seeded().service.getCrewSnapshot(MO_SESSION, { now: NOW });
  assert.deepEqual(again.crew.map((m) => m.crewId), first.crew.map((m) => m.crewId));
  // Input order doesn't matter.
  const crew = [astronaut(3), astronaut(1), astronaut(2)];
  const order = async (c) => (await fake({ crew: c, alerts: [alert("a-02", "ALT-1", "info", "new")] }).getCrewSnapshot(MO_FAKE_SESSION, { now: NOW })).crew.map((m) => m.crewId);
  assert.deepEqual(await order(crew), await order([...crew].reverse()));
  assert.deepEqual(await order(crew), ["AH-02", "AH-01", "AH-03"]);
});

test("9–10. critical > watch > info > unavailable > data needs review > no open alerts; acknowledged stays open", async () => {
  const crew = [1, 2, 3, 4, 5].map((n) => astronaut(n));
  const r = await fake({
    crew,
    alerts: [
      alert("a-01", "ALT-1", "info", "new"),
      alert("a-02", "ALT-2", "warning", "acknowledged"),
      alert("a-03", "ALT-3", "critical", "acknowledged"),
      alert("a-03", "ALT-4", "info", "new"),
    ],
    measurements: { "a-04": { spo2: [reading("a-04", "spo2", 97, HOUR, { quality: "suspect" })] } },
  }).getCrewSnapshot(MO_FAKE_SESSION, { now: NOW });
  assert.deepEqual(r.crew.map((m) => [m.crewId, m.state.label]), [
    ["AH-03", "Critical alert"], ["AH-02", "Watch"], ["AH-01", "Info"], ["AH-04", "Data needs review"], ["AH-05", "No open alerts"],
  ]);
  assert.match(member(r, "AH-03").state.reason, /ALT-3 .*\(critical, acknowledged\) · 1 more open/);
  assert.equal(member(r, "AH-02").alerts.openCount, 1, "acknowledged counts as open");
  for (const m of r.crew) {
    assert.ok(m.state.icon && m.state.label && m.state.tone && m.state.reason, m.crewId);
    assert.equal(m.state.note, "Based on stored open alerts only. This is not a health assessment.");
  }
  assert.equal(member(r, "AH-03").state.tone, "critical");
  assert.equal(member(r, "AH-02").state.tone, "warning", "watch uses the warning token, never brand orange");
});

test("ties: unacknowledged first, then newest open alert, then more alerts, then crew ID", async () => {
  const crew = [1, 2, 3, 4].map((n) => astronaut(n));
  const r = await fake({
    crew,
    alerts: [
      alert("a-01", "ALT-1", "warning", "acknowledged", { detectedAt: NOW - 1 }),
      alert("a-02", "ALT-2", "warning", "new", { detectedAt: NOW - 5 * HOUR }),
      alert("a-03", "ALT-3", "warning", "acknowledged", { detectedAt: NOW - 2 * HOUR }),
      alert("a-04", "ALT-4", "warning", "acknowledged", { detectedAt: NOW - 2 * HOUR }),
      alert("a-04", "ALT-5", "warning", "acknowledged", { detectedAt: NOW - 3 * HOUR }),
    ],
  }).getCrewSnapshot(MO_FAKE_SESSION, { now: NOW });
  assert.deepEqual(r.crew.map((m) => m.crewId), ["AH-02", "AH-01", "AH-04", "AH-03"]);
});

test("11–12. resolved alerts are ignored; no alerts → 'No open alerts', never a health claim", async () => {
  const r = await fake({ alerts: [alert("a-01", "ALT-9", "critical", "resolved")] }).getCrewSnapshot(MO_FAKE_SESSION, { now: NOW });
  assert.deepEqual(r.crew.map((m) => m.state.label), ["No open alerts", "No open alerts"]);
  assert.equal(r.summary.withOpenAlerts, 0);
  assert.deepEqual(r.alerts.items, []);
  assert.doesNotMatch(JSON.stringify(r), BANNED);
  const seededSnap = await seeded().service.getCrewSnapshot(MO_SESSION, { now: NOW });
  assert.ok(!JSON.stringify(seededSnap).includes("ALT-0181") && !JSON.stringify(seededSnap).includes("ALT-0184"), "seeded resolved alerts absent");
});

test("13. a failed alert query → 'Status unavailable' for everyone, never 'No open alerts'", async () => {
  const r = await fake({ fail: { alerts: true } }).getCrewSnapshot(MO_FAKE_SESSION, { now: NOW });
  assert.equal(r.status, "ready");
  assert.deepEqual(r.crew.map((m) => m.state.label), ["Status unavailable", "Status unavailable"]);
  assert.equal(r.summary.withOpenAlerts, null);
  assert.equal(r.summary.unavailable, 2);
  assert.equal(r.alerts.status, "error");
  assert.ok(r.crew.every((m) => m.alerts.status === "error" && m.vitals.status === "ok"), "readings still shown");
  const d = await fake({ fail: { alerts: true } }).getCrewMemberDetail(MO_FAKE_SESSION, "AH-01", { now: NOW });
  assert.equal(d.state.label, "Status unavailable");
});

// =====================================================================================
// Readings
// =====================================================================================

test("14–16. invalid readings excluded; suspect and stale labelled as data issues, not diagnoses", async () => {
  const r = await fake({
    crew: [astronaut(1), astronaut(2), astronaut(3)],
    measurements: {
      "a-01": { heartRate: [reading("a-01", "heartRate", 64, 2 * HOUR), reading("a-01", "heartRate", 250, HOUR, { quality: "invalid" })] },
      "a-02": { heartRate: [reading("a-02", "heartRate", 150, HOUR, { quality: "suspect" })] },
      "a-03": { sleepDuration: [reading("a-03", "sleepDuration", 7, 40 * HOUR)], spo2: [] },
    },
  }).getCrewSnapshot(MO_FAKE_SESSION, { now: NOW });
  const hr1 = member(r, "AH-01").vitals.items.find((v) => v.key === "heartRate");
  assert.deepEqual({ value: hr1.value, quality: hr1.quality }, { value: 64, quality: "ok" });
  assert.equal(member(r, "AH-01").state.label, "No open alerts");
  const a2 = member(r, "AH-02");
  assert.equal(a2.state.label, "Data needs review");
  assert.equal(a2.state.tone, "neutral");
  assert.match(a2.state.reason, /Heart rate reading is marked suspect/);
  assert.match(a2.state.explanation, /data-quality note, not a medical warning/);
  const a3 = member(r, "AH-03");
  assert.equal(a3.vitals.items.find((v) => v.key === "sleepDuration").stale, true);
  assert.match(a3.state.reason, /Sleep duration reading is stale; .*No recent spo₂ reading|No recent spo₂ reading.*Sleep duration reading is stale/i);
  assert.doesNotMatch(JSON.stringify(r), BANNED);
  // List shows exactly HR, SpO₂, sleep (no blood pressure).
  assert.deepEqual(a3.vitals.items.map((v) => v.key), ["heartRate", "spo2", "sleepDuration"]);
});

// =====================================================================================
// Privacy
// =====================================================================================

test("17–18. private check-ins are never returned or counted, even if a repository returns them", async () => {
  const shared = (aid, ago, flag, extra = {}) => ({ id: `w${++seq}`, astronautId: aid, timestamp: NOW - ago, sharedWithMedical: flag, source: "seed", mood: 2, stress: 8, sleepQuality: 2, fatigue: 7, isolation: 6, wellbeing: 2, ...extra });
  const rows = [
    shared("a-01", 2 * HOUR, 1, { mood: 4 }),
    shared("a-01", HOUR, 0, { mood: 1 }),          // newer but PRIVATE
    shared("a-02", HOUR, "1"),                     // not exactly 1
    shared("a-02", 3 * HOUR, true),
    shared("a-09", HOUR, 1),                       // not a crew member
    shared("a-01", -HOUR, 1),                      // in the future
  ];
  const r = await fake({ shared: rows }).getCrewSnapshot(MO_FAKE_SESSION, { now: NOW });
  assert.equal(member(r, "AH-01").sharedWellbeing.lastSharedAt, NOW - 2 * HOUR, "private newer check-in ignored");
  assert.equal(member(r, "AH-02").sharedWellbeing.lastSharedAt, 0);
  assert.ok(!JSON.stringify(r).includes('"mood"'), "no scores in the snapshot");
  assert.equal(r.crew.length, 2);
  const d = await fake({ shared: rows }).getCrewMemberDetail(MO_FAKE_SESSION, "AH-01", { now: NOW });
  assert.equal(d.sharedWellbeing.items.length, 1);
  assert.equal(d.sharedWellbeing.items[0].mood, 4);
  assert.deepEqual(Object.keys(d.sharedWellbeing.items[0]).sort(), ["fatigue", "isolation", "mood", "sleepQuality", "stress", "timestamp", "wellbeing"]);
  // Seed: haddad has private check-ins; only shared ones (max 7) are returned.
  const seededDetail = await seeded().service.getCrewMemberDetail(MO_SESSION, "AH-01", { now: NOW });
  const sharedTimes = (await mock.wellbeingRepo.getRange("a-01")).filter((w) => w.sharedWithMedical === 1).map((w) => w.timestamp);
  const privateTimes = (await mock.wellbeingRepo.getRange("a-01")).filter((w) => w.sharedWithMedical === 0).map((w) => w.timestamp);
  assert.ok(privateTimes.length >= 1);
  assert.equal(seededDetail.sharedWellbeing.items.length, 7);
  for (const item of seededDetail.sharedWellbeing.items) {
    assert.ok(sharedTimes.includes(item.timestamp));
    assert.ok(!privateTimes.includes(item.timestamp));
  }
});

test("17b. the service reads wellbeing only through getSharedRange, never per-astronaut ranges", async () => {
  const { service, calls } = seeded();
  await service.getCrewSnapshot(MO_SESSION, { now: NOW });
  await service.getCrewMemberDetail(MO_SESSION, "AH-03", { now: NOW });
  const wellbeing = calls.filter((c) => c.repo === "wellbeingRepo").map((c) => c.method);
  assert.ok(wellbeing.length >= 2 && wellbeing.every((m) => m === "getSharedRange"), wellbeing.join());
});

test("19 + 32. no journal, no mission events, no reports/simulation/alert actions; read-only", () => {
  const source = read("js/services/crew-monitor-service.js");
  const code = source.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(code, /journalRepo|privateJournal|eventsRepo|missionEvents|reportsRepo|simulationRunsRepo|alertActionsRepo/);
  assert.doesNotMatch(code, /Repo\.(add|addMany|update|updateLatest|set|upsert)\(|withTransaction|"readwrite"/);
  const imports = [...source.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["../db/index.js", "./mission-service.js", "./astronaut-overview-service.js"]);
  const repoCalls = [...code.matchAll(/repos\.(\w+)\.(\w+)\(/g)].map((m) => `${m[1]}.${m[2]}`);
  assert.deepEqual([...new Set(repoCalls)].sort(), [
    "alertsRepo.query", "astronautsRepo.getAll", "astronautsRepo.getByCrewId", "cognitiveRepo.getRange", "dailySummariesRepo.getRange",
    "measurementsRepo.getRecent", "messagesRepo.getByAstronaut", "usersRepo.getById", "wellbeingRepo.getSharedRange",
  ]);
});

test("31. no user ids (officer, astronaut, sender) and no raw records appear in any output", async () => {
  const { service } = seeded();
  const outputs = [await service.getCrewSnapshot(MO_SESSION, { now: NOW }), ...(await Promise.all(["AH-01", "AH-02", "AH-03", "AH-04"].map((c) => service.getCrewMemberDetail(MO_SESSION, c, { now: NOW }))))];
  for (const out of outputs) {
    const json = JSON.stringify(out);
    for (const bad of ["u-medofficer", "u-medbackup", "u-haddad", "u-karim", "u-chen", "u-reyes", "fromUserId", "userId", "passwordHash", "salt", "sharedWithMedical", '"a-0', "alr_", "msg_", "msr_", "wba_"]) {
      assert.ok(!json.includes(bad), `${bad} leaked`);
    }
    assert.doesNotMatch(json, BANNED);
  }
});

// =====================================================================================
// Detail selection
// =====================================================================================

test("20–22. detail: crew member must exist; malformed ids are refused; selection can't bypass authorization", async () => {
  for (const crewId of ["AH-99", "AH-00"]) {
    const r = await seeded().service.getCrewMemberDetail(MO_SESSION, crewId, { now: NOW });
    assert.deepEqual({ status: r.status, reason: r.reason }, { status: "not_found", reason: "unknown_crew_id" }, crewId);
  }
  for (const crewId of ["a-01", "AH-1", "ah-01", "AH-001", " AH-01", "AH-01 ", "AH-01/x", "../AH-01", "", null, undefined, 1, { toString: () => "AH-01" }]) {
    const { service, calls } = seeded();
    const r = await service.getCrewMemberDetail(MO_SESSION, crewId, { now: NOW });
    assert.deepEqual({ status: r.status, reason: r.reason }, { status: "not_found", reason: "invalid_crew_id" }, String(crewId));
    assert.deepEqual(calls.map((c) => c.repo), ["usersRepo"], "only the officer check ran");
  }
  // A valid crew ID with a non-officer session reads nothing.
  for (const session of [ASTRONAUT_SESSION, { ...MO_SESSION, userId: "u-chen" }, null]) {
    const { service, calls } = seeded();
    const r = await service.getCrewMemberDetail(session, "AH-03", { now: NOW });
    assert.equal(r.status, "forbidden");
    assert.ok(calls.every((c) => c.repo === "usersRepo"));
  }
  // A crew id that resolves to a different crewId is refused.
  const repos = fakeRepos();
  repos.astronautsRepo.getByCrewId = async () => astronaut(2);
  const r = await svc.createCrewMonitorService({ repos, getMissionContext: async () => null }).getCrewMemberDetail(MO_FAKE_SESSION, "AH-01", { now: NOW });
  assert.equal(r.status, "not_found");
});

test("detail content for Reyes: profile + baseline, Watch, 4 readings incl. blood pressure, shared scores, sleep, cognitive, messages", async () => {
  const d = await seeded().service.getCrewMemberDetail(MO_SESSION, "AH-04", { now: NOW });
  assert.equal(d.status, "ready");
  assert.deepEqual({ name: d.profile.name, crewId: d.profile.crewId }, { name: "Jonas Reyes", crewId: "AH-04" });
  assert.ok(Number.isFinite(d.profile.baseline.heartRate));
  assert.equal(d.state.label, "Watch");
  assert.deepEqual(d.alerts.items.map((a) => a.number), ["ALT-0190"]);
  assert.deepEqual(d.vitals.items.map((v) => v.key), ["heartRate", "spo2", "bloodPressure", "sleepDuration"]);
  assert.equal(d.vitals.items[2].state, "ok");
  assert.equal(d.sleep.recorded, 7);
  assert.equal(d.cognitive.lastAt, Date.UTC(2026, 10, 13, 8, 30));
  assert.deepEqual(Object.keys(d.cognitive).sort(), ["lastAt", "status"], "no cognitive scores");
  assert.deepEqual(d.messages.items.map((m) => [m.direction, m.status]), [["from_officer", "replied"]]);
  assert.equal(d.messages.items[0].reply.text, "Understood — resting early tonight.");
});

// =====================================================================================
// Messages
// =====================================================================================

const ASTRONAUT_USER = (aid) => ({ id: `u-${aid}`, role: "astronaut", astronautId: aid });
const message = (aid, from, extra = {}) => ({ id: `m${++seq}`, astronautId: aid, fromUserId: from, sentAt: NOW - HOUR, acknowledgedAt: 0, body: "Hi", response: null, ...extra });

test("23–25. messages: scoped to the astronaut, senders and directions verified, unknown senders excluded", async () => {
  const users = { "u-mo2": { id: "u-mo2", role: "medical_officer", astronautId: "" }, "u-a-01": ASTRONAUT_USER("a-01"), "u-a-02": ASTRONAUT_USER("a-02"), "u-bad": { id: "u-bad", role: "medical_officer", astronautId: "a-01" } };
  const lookups = [];
  const msgs = {
    "a-01": [
      message("a-01", "u-mo", { sentAt: NOW - 1 * HOUR }),                              // officer, awaiting
      message("a-01", "u-mo2", { sentAt: NOW - 2 * HOUR, acknowledgedAt: NOW - HOUR }),  // other officer, acknowledged
      message("a-01", "u-mo", { sentAt: NOW - 3 * HOUR, response: { text: "Done", at: NOW - 2 * HOUR }, acknowledgedAt: NOW - 2 * HOUR }),
      message("a-01", "u-a-01", { sentAt: NOW - 4 * HOUR, body: "From me" }),            // the astronaut themself
      message("a-01", "u-a-02", { sentAt: NOW - 5 * HOUR, body: "Wrong astronaut" }),    // another astronaut → skip
      message("a-01", "u-bad", { sentAt: NOW - 6 * HOUR }),                              // officer linked to an astronaut → skip
      message("a-01", "u-ghost", { sentAt: NOW - 7 * HOUR }),                            // unknown → skip
      message("a-02", "u-mo", { sentAt: NOW - HOUR, body: "Belongs to a-02" }),          // another astronaut's record → skip, no lookup
      message("a-01", "", {}), message("a-01", "u-mo", { sentAt: "x" }),                  // malformed → skip, no lookup
    ],
  };
  const service = svc.createCrewMonitorService({ repos: fakeRepos({ users, messages: msgs, lookups }), getMissionContext: async () => null });
  const snap = await service.getCrewSnapshot(MO_FAKE_SESSION, { now: NOW });
  assert.deepEqual(member(snap, "AH-01").messages, { status: "ok", awaitingAcknowledgement: 1, replied: 1 });
  assert.deepEqual([...new Set(lookups)].sort(), ["u-a-01", "u-a-02", "u-bad", "u-ghost", "u-mo", "u-mo2"], "distinct senders only; malformed never looked up");
  assert.equal(lookups.filter((id) => id === "u-mo").length, 2, "once for identity + once as sender");
  const d = await service.getCrewMemberDetail(MO_FAKE_SESSION, "AH-01", { now: NOW });
  assert.deepEqual(d.messages.items.map((m) => [m.direction, m.status, m.body]), [
    ["from_officer", "awaiting_acknowledgement", "Hi"], ["from_officer", "acknowledged", "Hi"], ["from_officer", "replied", "Hi"],
  ]);
  assert.equal(d.messages.moreCount, 1, "the astronaut's own message is the 4th verified one");
  assert.equal(d.messages.items[2].reply.text, "Done");
  assert.ok(!JSON.stringify(d).includes("Wrong astronaut") && !JSON.stringify(d).includes("Belongs to a-02"));
});

test("24b. a failed sender lookup marks only that astronaut's messages as error", async () => {
  const r = await fake({ fail: { senders: true }, messages: { "a-01": [message("a-01", "u-x")] } }).getCrewSnapshot(MO_FAKE_SESSION, { now: NOW });
  assert.equal(member(r, "AH-01").messages.status, "error");
  assert.equal(member(r, "AH-02").messages.status, "ok", "AH-02 needed no lookup");
  assert.equal(member(r, "AH-01").vitals.status, "ok");
});

// =====================================================================================
// Partial failures and mutation
// =====================================================================================

test("26. partial repository failures keep the successful sections", async () => {
  const r = await fake({ fail: { shared: true, "m:a-01:spo2": true, "messages:a-02": true } }).getCrewSnapshot(MO_FAKE_SESSION, { now: NOW });
  assert.equal(r.status, "ready");
  const a1 = member(r, "AH-01");
  assert.equal(a1.vitals.status, "partial");
  assert.equal(a1.vitals.items.find((v) => v.key === "spo2").state, "error");
  assert.equal(a1.state.label, "Data needs review", "a failed read is a data issue, not an alert");
  assert.ok(r.crew.every((m) => m.sharedWellbeing.status === "error"));
  assert.equal(member(r, "AH-02").messages.status, "error");
  assert.equal(member(r, "AH-01").messages.status, "ok");
  assert.equal(r.alerts.status, "ok");
  // Crew list failure → nothing to show → unavailable.
  const down = await fake({ fail: { crew: true } }).getCrewSnapshot(MO_FAKE_SESSION, { now: NOW });
  assert.deepEqual({ status: down.status, reason: down.reason }, { status: "unavailable", reason: "database_error" });
  // Detail with failures.
  const d = await fake({ fail: { summaries: true, cognitive: true, "messages:a-01": true, "m:a-01:bpSystolic": true } }).getCrewMemberDetail(MO_FAKE_SESSION, "AH-01", { now: NOW });
  assert.equal(d.status, "ready");
  assert.deepEqual([d.sleep.status, d.cognitive.status, d.messages.status], ["error", "error", "error"]);
  assert.equal(d.vitals.items.find((v) => v.key === "bloodPressure").state, "error");
  assert.equal(d.vitals.items.find((v) => v.key === "heartRate").state, "ok");
  assert.equal(d.alerts.status, "ok");
  const lookupFail = await fake({ fail: { byCrewId: true } }).getCrewMemberDetail(MO_FAKE_SESSION, "AH-01", { now: NOW });
  assert.deepEqual({ status: lookupFail.status, reason: lookupFail.reason }, { status: "unavailable", reason: "database_error" });
});

test("27. inputs and raw records are not mutated", async () => {
  const deepFreeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
  const opts = deepFreeze({
    crew: [astronaut(2), astronaut(1)],
    alerts: [alert("a-01", "ALT-1", "warning", "new"), alert("a-02", "ALT-2", "critical", "acknowledged")],
    shared: [{ astronautId: "a-01", timestamp: NOW - HOUR, sharedWithMedical: 1, mood: 3, stress: 3, sleepQuality: 3, fatigue: 3, isolation: 3, wellbeing: 3 }],
    messages: { "a-01": [message("a-01", "u-mo")] },
  });
  const before = JSON.stringify(opts);
  const service = fake(opts);
  assert.equal((await service.getCrewSnapshot(deepFreeze({ ...MO_FAKE_SESSION }), { now: NOW })).status, "ready");
  assert.equal((await service.getCrewMemberDetail(MO_FAKE_SESSION, "AH-01", { now: NOW })).status, "ready");
  assert.equal(JSON.stringify(opts), before);
});

test("crew-wide alert list: open alerts only, with crew identity, most severe first, max 10", async () => {
  const alerts = Array.from({ length: 12 }, (_, i) => alert(i % 2 ? "a-01" : "a-02", `ALT-${100 + i}`, i === 5 ? "critical" : "info", "new", { detectedAt: NOW - i * HOUR }));
  const r = await fake({ alerts: [...alerts, alert("a-01", "ALT-999", "critical", "resolved"), alert("a-77", "ALT-998", "critical", "new")] }).getCrewSnapshot(MO_FAKE_SESSION, { now: NOW });
  assert.equal(r.alerts.items.length, 10);
  assert.equal(r.alerts.moreCount, 2);
  assert.equal(r.alerts.items[0].number, "ALT-105");
  assert.ok(r.alerts.items.every((a) => a.crewId && a.name && a.synthetic === true));
  assert.ok(!JSON.stringify(r.alerts).includes("ALT-999") && !JSON.stringify(r.alerts).includes("ALT-998"), "resolved and non-crew alerts excluded");
});

// =====================================================================================
// Encapsulation and Sprint 4 unchanged
// =====================================================================================

test("28. new pages and the shared component import no database module", () => {
  for (const file of ["js/pages/officer-overview.js", "js/pages/crew-monitor.js", "js/components/crew-view.js"]) {
    const source = read(file);
    const imports = [...source.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    assert.ok(imports.length > 0, file);
    for (const path of imports) {
      assert.doesNotMatch(path, /\/db\//, `${file}: ${path}`);
      if (file.startsWith("js/pages/")) {
        assert.match(path, /^\.\.\/(services|components|core)\//, `${file}: pages import only services/components/core, never another page (${path})`);
      } else {
        assert.match(path, /^(\.\/icon\.js|\.\.\/core\/)/, `${file}: component imports only icon/core (${path})`);
      }
    }
    assert.doesNotMatch(source, /createCrewMonitorService|mock-repositories|indexedDB|innerHTML/, file);
  }
});

test("29. Sprint 4: the astronaut Overview service and page are unchanged", () => {
  // Byte-for-byte guard via content markers Sprint 4 tests rely on.
  const page = read("js/pages/astronaut-overview.js");
  assert.match(page, /export const renderAstronautOverview = createOverviewRenderer/);
  assert.match(page, /No unacknowledged messages from the Medical Officer\./);
  const service = read("js/services/astronaut-overview-service.js");
  assert.match(service, /export const STATUS_NOTE = "Based on your open alerts only\. This is not a health assessment\.";/);
});

test("charts: 7-day daily-average trends per crew member, shared check-in counts, open alerts by severity", async () => {
  const r = await seeded().service.getCrewSnapshot(MO_SESSION, { now: NOW });
  assert.equal(r.trendDates.length, svc.TREND_DAYS);
  assert.equal(r.trendDates.at(-1), new Date(NOW).toISOString().slice(0, 10), "ends today (UTC)");
  for (const m of r.crew) {
    for (const key of ["heartRate", "spo2", "sleepDuration"]) {
      const t = m.trends[key];
      assert.equal(t.status, "ok", `${m.crewId} ${key}`);
      assert.deepEqual(t.points.map((p) => p.date), r.trendDates);
      assert.ok(t.points.some((p) => typeof p.value === "number"), `${m.crewId} ${key} has data`);
    }
    assert.equal(typeof m.sharedWellbeing.count30d, "number");
  }
  // Missing days are null, never zero; another astronaut's summary is ignored.
  const t = svc.buildTrend([{ astronautId: "a-01", metric: "spo2", date: "2026-11-13", avg: 97.25 }, { astronautId: "a-02", metric: "spo2", date: "2026-11-14", avg: 90 }], "a-01", "spo2", ["2026-11-13", "2026-11-14"]);
  assert.deepEqual(t, { status: "ok", points: [{ date: "2026-11-13", value: 97.3 }, { date: "2026-11-14", value: null }] });
});
