// tests/unit/simulation-service.test.mjs — Sprint 7 Simulation Center service:
// authorization, start / advance / pause / resume / stop, atomicity,
// idempotency, timestamps, recovery, privacy and regressions.
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

const svc = await import("../../js/services/simulation-service.js");
const mock = await import("../../js/db/mock-repositories.js");
const { DatabaseError } = await import("../../js/db/errors.js");
const { MEASUREMENT_WRITE_STORES } = await import("../../js/db/index.js");
const cat = await import("../../js/simulation/scenarios.js");

const SEC = 1000;
const NOW = Date.UTC(2026, 10, 14, 15, 30);
const MO = Object.freeze({ role: "medical_officer", userId: "u-medofficer", astronautId: "" });
const MO2 = Object.freeze({ role: "medical_officer", userId: "u-medbackup", astronautId: "" });
const HADDAD = Object.freeze({ role: "astronaut", userId: "u-haddad", astronautId: "a-01" });
const START = Object.freeze({ crewId: "AH-03", scenarioId: "low_oxygen", speed: 8, confirm: true });
const CHEN_LOW = [95, 93, 92, 90, 88, 88, 88, 90, 92, 93, 95, 97]; // AH-03 baseline SpO₂ 97
const REYES_HR = [82, 93, 105, 116, 128, 128, 128, 116, 105, 93, 82, 70]; // AH-04 baseline HR 70

const baseRepos = () => ({
  usersRepo: mock.usersRepo, astronautsRepo: mock.astronautsRepo, measurementsRepo: mock.measurementsRepo,
  simulationRunsRepo: mock.simulationRunsRepo, eventsRepo: mock.eventsRepo,
});
function spy(rs) {
  const calls = [];
  const wrapped = {};
  for (const [name, repo] of Object.entries(rs)) {
    wrapped[name] = new Proxy(repo, { get(t, p) { const v = t[p]; return typeof v !== "function" ? v : (...a) => { calls.push({ repo: name, method: String(p), args: a }); return v.apply(t, a); }; } });
  }
  return { repos: wrapped, calls };
}
/** Models IndexedDB: overlapping readwrite transactions run one after another. */
function serialTx() {
  let tail = Promise.resolve();
  const stores = [];
  const run = (names, mode, work) => {
    stores.push({ names: [...names], mode });
    const next = tail.then(() => mock.withTransaction(names, mode, work));
    tail = next.catch(() => {});
    return next;
  };
  return { run, stores };
}
function service(overrides = {}) {
  const s = spy({ ...baseRepos(), ...overrides });
  const tx = serialTx();
  return { ...s, tx, service: svc.createSimulationService({ repos: s.repos, withTransaction: tx.run }) };
}
const reset = () => mock.resetMock({ now: NOW });
const runs = async () => [...(await mock.simulationRunsRepo.getByAstronaut("a-01")), ...(await mock.simulationRunsRepo.getByAstronaut("a-02")), ...(await mock.simulationRunsRepo.getByAstronaut("a-03")), ...(await mock.simulationRunsRepo.getByAstronaut("a-04"))];
const simReadings = async (aid, metric) => (await mock.measurementsRepo.getRange(aid, metric)).filter((m) => m.source === "simulation");
const runEvents = async (aid) => (await mock.eventsRepo.getRange({ astronautId: aid })).filter((e) => e.refStore === "simulationRuns");
const alertCount = async () => (await mock.alertsRepo.query({})).length;

async function started(s, input = START, now = NOW + SEC) {
  const r = await s.startSimulation(MO, input, { now });
  assert.equal(r.status, "started", JSON.stringify(r));
  return r.runRef;
}
async function advanceN(s, ref, n, from = 0, t0 = NOW + 10 * SEC) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(await s.advanceSimulation(MO, ref, { expectedStep: from + i }, { now: t0 + (from + i) * SEC }));
  return out;
}

// =====================================================================================
// Authorization (1–6)
// =====================================================================================

test("1–4. missing, astronaut, mismatched and astronautId-carrying sessions are refused before any simulation read", async () => {
  await reset();
  const bad = [
    [null, "no_session"],
    [HADDAD, "not_medical_officer"],
    [{ role: "medical_officer", userId: "u-haddad", astronautId: "" }, "account_mismatch"],
    [{ role: "medical_officer", userId: "u-nobody", astronautId: "" }, "account_mismatch"],
    [{ role: "medical_officer", userId: "u-medofficer", astronautId: "a-01" }, "invalid_session"],
    [{ role: "medical-officer", userId: "u-medofficer", astronautId: "" }, "not_medical_officer"],
  ];
  for (const [session, reason] of bad) {
    const { service: s, calls } = service();
    const results = [
      await s.getSimulationCenter(session, { now: NOW }),
      await s.previewSimulation(session, { crewId: "AH-01", scenarioId: "low_oxygen" }, { now: NOW }),
      await s.startSimulation(session, START, { now: NOW }),
      await s.advanceSimulation(session, "sim_x", { expectedStep: 0 }, { now: NOW }),
      await s.pauseSimulation(session, "sim_x", { now: NOW }),
      await s.resumeSimulation(session, "sim_x", { now: NOW }),
      await s.stopSimulation(session, "sim_x", { confirm: true }, { now: NOW }),
    ];
    for (const r of results) {
      assert.equal(r.status, "forbidden", JSON.stringify(session));
      assert.equal(r.reason, reason);
    }
    const nonUser = calls.filter((c) => c.repo !== "usersRepo");
    assert.deepEqual(nonUser, [], `${JSON.stringify(session)}: no simulation/astronaut reads before authorization`);
  }
  assert.equal((await runs()).length, 0);
});

test("5–6. crew IDs are validated only after authorization; unknown astronauts are refused", async () => {
  await reset();
  const { service: s, calls } = service();
  for (const crewId of ["a-01", "AH-1", "ah-01", "", undefined, "AH-01/x"]) {
    const r = await s.startSimulation(MO, { ...START, crewId }, { now: NOW });
    assert.deepEqual([r.status, r.reason], ["not_found", "invalid_crew_id"], String(crewId));
  }
  const unknown = await s.startSimulation(MO, { ...START, crewId: "AH-99" }, { now: NOW });
  assert.deepEqual([unknown.status, unknown.reason], ["not_found", "unknown_crew_id"]);
  const firstCrewRead = calls.findIndex((c) => c.repo === "astronautsRepo");
  assert.ok(calls.findIndex((c) => c.repo === "usersRepo") < firstCrewRead, "officer verified first");
  assert.ok(!calls.some((c) => c.repo === "simulationRunsRepo"), "no run reads for refused input");
  assert.equal((await runs()).length, 0);
});

// =====================================================================================
// Start (12–17)
// =====================================================================================

test("12–13. start creates one run with service-controlled fields; page overrides are ignored", async () => {
  await reset();
  const { service: s, tx } = service();
  const input = { ...START, astronautId: "a-01", userId: "u-haddad", operatorId: "u-haddad", status: "completed", source: "manual",
    startedAt: 1, endedAt: 5, step: 11, totalSteps: 2, startValue: 50, catalogVersion: 99, createdBy: "x", simulationRunId: "sim_evil", id: "sim_evil" };
  const frozen = Object.freeze({ ...input });
  const r = await s.startSimulation(MO, frozen, { now: NOW + SEC });
  assert.equal(r.status, "started");
  assert.match(r.runRef, /^sim_/);
  assert.notEqual(r.runRef, "sim_evil");
  const [run] = await runs();
  assert.equal(run.id, r.runRef);
  assert.deepEqual(
    { astronautId: run.astronautId, scenarioId: run.scenarioId, status: run.status, speed: run.speed, operatorId: run.operatorId, startedAt: run.startedAt, endedAt: run.endedAt,
      createdBy: run.createdBy, step: run.step, totalSteps: run.totalSteps, startValue: run.startValue, lastStepAt: run.lastStepAt, pausedAt: run.pausedAt, catalogVersion: run.catalogVersion },
    { astronautId: "a-03", scenarioId: "low_oxygen", status: "running", speed: 8, operatorId: "u-medofficer", startedAt: NOW + SEC, endedAt: 0,
      createdBy: "u-medofficer", step: 0, totalSteps: 12, startValue: 97, lastStepAt: NOW + SEC, pausedAt: 0, catalogVersion: 1 }
  );
  assert.equal(JSON.stringify(frozen), JSON.stringify(input), "input not mutated");
  // Presentation: no internal ids.
  const json = JSON.stringify(r.run);
  for (const bad of ["a-03", "u-medofficer", "sim_"]) assert.ok(!json.includes(bad), bad);
  // 17. One transaction over simulationRuns + missionEvents, with one start event.
  assert.deepEqual(tx.stores, [{ names: ["simulationRuns", "missionEvents"], mode: "readwrite" }]);
  const events = await runEvents("a-03");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "simulation_started");
  assert.equal(events[0].refId, run.id);
  assert.equal(events[0].actorUserId, "u-medofficer");
  assert.equal(events[0].data.phase, "started");
});

test("14. invalid scenario, speed and missing confirmation are refused with nothing written", async () => {
  await reset();
  const { service: s } = service();
  const cases = [
    [{ ...START, scenarioId: "sleep_deprivation" }, "unknown_scenario"],
    [{ ...START, scenarioId: "__proto__" }, "unknown_scenario"],
    [{ ...START, speed: 3 }, "invalid_speed"],
    [{ ...START, speed: "8" }, "invalid_speed"],
    [{ ...START, confirm: "true" }, "confirmation_required"],
    [{ ...START, confirm: 1 }, "confirmation_required"],
    [{ ...START, confirm: undefined }, "confirmation_required"],
  ];
  for (const [input, reason] of cases) {
    const r = await s.startSimulation(MO, input, { now: NOW });
    assert.deepEqual([r.status, r.reason], ["invalid", reason]);
  }
  assert.equal((await runs()).length, 0);
  assert.equal((await mock.eventsRepo.getRange({ types: ["simulation_started"] })).length, 0);
});

test("15–16. duplicate and concurrent starts produce exactly one active run (global policy, running or paused)", async () => {
  await reset();
  const one = service();
  // Same tab, double click: the in-memory lock answers "busy".
  const [a, b] = await Promise.all([one.service.startSimulation(MO, START, { now: NOW + SEC }), one.service.startSimulation(MO, START, { now: NOW + SEC })]);
  assert.deepEqual([a.status, b.status].sort(), ["busy", "started"]);
  // Another officer/tab: refused inside the transaction, for ANY crew member.
  const other = svc.createSimulationService({ repos: baseRepos(), withTransaction: one.tx.run });
  const c = await other.startSimulation(MO2, { ...START, crewId: "AH-01", scenarioId: "elevated_heart_rate" }, { now: NOW + 2 * SEC });
  assert.deepEqual([c.status, c.reason], ["conflict", "another_run_active"]);
  assert.deepEqual(c.activeRun, { crewId: "AH-03", name: "Mei Chen", scenarioName: "Low oxygen saturation demonstration", status: "running" });
  // Paused counts as active too.
  const ref = (await runs())[0].id;
  assert.equal((await one.service.pauseSimulation(MO, ref, { now: NOW + 3 * SEC })).status, "paused");
  const d = await other.startSimulation(MO2, START, { now: NOW + 4 * SEC });
  assert.equal(d.reason, "another_run_active");
  assert.equal((await runs()).length, 1);
  assert.equal((await mock.eventsRepo.getRange({ types: ["simulation_started"] })).filter((e) => e.data.phase === "started").length, 1);
  // Two separate tabs starting at once (serialized like IndexedDB): one run.
  await reset();
  const shared = serialTx();
  const t1 = svc.createSimulationService({ repos: baseRepos(), withTransaction: shared.run });
  const t2 = svc.createSimulationService({ repos: baseRepos(), withTransaction: shared.run });
  const both = await Promise.all([t1.startSimulation(MO, START, { now: NOW + SEC }), t2.startSimulation(MO2, { ...START, crewId: "AH-02" }, { now: NOW + SEC })]);
  assert.deepEqual(both.map((x) => x.status).sort(), ["conflict", "started"]);
  assert.equal((await mock.simulationRunsRepo.getActive()).length, 1);
});

test("start: a failed event write rolls back the run (atomic start)", async () => {
  await reset();
  const { service: s } = service({ eventsRepo: { ...mock.eventsRepo, add: async () => { throw new DatabaseError("boom", { code: "QUOTA" }); } } });
  const r = await s.startSimulation(MO, START, { now: NOW + SEC });
  assert.deepEqual([r.status, r.reason], ["unavailable", "database_error"]);
  assert.equal((await runs()).length, 0);
});

// =====================================================================================
// Advance (18–24) + timestamps
// =====================================================================================

test("18–19. each step writes the next deterministic value with source simulation, the run id and the controlled time", async () => {
  await reset();
  const { service: s, tx } = service();
  const ref = await started(s);
  const results = await advanceN(s, ref, 11);
  assert.deepEqual(results.map((r) => r.status), Array(11).fill("advanced"));
  assert.deepEqual(results.map((r) => r.reading.value), CHEN_LOW.slice(0, 11));
  const readings = await simReadings("a-03", "spo2");
  assert.equal(readings.length, 11);
  readings.forEach((m, i) => {
    assert.equal(m.value, CHEN_LOW[i]);
    assert.equal(m.unit, "%");
    assert.equal(m.source, "simulation");
    assert.equal(m.quality, "ok");
    assert.equal(m.simulationRunId, ref);
    assert.equal(m.astronautId, "a-03");
    assert.equal(m.createdBy, "u-medofficer");
    assert.equal(m.timestamp, NOW + 10 * SEC + i * SEC, "timestamp is exactly the controlled now");
  });
  // Advance transactions include every measurement-maintenance store + runs + events.
  const stepTx = tx.stores.filter((t) => t.names.includes("measurements"));
  assert.equal(stepTx.length, 11);
  assert.ok(Array.isArray(MEASUREMENT_WRITE_STORES) && MEASUREMENT_WRITE_STORES.length > 0, "public MEASUREMENT_WRITE_STORES export");
  for (const t of stepTx) {
    for (const n of [...MEASUREMENT_WRITE_STORES, "simulationRuns", "missionEvents"]) assert.ok(t.names.includes(n), n);
    assert.equal(new Set(t.names).size, t.names.length, "unique store list");
  }
  // A different scenario/astronaut: heart rate from AH-04's baseline 70.
  await reset();
  const h = service().service;
  const ref2 = await started(h, { crewId: "AH-04", scenarioId: "elevated_heart_rate", speed: 1, confirm: true });
  const hr = await advanceN(h, ref2, 12);
  assert.deepEqual(hr.map((r) => r.reading.value), REYES_HR);
  assert.ok(hr.every((r) => r.reading.unit === "bpm"));
});

test("20. measurement maintenance: astronaut.latest and the daily summary are updated by measurementsRepo.add", async () => {
  await reset();
  const { service: s, calls } = service();
  const before = (await mock.dailySummariesRepo.getRange("a-03", "spo2", "2026-11-14", "2026-11-14"))[0];
  const ref = await started(s);
  await advanceN(s, ref, 3);
  const a = await mock.astronautsRepo.getById("a-03");
  assert.deepEqual(a.latest.spo2, { value: CHEN_LOW[2], timestamp: NOW + 12 * SEC });
  const after = (await mock.dailySummariesRepo.getRange("a-03", "spo2", "2026-11-14", "2026-11-14"))[0];
  assert.equal(after.count, (before ? before.count : 0) + 3);
  assert.ok(after.min <= CHEN_LOW[2]);
  // The service never maintains caches itself.
  assert.ok(!calls.some((c) => c.repo === "astronautsRepo" && ["update", "updateLatest"].includes(c.method)));
  assert.ok(!calls.some((c) => c.repo === "measurementsRepo" && c.method === "addMany"));
  assert.ok(!code("js/services/simulation-service.js").includes("dailySummariesRepo"));
});

test("21–22. step + progress + event are atomic; a failed event write rolls back the measurement, latest and summary", async () => {
  await reset();
  const failing = { ...mock.eventsRepo, add: async (rec, opts) => { if (rec.type === "measurement_recorded") throw new DatabaseError("disk full", { code: "QUOTA" }); return mock.eventsRepo.add(rec, opts); } };
  const { service: s } = service({ eventsRepo: failing });
  const ref = await started(s);
  const latestBefore = JSON.stringify((await mock.astronautsRepo.getById("a-03")).latest);
  const sumBefore = JSON.stringify(await mock.dailySummariesRepo.getRange("a-03", "spo2"));
  const r = await s.advanceSimulation(MO, ref, { expectedStep: 0 }, { now: NOW + 10 * SEC });
  assert.deepEqual([r.status, r.reason], ["unavailable", "database_error"]);
  assert.equal((await simReadings("a-03", "spo2")).length, 0);
  const run = await mock.simulationRunsRepo.getById(ref);
  assert.equal(run.step, 0);
  assert.equal(run.lastStepAt, NOW + SEC);
  assert.equal(JSON.stringify((await mock.astronautsRepo.getById("a-03")).latest), latestBefore);
  assert.equal(JSON.stringify(await mock.dailySummariesRepo.getRange("a-03", "spo2")), sumBefore);
  assert.equal((await runEvents("a-03")).filter((e) => e.type === "measurement_recorded").length, 0);
  // The next attempt (with a working repository) writes the same step 1.
  const ok = await service().service.advanceSimulation(MO, ref, { expectedStep: 0 }, { now: NOW + 11 * SEC });
  assert.equal(ok.status, "advanced");
  assert.equal(ok.reading.value, CHEN_LOW[0]);
});

test("23. a stale expectedStep, a double click and two tabs can't duplicate a step", async () => {
  await reset();
  const { service: s, tx } = service();
  const ref = await started(s);
  await advanceN(s, ref, 2);
  const stale = await s.advanceSimulation(MO, ref, { expectedStep: 1 }, { now: NOW + 30 * SEC });
  assert.deepEqual([stale.status, stale.reason, stale.currentStep], ["conflict", "step_mismatch", 2]);
  // Double click in one tab.
  const [a, b] = await Promise.all([
    s.advanceSimulation(MO, ref, { expectedStep: 2 }, { now: NOW + 31 * SEC }),
    s.advanceSimulation(MO, ref, { expectedStep: 2 }, { now: NOW + 31 * SEC }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), ["advanced", "busy"]);
  // Two tabs (separate service instances, IndexedDB-style serialized transactions).
  const tab2 = svc.createSimulationService({ repos: baseRepos(), withTransaction: tx.run });
  const both = await Promise.all([
    s.advanceSimulation(MO, ref, { expectedStep: 3 }, { now: NOW + 40 * SEC }),
    tab2.advanceSimulation(MO2, ref, { expectedStep: 3 }, { now: NOW + 40 * SEC }),
  ]);
  assert.deepEqual(both.map((x) => x.status).sort(), ["advanced", "conflict"]);
  assert.equal(both.find((x) => x.status === "conflict").reason, "step_mismatch");
  const readings = await simReadings("a-03", "spo2");
  assert.deepEqual(readings.map((m) => m.value), CHEN_LOW.slice(0, 4), "exactly one reading per step");
  assert.equal((await mock.simulationRunsRepo.getById(ref)).step, 4);
  for (const bad of [-1, 1.5, "2", null, undefined]) {
    assert.equal((await s.advanceSimulation(MO, ref, { expectedStep: bad }, { now: NOW + 50 * SEC })).reason, "invalid_step");
  }
  assert.equal((await s.advanceSimulation(MO, "not-a-ref", { expectedStep: 4 }, { now: NOW + 50 * SEC })).reason, "unknown_run");
  assert.equal((await s.advanceSimulation(MO, "sim_missing", { expectedStep: 4 }, { now: NOW + 50 * SEC })).reason, "unknown_run");
});

test("24 + 30. the final step completes the run exactly once; completed runs can't advance or resume", async () => {
  await reset();
  const { service: s } = service();
  const ref = await started(s);
  const res = await advanceN(s, ref, 12);
  assert.deepEqual(res.map((r) => r.status), [...Array(11).fill("advanced"), "completed"]);
  assert.equal(res[11].reading.value, 97, "final value equals the start value");
  const run = await mock.simulationRunsRepo.getById(ref);
  assert.deepEqual([run.status, run.step, run.endedAt], ["completed", 12, NOW + 21 * SEC]);
  const events = await runEvents("a-03");
  assert.equal(events.filter((e) => e.type === "measurement_recorded").length, 12);
  assert.deepEqual(events.filter((e) => e.type === "simulation_stopped").map((e) => e.data.outcome), ["completed"]);
  assert.equal(events.length, 14, "start + 12 readings + completion");
  const again = await s.advanceSimulation(MO, ref, { expectedStep: 12 }, { now: NOW + 60 * SEC });
  assert.deepEqual([again.status, again.reason], ["conflict", "not_running"]);
  assert.equal((await s.resumeSimulation(MO, ref, { now: NOW + 61 * SEC })).status, "conflict");
  assert.equal((await s.pauseSimulation(MO, ref, { now: NOW + 61 * SEC })).status, "conflict");
  assert.equal((await s.stopSimulation(MO, ref, { confirm: true }, { now: NOW + 61 * SEC })).status, "unchanged");
  assert.equal((await simReadings("a-03", "spo2")).length, 12);
  assert.equal((await runEvents("a-03")).length, 14);
  assert.equal((await mock.simulationRunsRepo.getActive()).length, 0);
});

test("timestamp correction: an equal or earlier `now` is a clock_not_monotonic conflict with no writes", async () => {
  await reset();
  const { service: s } = service();
  const ref = await started(s, START, NOW + 5 * SEC);
  const snapshot = async () => JSON.stringify([await simReadings("a-03", "spo2"), await mock.simulationRunsRepo.getById(ref), await runEvents("a-03"), (await mock.astronautsRepo.getById("a-03")).latest]);
  const before = await snapshot();
  for (const now of [NOW + 5 * SEC, NOW + 4 * SEC, NOW - 3600 * SEC]) {
    const r = await s.advanceSimulation(MO, ref, { expectedStep: 0 }, { now });
    assert.deepEqual([r.status, r.reason], ["conflict", "clock_not_monotonic"], String(now));
  }
  assert.equal(await snapshot(), before, "no measurement, event or progress write");
  // After one step, the same time again is refused too.
  assert.equal((await s.advanceSimulation(MO, ref, { expectedStep: 0 }, { now: NOW + 6 * SEC })).status, "advanced");
  const same = await s.advanceSimulation(MO, ref, { expectedStep: 1 }, { now: NOW + 6 * SEC });
  assert.equal(same.reason, "clock_not_monotonic");
  assert.equal((await simReadings("a-03", "spo2")).length, 1);
  for (const now of [Number.NaN, Infinity, "x"]) {
    assert.equal((await s.advanceSimulation(MO, ref, { expectedStep: 1 }, { now })).reason, "invalid_time");
  }
  assert.equal((await simReadings("a-03", "spo2")).length, 1);
});

// =====================================================================================
// State transitions (25–30)
// =====================================================================================

test("25–29. pause, resume and stop follow the state machine; repeats are 'unchanged'; invalid ones are conflicts", async () => {
  await reset();
  const { service: s } = service();
  const ref = await started(s);
  await advanceN(s, ref, 2);
  const p = await s.pauseSimulation(MO, ref, { now: NOW + 40 * SEC });
  assert.equal(p.status, "paused");
  let run = await mock.simulationRunsRepo.getById(ref);
  assert.deepEqual([run.status, run.pausedAt], ["paused", NOW + 40 * SEC]);
  assert.equal((await s.pauseSimulation(MO, ref, { now: NOW + 41 * SEC })).status, "unchanged");
  const blocked = await s.advanceSimulation(MO, ref, { expectedStep: 2 }, { now: NOW + 42 * SEC });
  assert.deepEqual([blocked.status, blocked.reason], ["conflict", "not_running"]);

  const r = await s.resumeSimulation(MO2, ref, { now: NOW + 50 * SEC }); // any verified officer
  assert.equal(r.status, "running");
  run = await mock.simulationRunsRepo.getById(ref);
  assert.deepEqual([run.status, run.pausedAt, run.operatorId], ["running", 0, "u-medofficer"]);
  assert.equal((await s.resumeSimulation(MO, ref, { now: NOW + 51 * SEC })).status, "unchanged");

  assert.deepEqual((await s.stopSimulation(MO, ref, {}, { now: NOW + 52 * SEC })).reason, "confirmation_required");
  assert.deepEqual((await s.stopSimulation(MO, ref, { confirm: "yes" }, { now: NOW + 52 * SEC })).reason, "confirmation_required");
  const st = await s.stopSimulation(MO, ref, { confirm: true }, { now: NOW + 53 * SEC });
  assert.equal(st.status, "stopped");
  run = await mock.simulationRunsRepo.getById(ref);
  assert.deepEqual([run.status, run.endedAt, run.step], ["stopped", NOW + 53 * SEC, 2]);
  assert.equal((await s.stopSimulation(MO, ref, { confirm: true }, { now: NOW + 54 * SEC })).status, "unchanged");
  assert.equal((await s.resumeSimulation(MO, ref, { now: NOW + 55 * SEC })).reason, "invalid_transition");
  assert.equal((await s.pauseSimulation(MO, ref, { now: NOW + 55 * SEC })).reason, "invalid_transition");
  assert.equal((await s.advanceSimulation(MO, ref, { expectedStep: 2 }, { now: NOW + 56 * SEC })).reason, "not_running");

  const events = (await runEvents("a-03")).sort((a, b) => a.timestamp - b.timestamp);
  assert.deepEqual(events.map((e) => [e.type, e.data && (e.data.phase || e.data.outcome || "")]), [
    ["simulation_started", "started"], ["measurement_recorded", ""], ["measurement_recorded", ""],
    ["simulation_paused", ""], ["simulation_started", "resumed"], ["simulation_stopped", "stopped"],
  ]);
  assert.ok(events.every((e) => e.refId === ref && e.refStore === "simulationRuns"));
  assert.equal(events[4].actorUserId, "u-medbackup");
  assert.equal(await svc.createSimulationService({ repos: baseRepos(), withTransaction: mock.withTransaction }).pauseSimulation(MO, "sim_unknown", { now: NOW }).then((x) => x.reason), "unknown_run");
});

test("stop still works when the astronaut record or the scenario is gone; advance/resume are blocked", async () => {
  await reset();
  // Astronaut gone: measurementsRepo.add reports NOT_FOUND for the astronaut.
  const gone = { ...mock.measurementsRepo, add: async () => { throw new DatabaseError('measurements: unknown astronautId "a-03"', { code: "NOT_FOUND", store: "astronauts" }); } };
  const hidden = { ...mock.astronautsRepo, getById: async () => null };
  const { service: s } = service({ measurementsRepo: gone, astronautsRepo: hidden });
  const ref = await started(service().service);
  const adv = await s.advanceSimulation(MO, ref, { expectedStep: 0 }, { now: NOW + 10 * SEC });
  assert.deepEqual([adv.status, adv.reason], ["unavailable", "astronaut_missing"]);
  assert.equal((await mock.simulationRunsRepo.getById(ref)).step, 0, "nothing written");
  const center = await s.getSimulationCenter(MO, { now: NOW + 11 * SEC });
  assert.equal(center.run.astronautAvailable, "no");
  assert.equal(center.run.crewId, "");
  assert.equal((await s.stopSimulation(MO, ref, { confirm: true }, { now: NOW + 12 * SEC })).status, "stopped");

  // Scenario removed from a later catalog: advance + resume blocked, stop allowed.
  await reset();
  const ref2 = await started(service().service);
  await service().service.pauseSimulation(MO, ref2, { now: NOW + 5 * SEC });
  const later = svc.createSimulationService({ repos: baseRepos(), withTransaction: mock.withTransaction, scenarios: [cat.getScenario("elevated_heart_rate")] });
  assert.equal((await later.resumeSimulation(MO, ref2, { now: NOW + 6 * SEC })).reason, "scenario_unavailable");
  assert.equal((await later.advanceSimulation(MO, ref2, { expectedStep: 0 }, { now: NOW + 7 * SEC })).reason, "scenario_unavailable");
  const view = await later.getSimulationCenter(MO, { now: NOW + 8 * SEC });
  assert.equal(view.run.scenarioAvailable, false);
  assert.equal(view.run.scenarioName, "Scenario no longer available");
  assert.equal((await later.stopSimulation(MO, ref2, { confirm: true }, { now: NOW + 9 * SEC })).status, "stopped");
});

// =====================================================================================
// Center view, recovery (31–35), privacy and regressions (36–44)
// =====================================================================================

test("31. getSimulationCenter reconstructs the active run (readings, timeline, stale flag) without ids", async () => {
  await reset();
  const { service: s } = service();
  const empty = await s.getSimulationCenter(MO, { now: NOW });
  assert.equal(empty.status, "ready");
  assert.equal(empty.run, null);
  assert.deepEqual(empty.crew.items.map((c) => c.crewId), ["AH-01", "AH-02", "AH-03", "AH-04"]);
  assert.deepEqual(empty.scenarios.map((x) => x.id), ["low_oxygen", "elevated_heart_rate"]);
  assert.deepEqual(empty.speeds, [1, 2, 4, 8]);
  assert.equal(empty.notes.noRisk, "No risk rules are evaluated and no alerts are created. Risk evaluation will be implemented in the Risk Engine sprint.");
  assert.equal(empty.notes.openPage, "The simulation advances only while this page is open. Background tabs may be delayed.");

  const ref = await started(s);
  await advanceN(s, ref, 3);
  const fresh = await s.getSimulationCenter(MO, { now: NOW + 13 * SEC });
  const run = fresh.run;
  assert.equal(run.runRef, ref);
  assert.deepEqual([run.crewId, run.name, run.status, run.step, run.totalSteps, run.speed, run.stepIntervalMs, run.stale, run.active], ["AH-03", "Mei Chen", "running", 3, 12, 8, 1000, false, true]);
  assert.equal(run.operatorName, "You");
  assert.deepEqual(run.readings.items.map((x) => x.value), CHEN_LOW.slice(0, 3));
  assert.ok(run.readings.items.every((x) => x.simulated && x.source === "simulation"));
  assert.deepEqual(run.timeline.items.map((e) => e.kind), ["Reading generated", "Reading generated", "Reading generated", "Started"]);
  // Another officer sees the operator's display name, never the id.
  const other = await s.getSimulationCenter(MO2, { now: NOW + 13 * SEC });
  assert.equal(other.run.operatorName, "Dr. Lena Ortiz");
  // Stale after 3 × interval + 5 s without a step (8× → 8 s).
  assert.equal((await s.getSimulationCenter(MO, { now: NOW + 12 * SEC + 8 * SEC })).run.stale, false);
  assert.equal((await s.getSimulationCenter(MO, { now: NOW + 12 * SEC + 8 * SEC + 1 })).run.stale, true);
  // Recent runs list.
  assert.equal(fresh.recent.items.length, 1);
  assert.deepEqual(fresh.recent.items[0], { crewId: "AH-03", name: "Mei Chen", scenarioName: "Low oxygen saturation demonstration", status: "running", step: 3, totalSteps: 12, speed: 8, startedAt: NOW + SEC, endedAt: 0 });
  // No internal ids anywhere except the opaque runRef.
  const json = JSON.stringify({ ...fresh, run: { ...fresh.run, runRef: "" } });
  for (const bad of ["a-0", "u-med", "sim_", "msr_", "evt_", "operatorId", "astronautId", "createdBy", "simulationRunId"]) assert.ok(!json.includes(bad), bad);
  // A resume counts as activity for the stale flag.
  await s.pauseSimulation(MO, ref, { now: NOW + 100 * SEC });
  await s.resumeSimulation(MO, ref, { now: NOW + 200 * SEC });
  assert.equal((await s.getSimulationCenter(MO, { now: NOW + 202 * SEC })).run.stale, false);
});

test("after completion the center shows the finished run as the last run and offers a new run", async () => {
  await reset();
  const { service: s } = service();
  const ref = await started(s);
  await advanceN(s, ref, 12);
  const c = await s.getSimulationCenter(MO, { now: NOW + 30 * SEC });
  assert.equal(c.active.running, false);
  assert.equal(c.run.status, "completed");
  assert.equal(c.run.active, false);
  assert.equal(c.run.readings.items.length, 12);
  assert.equal(c.run.timeline.items[0].kind, "Completed");
  assert.equal((await started(s, { ...START, crewId: "AH-01" }, NOW + 31 * SEC)).length > 0, true);
});

test("center sections fail independently (partial), and an all-failed load is 'unavailable'", async () => {
  await reset();
  const fail = async () => { throw new DatabaseError("x", { code: "UNKNOWN" }); };
  const ref = await started(service().service);
  const partial = service({ eventsRepo: { ...mock.eventsRepo, getRange: fail } }).service;
  const c = await partial.getSimulationCenter(MO, { now: NOW + 2 * SEC });
  assert.equal(c.status, "ready");
  assert.equal(c.run.timeline.status, "error");
  assert.equal(c.run.readings.status, "ok");
  const noRuns = service({ simulationRunsRepo: { ...mock.simulationRunsRepo, getActive: fail } }).service;
  const d = await noRuns.getSimulationCenter(MO, { now: NOW + 2 * SEC });
  assert.deepEqual(d.active, { status: "error" });
  assert.equal(d.run, null);
  const none = service({ simulationRunsRepo: { ...mock.simulationRunsRepo, getActive: fail }, astronautsRepo: { ...mock.astronautsRepo, getAll: fail } }).service;
  assert.deepEqual([(await none.getSimulationCenter(MO, { now: NOW })).status], ["unavailable"]);
  assert.ok(ref);
});

test("preview returns the exact sequence for the selected astronaut and writes nothing", async () => {
  await reset();
  const { service: s, calls } = service();
  const p = await s.previewSimulation(MO, { crewId: "AH-03", scenarioId: "low_oxygen", astronautId: "a-01" }, { now: NOW });
  assert.equal(p.status, "ready");
  assert.deepEqual(p.crew, { crewId: "AH-03", name: "Mei Chen" });
  assert.deepEqual([p.startValue, p.startSource], [97, "baseline"]);
  assert.deepEqual(p.steps.map((x) => x.value), CHEN_LOW);
  assert.equal(p.scenario.durationsMs[1], 96000);
  assert.equal(p.scenario.durationsMs[8], 12000);
  assert.ok(!calls.some((c) => ["add", "update"].includes(c.method)));
  assert.equal((await s.previewSimulation(MO, { crewId: "AH-03", scenarioId: "nope" }, { now: NOW })).reason, "unknown_scenario");
  assert.ok(!JSON.stringify(p).includes("a-03"));
});

test("36–39. no journal/wellbeing/alert/threshold access; no risk evaluation; alert count unchanged", async () => {
  const src = code("js/services/simulation-service.js");
  for (const bad of ["journalRepo", "wellbeingRepo", "alertsRepo", "alertActionsRepo", "settingsRepo", "thresholds", "risk_detected", "alert_generated", "metaRepo", "cognitiveRepo"]) {
    assert.ok(!src.includes(bad), bad);
  }
  for (const p of ["js/services/simulation-service.js", "js/simulation/scenarios.js", "js/pages/simulation-center.js"]) {
    const imports = [...read(p).matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    if (p.includes("/pages/")) assert.ok(imports.every((i) => /^\.\.\/(services|components|core)\//.test(i)), `${p}: ${imports}`);
    if (p.includes("/services/")) assert.deepEqual(imports, ["../db/index.js", "./access-control.js", "../simulation/scenarios.js"]);
  }
  await reset();
  const alertsBefore = await alertCount();
  const alertIds = (await mock.alertsRepo.query({})).map((a) => a.id);
  assert.ok(alertIds.length >= 4, "seeded alerts present");
  const alertsJson = JSON.stringify(await mock.alertsRepo.query({}));
  const actionsBefore = JSON.stringify(await Promise.all(alertIds.map((id) => mock.alertActionsRepo.getByAlert(id))));
  const { service: s } = service();
  const ref = await started(s);
  await advanceN(s, ref, 12);
  assert.equal(await alertCount(), alertsBefore, "no alert created");
  assert.equal(JSON.stringify(await mock.alertsRepo.query({})), alertsJson, "alerts unchanged");
  assert.equal(JSON.stringify(await Promise.all(alertIds.map((id) => mock.alertActionsRepo.getByAlert(id)))), actionsBefore, "alert actions unchanged");
  const types = new Set((await runEvents("a-03")).map((e) => e.type));
  assert.deepEqual([...types].sort(), ["measurement_recorded", "simulation_started", "simulation_stopped"]);
});

test("40. existing dashboard services show the generated readings with simulation provenance", async () => {
  await reset();
  const { service: s } = service();
  const ref = await started(s, { crewId: "AH-04", scenarioId: "elevated_heart_rate", speed: 8, confirm: true });
  await advanceN(s, ref, 5, 0, NOW + 10 * SEC);
  const at = NOW + 20 * SEC;
  const physical = await import("../../js/services/physical-health-service.js");
  const ph = physical.createPhysicalHealthService({ repos: { usersRepo: mock.usersRepo, astronautsRepo: mock.astronautsRepo, measurementsRepo: mock.measurementsRepo, dailySummariesRepo: mock.dailySummariesRepo, alertsRepo: mock.alertsRepo } });
  const p = await ph.getCrewMemberPhysicalHealth(MO, "AH-04", { now: at });
  const hr = p.latest.items.find((i) => i.key === "heartRate");
  assert.deepEqual([hr.value, hr.source, hr.simulated], [128, "simulation", true]);
  const mission = async () => ({ available: true, name: "TEST-1", missionDay: 3 });
  const allRepos = { ...baseRepos(), dailySummariesRepo: mock.dailySummariesRepo, alertsRepo: mock.alertsRepo, messagesRepo: mock.messagesRepo, cognitiveRepo: mock.cognitiveRepo, wellbeingRepo: mock.wellbeingRepo, settingsRepo: mock.settingsRepo };
  const overview = await import("../../js/services/astronaut-overview-service.js");
  const ov = overview.createAstronautOverviewService({ repos: allRepos, getMissionContext: mission });
  const o = await ov.getAstronautOverview({ role: "astronaut", userId: "u-reyes", astronautId: "a-04" }, { now: at });
  assert.equal(o.status, "ready", JSON.stringify(o).slice(0, 200));
  assert.ok(JSON.stringify(o).includes('"source":"simulation"'), "astronaut Overview sees the simulated reading");
  const crew = await import("../../js/services/crew-monitor-service.js");
  const cm = crew.createCrewMonitorService({ repos: allRepos, getMissionContext: mission });
  const detail = await cm.getCrewMemberDetail(MO, "AH-04", { now: at });
  assert.equal(detail.status, "ready");
  assert.ok(JSON.stringify(detail).includes('"source":"simulation"'), "crew detail sees the simulated reading");
});

test("41–44 regressions: astronaut route denied; DB_VERSION 1; no banned wording; inputs/records not mutated", async () => {
  const { checkRoute } = await import("../../js/auth/guard.js");
  assert.equal(checkRoute({ role: "astronaut", userId: "u-haddad" }, "#/simulation").allowed, false);
  assert.equal(checkRoute({ role: "medical_officer", userId: "u-medofficer" }, "#/simulation").allowed, true);
  const { DB_VERSION, APP_VERSION } = await import("../../js/core/config.js");
  assert.equal(DB_VERSION, 1);
  assert.equal(APP_VERSION, "0.6.0");
  assert.match(read("sw.js"), /const CACHE_VERSION = "0\.6\.0";/);
  const banned = [/\bhealthy\b/i, /\bunhealthy\b/i, /normal health/i, /\bdiagnos(is|ed|e)\b/i, /medically cleared/i, /fit for duty/i, /\btreatment\b/i, /AI health score/i, /clinical risk score/i, /hypoxi/i];
  for (const p of ["js/services/simulation-service.js", "js/pages/simulation-center.js", "js/simulation/scenarios.js", "css/pages/simulation.css"]) {
    const text = read(p).replace(/^\/\/.*$/gm, "");
    for (const re of banned) assert.ok(!re.test(text), `${p}: ${re}`);
  }
  // Service never mutates page input or the records it reads.
  await reset();
  const { service: s } = service();
  const input = Object.freeze({ ...START });
  const ref = (await s.startSimulation(MO, input, { now: NOW + SEC })).runRef;
  const stored = await mock.simulationRunsRepo.getById(ref);
  const frozenRun = Object.freeze({ ...stored });
  const reading = Object.freeze({ expectedStep: 0 });
  const r = await svc.createSimulationService({ repos: { ...baseRepos(), simulationRunsRepo: { ...mock.simulationRunsRepo, getById: async (id, o) => (o ? mock.simulationRunsRepo.getById(id, o) : frozenRun) } }, withTransaction: mock.withTransaction })
    .advanceSimulation(MO, ref, reading, { now: NOW + 2 * SEC });
  assert.equal(r.status, "advanced");
  assert.equal(frozenRun.step, 0);
  assert.ok(Object.isFrozen(cat.SCENARIOS[0]));
});
