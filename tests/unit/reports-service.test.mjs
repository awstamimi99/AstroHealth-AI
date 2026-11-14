// tests/unit/reports-service.test.mjs — Sprint 9 dynamic reports: determinism,
// authorization, UTC ranges, missing data, baselines, verified provenance,
// exclusions, privacy, no writes.
// Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

globalThis.self = globalThis;
globalThis.BroadcastChannel = class { postMessage() {} addEventListener() {} close() {} };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const code = (p) => readFileSync(join(ROOT, p), "utf8").replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

const svc = await import("../../js/services/reports-service.js");
const mock = await import("../../js/db/mock-repositories.js");

const NOW = Date.UTC(2026, 10, 14, 15, 30);
const DAY = 86400e3;
const MO = Object.freeze({ role: "medical_officer", userId: "u-medofficer", astronautId: "" });
const HADDAD = Object.freeze({ role: "astronaut", userId: "u-haddad", astronautId: "a-01" });
const LEAKS = /a-0\d|u-[a-z]+|msr_|evt_|alr_|wba_|sim_|act_|msg_|"mood"|"stress"|meanReactionMs|Understood|Please prioritise|Routine request|"explanation"|resolutionNote|"note"|"body"|passwordHash|salt/;

const repos = () => ({
  usersRepo: mock.usersRepo, astronautsRepo: mock.astronautsRepo, measurementsRepo: mock.measurementsRepo, dailySummariesRepo: mock.dailySummariesRepo,
  alertsRepo: mock.alertsRepo, wellbeingRepo: mock.wellbeingRepo, simulationRunsRepo: mock.simulationRunsRepo, messagesRepo: mock.messagesRepo,
});
function spy(rs) {
  const calls = [];
  const wrapped = {};
  for (const [name, repo] of Object.entries(rs)) wrapped[name] = new Proxy(repo, { get(t, p) { const v = t[p]; return typeof v !== "function" ? v : (...a) => { calls.push({ repo: name, method: String(p), args: a }); return v.apply(t, a); }; } });
  return { repos: wrapped, calls };
}
const service = (overrides = {}) => { const s = spy({ ...repos(), ...overrides }); return { ...s, service: svc.createReportsService({ repos: s.repos }) }; };
const reset = () => mock.resetMock({ now: NOW });

test("deterministic: identical input, range and generatedAt → deeply equal models; builders never read the clock", async () => {
  await reset();
  const { service: s } = service();
  const a = await s.getOwnHealthReport(HADDAD, { days: 14 }, { now: NOW });
  const b = await s.getOwnHealthReport(HADDAD, { days: 14 }, { now: NOW });
  assert.equal(a.status, "ready");
  assert.deepEqual(a.report, b.report);
  assert.equal(a.report.generatedAt, NOW);
  // Pure builders: no Date.now, no input mutation.
  const realNow = Date.now;
  Date.now = () => { throw new Error("builder read the clock"); };
  try {
    const range = svc.reportRange(7, NOW);
    const input = { profile: { crewId: "AH-09", name: "Test", missionRole: "Tester" }, baseline: { heartRate: 70, spo2: null, bpSystolic: 120, bpDiastolic: 80, sleepDuration: 7 }, summaries: { heartRate: [{ metric: "heartRate", date: range.to, avg: 72, min: 70, max: 75, count: 3 }], spo2: [], bpSystolic: null, bpDiastolic: [], sleepDuration: [] }, alerts: [], counts: { checkins: { status: "ok", total: 1, shared: 1 }, simulationRuns: { status: "ok", count: 0 }, messages: { status: "ok", count: 0 } }, provenance: { status: "ok", counts: { seed: 1, simulation: 0, manual: 0, notRecorded: 0 }, suspect: 0, invalid: 0 } };
    const before = JSON.stringify(input);
    const r1 = svc.buildHealthReport(input, range, NOW, "astronaut");
    const r2 = svc.buildHealthReport(input, range, NOW, "astronaut");
    assert.deepEqual(r1, r2);
    assert.equal(JSON.stringify(input), before, "input not mutated");
    assert.ok(!Object.isFrozen(input.counts), "caller's objects are not frozen");
    assert.ok(Object.isFrozen(r1) && Object.isFrozen(r1.metrics[0]));
    assert.equal(r1.metrics.find((m) => m.key === "bpSystolic").status, "error", "a failed section stays failed, not zero");
    assert.deepEqual(svc.buildCrewSummary([], range, NOW), svc.buildCrewSummary([], range, NOW));
    assert.throws(() => svc.buildHealthReport(input, range, undefined, "astronaut"), RangeError);
  } finally {
    Date.now = realNow;
  }
  assert.ok(!/Date\.now/.test(code("js/services/reports-service.js").split("export function createReportsService")[0]), "no Date.now in the pure part");
});

test("authorization: own report only for astronauts; crew reports and crew summary for verified officers only", async () => {
  await reset();
  for (const session of [null, { ...HADDAD, astronautId: "a-02" }, { role: "medical_officer", userId: "u-haddad", astronautId: "" }]) {
    const { service: s, calls } = service();
    const results = [await s.getOwnHealthReport(session, {}, { now: NOW }), await s.getCrewMemberHealthReport(session, "AH-01", {}, { now: NOW }), await s.getCrewSummaryReport(session, {}, { now: NOW })];
    assert.ok(results.every((r) => r.status === "forbidden"), JSON.stringify(session));
    assert.ok(!calls.some((c) => c.repo !== "usersRepo"), "no data reads before authorization");
  }
  const { service: s } = service();
  assert.equal((await s.getCrewSummaryReport(HADDAD, {}, { now: NOW })).reason, "not_medical_officer");
  assert.equal((await s.getCrewMemberHealthReport(HADDAD, "AH-01", {}, { now: NOW })).reason, "not_medical_officer");
  assert.equal((await s.getCrewMemberHealthReport(MO, "a-01", {}, { now: NOW })).reason, "invalid_crew_id");
  assert.equal((await s.getCrewMemberHealthReport(MO, "AH-77", {}, { now: NOW })).reason, "unknown_crew_id");
  const own = await s.getOwnHealthReport(HADDAD, { days: 7, crewId: "AH-03", astronautId: "a-03" }, { now: NOW });
  assert.equal(own.report.subject.crewId, "AH-01", "can't widen scope");
});

test("UTC ranges: whole days inclusive; invalid ranges refused; summaries outside the range ignored", async () => {
  const r = svc.reportRange(7, NOW);
  assert.deepEqual([r.from, r.to, r.dates.length, r.fromTs, r.toTs], ["2026-11-08", "2026-11-14", 7, Date.UTC(2026, 10, 8), Date.UTC(2026, 10, 15) - 1]);
  await reset();
  const { service: s } = service();
  for (const days of [0, 3, 31, "7", null]) assert.equal((await s.getOwnHealthReport(HADDAD, { days }, { now: NOW })).reason, "invalid_range");
  const m = svc.summarizeMetric({ key: "heartRate", label: "Heart rate", decimals: 0 }, [
    { metric: "heartRate", date: "2026-11-07", avg: 999, min: 999, max: 999, count: 1 }, // before the range
    { metric: "heartRate", date: "2026-11-08", avg: 70, min: 60, max: 80, count: 4 },
    { metric: "heartRate", date: "2026-11-14", avg: 74, min: 65, max: 90, count: 2 },
    { metric: "heartRate", date: "2026-11-10", avg: 70, min: 70, max: 70, count: 0 }, // count 0 = no data
    { metric: "spo2", date: "2026-11-09", avg: 1, min: 1, max: 1, count: 1 }, // other metric
  ], r.dates, 72);
  assert.deepEqual(m, { key: "heartRate", label: "Heart rate", unit: "bpm", daysWithData: 2, missingDays: 5, average: 72, min: 60, max: 90, baseline: 72, differenceFromBaseline: 0 });
});

test("missing data stays missing; baseline difference only with a valid stored baseline", () => {
  const r = svc.reportRange(7, NOW);
  const none = svc.summarizeMetric({ key: "spo2", label: "SpO₂", decimals: 0 }, [], r.dates, 98);
  assert.deepEqual([none.daysWithData, none.missingDays, none.average, none.min, none.max, none.differenceFromBaseline], [0, 7, null, null, null, null]);
  const noBase = svc.summarizeMetric({ key: "spo2", label: "SpO₂", decimals: 0 }, [{ metric: "spo2", date: r.to, avg: 97, min: 96, max: 98, count: 2 }], r.dates, null);
  assert.deepEqual([noBase.average, noBase.baseline, noBase.differenceFromBaseline], [97, null, null]);
  const nan = svc.summarizeMetric({ key: "spo2", label: "SpO₂", decimals: 0 }, [{ metric: "spo2", date: r.to, avg: 97, min: 96, max: 98, count: 2 }], r.dates, Number.NaN);
  assert.equal(nan.differenceFromBaseline, null);
});

test("provenance: counts only from measurement records with a canonical source, last 7 UTC days; nothing inferred", async () => {
  await reset();
  const fake = [
    { astronautId: "a-01", metric: "heartRate", source: "seed", quality: "ok", timestamp: NOW - 1000 },
    { astronautId: "a-01", metric: "heartRate", source: "simulation", quality: "ok", timestamp: NOW - 2000 },
    { astronautId: "a-01", metric: "heartRate", source: "manual", quality: "suspect", timestamp: NOW - 3000 },
    { astronautId: "a-01", metric: "heartRate", quality: "ok", timestamp: NOW - 4000 }, // no source → not recorded
    { astronautId: "a-01", metric: "heartRate", source: "robot", quality: "invalid", timestamp: NOW - 5000 },
    { astronautId: "a-02", metric: "heartRate", source: "manual", quality: "ok", timestamp: NOW - 6000 }, // other astronaut
  ];
  const calls = [];
  const s = service({ measurementsRepo: { getRange: async (aid, metric, from, to) => { calls.push([metric, from, to]); return metric === "heartRate" ? fake : []; }, getRecent: async () => [] } }).service;
  const r7 = (await s.getOwnHealthReport(HADDAD, { days: 7 }, { now: NOW })).report;
  assert.deepEqual(r7.provenance.counts, { seed: 1, simulation: 1, manual: 1, notRecorded: 2 });
  assert.deepEqual([r7.provenance.suspect, r7.provenance.invalid, r7.provenance.olderUnavailable], [1, 1, null]);
  const r30 = (await s.getOwnHealthReport(HADDAD, { days: 30 }, { now: NOW })).report;
  assert.deepEqual(r30.provenance.window, { from: "2026-11-08", to: "2026-11-14" });
  assert.deepEqual(r30.provenance.olderUnavailable, { from: "2026-10-16", to: "2026-11-07", text: "Source breakdown is unavailable for this period." });
  assert.ok(calls.filter((c) => c[0] === "heartRate").every((c) => c[1] >= Date.UTC(2026, 10, 8)), "raw reads limited to the retention window");
});

test("contents: disclaimer, exclusions, alerts with demonstration limitation; officer gets shared check-in counts only", async () => {
  await reset();
  const { service: s } = service();
  const own = (await s.getOwnHealthReport(HADDAD, { days: 30 }, { now: NOW })).report;
  assert.equal(own.disclaimer, "Synthetic data · research and educational prototype · not a medical device · not clinically validated · not affiliated with or endorsed by NASA · not a diagnosis or treatment recommendation · does not determine fitness for duty.");
  assert.deepEqual(own.excluded, ["Private journal", "Wellbeing scores", "Cognitive scores", "Alert explanations", "Medical Officer notes", "Message bodies and responses", "Passwords and session data", "Internal IDs"]);
  assert.deepEqual(own.alerts.items.map((a) => [a.number, a.severity, a.status, a.ruleId, a.ruleVersion, a.limitation]), [["ALT-0181", "warning", "resolved", "PHY-03", null, "Demonstration threshold — not clinically validated."]]);
  assert.ok(own.activity.checkins.total > own.activity.checkins.shared, "the astronaut sees their own private count");
  const mo = (await s.getCrewMemberHealthReport(MO, "AH-01", { days: 30 }, { now: NOW })).report;
  assert.deepEqual(Object.keys(mo.activity.checkins).sort(), ["shared", "status"], "no total → no private-check-in signal");
  assert.equal(mo.activity.checkins.shared, own.activity.checkins.shared);
  const crew = (await s.getCrewSummaryReport(MO, { days: 7 }, { now: NOW })).report;
  assert.deepEqual(crew.members.map((m) => [m.crewId, m.openTotal]), [["AH-01", 0], ["AH-02", 0], ["AH-03", 1], ["AH-04", 1]]);
  assert.ok(crew.members.every((m) => Object.keys(m).sort().join() === "crewId,daysWithData,latestVitalAt,name,openAlerts,openTotal,sharedCheckins"));
  for (const r of [own, mo, crew]) assert.ok(!LEAKS.test(JSON.stringify(r)), JSON.stringify(r).match(LEAKS)?.[0]);
});

test("no writes: reports never call add/update/set on any repository", async () => {
  await reset();
  const { service: s, calls } = service();
  await s.getOwnHealthReport(HADDAD, { days: 30 }, { now: NOW });
  await s.getCrewMemberHealthReport(MO, "AH-04", { days: 14 }, { now: NOW });
  await s.getCrewSummaryReport(MO, { days: 30 }, { now: NOW });
  assert.ok(!calls.some((c) => /^(add|addMany|update|set|upsert|put|delete)$/.test(c.method)), calls.filter((c) => /add|update|set/.test(c.method)).map((c) => `${c.repo}.${c.method}`).join());
  const src = code("js/services/reports-service.js");
  for (const bad of ["reportsRepo", "eventsRepo", "settingsRepo", "journalRepo", "cognitiveRepo", "localStorage"]) assert.ok(!src.includes(bad), bad);
});

test("partial failure: a failed section is reported as such; everything failing is 'unavailable'", async () => {
  await reset();
  const fail = async () => { throw new Error("x"); };
  const part = (await service({ alertsRepo: { query: fail } }).service.getOwnHealthReport(HADDAD, {}, { now: NOW })).report;
  assert.equal(part.alerts.status, "error");
  assert.equal(part.metrics[0].status, "ok");
  const all = await service({ alertsRepo: { query: fail }, dailySummariesRepo: { getRange: fail } }).service.getOwnHealthReport(HADDAD, {}, { now: NOW });
  assert.deepEqual([all.status, all.reason], ["unavailable", "database_error"]);
});
