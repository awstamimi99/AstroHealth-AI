// tests/unit/live-control-service.test.mjs — Live control (Simulation Center):
// recordManualReading and startCustomCurve in simulation-service.js, the read
// model in live-control-service.js, the live-update subscription in
// js/core/live-updates.js and the bell-badge count in alerts-service.js.
// The real services run over the seeded mock with a test clock.
// Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";
import "./fake-dom.mjs"; // installs the browser globals some imported modules expect

const svc = await import("../../js/services/simulation-service.js");
const liveSvc = await import("../../js/services/live-control-service.js");
const riskSvc = await import("../../js/services/risk-service.js");
const alertsSvc = await import("../../js/services/alerts-service.js");
const liveUpdates = await import("../../js/core/live-updates.js");
const mock = await import("../../js/db/mock-repositories.js");
const cat = await import("../../js/simulation/scenarios.js");
const { PHYSICAL_RULES } = await import("../../js/engine/rules/physical-rules.js");
const { thresholdsFor } = await import("../../js/engine/risk-engine.js");

const SEC = 1000;
const NOW = Date.UTC(2026, 10, 14, 15, 30);
const MO = Object.freeze({ role: "medical_officer", userId: "u-medofficer", astronautId: "" });
const HADDAD = Object.freeze({ role: "astronaut", userId: "u-haddad", astronautId: "a-01" });
const REYES = Object.freeze({ role: "astronaut", userId: "u-reyes", astronautId: "a-04" });
const LEAKS = /\ba-0\d\b|\bu-[a-z]+\b|msr_|evt_|alr_|sim_[0-9a-f]/;

const allRepos = () => Object.fromEntries(Object.entries(mock).filter(([k]) => k.endsWith("Repo")));
function spy(rs) {
  const calls = [];
  const wrapped = {};
  for (const [name, repo] of Object.entries(rs)) {
    wrapped[name] = new Proxy(repo, { get(t, p) { const v = t[p]; return typeof v !== "function" ? v : (...a) => { calls.push({ repo: name, method: String(p), args: a }); return v.apply(t, a); }; } });
  }
  return { repos: wrapped, calls };
}
const reset = () => mock.resetMock({ now: NOW });

/** Simulation service with a recording publisher and an optional risk evaluator. */
function harness({ evaluateRisk = null, publish = null } = {}) {
  const s = spy(allRepos());
  const order = [];
  const events = [];
  const pub = publish || ((name, data) => { order.push(`publish:${name}`); events.push({ name, data }); });
  const evalFn = evaluateRisk === "real"
    ? (() => { const r = riskSvc.createRiskService({ repos: allRepos(), withTransaction: mock.withTransaction }); return async (...a) => { order.push("evaluate"); return r.evaluateAstronaut(...a); }; })()
    : evaluateRisk;
  const service = svc.createSimulationService({ repos: s.repos, withTransaction: mock.withTransaction, evaluateRisk: evalFn, publish: pub });
  return { service, calls: s.calls, order, events };
}
const readings = async (aid, metric) => mock.measurementsRepo.getRange(aid, metric);
const liveEvents = async (aid) => (await mock.eventsRepo.getRange({ astronautId: aid })).filter((e) => e.data && e.data.mode === "live_control");
const writes = (calls) => calls.filter((c) => ["add", "update", "put", "delete"].includes(c.method));

// =====================================================================================
// recordManualReading — authorization and input
// =====================================================================================

test("manual reading: non-officer sessions are refused before any crew, run or measurement access", async () => {
  await reset();
  for (const [session, reason] of [[null, "no_session"], [HADDAD, "not_medical_officer"], [{ role: "medical-officer", userId: "u-medofficer", astronautId: "" }, "not_medical_officer"], [{ role: "medical_officer", userId: "u-haddad", astronautId: "" }, "account_mismatch"]]) {
    const h = harness();
    for (const r of [
      await h.service.recordManualReading(session, { crewId: "AH-04", metric: "spo2", value: 88 }, { now: NOW + SEC }),
      await h.service.startCustomCurve(session, { crewId: "AH-04", metric: "spo2", values: [95, 94, 93, 92, 91, 90], speed: 8, confirm: true }, { now: NOW + SEC }),
    ]) assert.deepEqual([r.status, r.reason], ["forbidden", reason], JSON.stringify(session));
    assert.deepEqual(h.calls.filter((c) => c.repo !== "usersRepo"), [], "only the officer check ran");
    assert.deepEqual(h.events, [], "nothing published");
  }
});

test("manual reading: invalid metric, diastolic alone, missing or inverted pair and bad crew IDs write nothing", async () => {
  await reset();
  const h = harness();
  const cases = [
    [{ crewId: "AH-04", metric: "bodyTemp", value: 37 }, "invalid", "invalid_metric"],
    [{ crewId: "AH-04", metric: "bpDiastolic", value: 80 }, "invalid", "pair_required"],
    [{ crewId: "AH-04", metric: "bpSystolic", value: 130 }, "invalid", "pair_required"],
    [{ crewId: "AH-04", metric: "bpSystolic", value: 90, diastolic: 95 }, "invalid", "invalid_pair"],
    [{ crewId: "AH-04", metric: "spo2", value: "88" }, "invalid", "invalid_value"],
    [{ crewId: "AH-04", metric: "spo2", value: Number.NaN }, "invalid", "invalid_value"],
    [{ crewId: "a-04", metric: "spo2", value: 88 }, "not_found", "invalid_crew_id"],
    [{ crewId: "AH-99", metric: "spo2", value: 88 }, "not_found", "unknown_crew_id"],
  ];
  for (const [input, status, reason] of cases) {
    const r = await h.service.recordManualReading(MO, input, { now: NOW + SEC });
    assert.deepEqual([r.status, r.reason], [status, reason], JSON.stringify(input));
  }
  assert.deepEqual(writes(h.calls), []);
  assert.deepEqual(h.events, []);
});

test("manual reading: values are clamped to the metric's input limits and rounded to its step", async () => {
  await reset();
  const h = harness();
  const r1 = await h.service.recordManualReading(MO, { crewId: "AH-04", metric: "spo2", value: 12 }, { now: NOW + SEC });
  assert.equal(r1.status, "recorded");
  assert.equal(r1.readings[0].value, cat.liveMetric("spo2").min);
  const r2 = await h.service.recordManualReading(MO, { crewId: "AH-04", metric: "spo2", value: 140 }, { now: NOW + 2 * SEC });
  assert.equal(r2.readings[0].value, 100);
  const r3 = await h.service.recordManualReading(MO, { crewId: "AH-04", metric: "sleepDuration", value: 5.04 }, { now: NOW + 3 * SEC });
  assert.equal(r3.readings[0].value, 5);
  assert.equal(cat.clampLiveValue("heartRate", 250), 220);
  assert.equal(cat.clampLiveValue("activity", 1234), 1200);
  assert.equal(cat.clampLiveValue("unknown", 1), null);
});

// =====================================================================================
// recordManualReading — writes
// =====================================================================================

test("manual reading: written through measurementsRepo.add for the resolved member only; latest updates; timeline event", async () => {
  await reset();
  const h = harness();
  const beforeChen = (await readings("a-03", "spo2")).length;
  const r = await h.service.recordManualReading(MO, { crewId: "AH-04", metric: "spo2", value: 88, astronautId: "a-03", userId: "u-chen", timestamp: 1 }, { now: NOW + SEC });
  assert.equal(r.status, "recorded");
  assert.deepEqual(r.crew, { crewId: "AH-04", name: "Jonas Reyes" }, "the result names who was updated");
  const adds = h.calls.filter((c) => c.repo === "measurementsRepo" && c.method === "add");
  assert.equal(adds.length, 1);
  const rec = adds[0].args[0];
  assert.equal(rec.astronautId, "a-04", "page-supplied astronautId is ignored");
  assert.equal(rec.timestamp, NOW + SEC, "service-controlled time, never backdated");
  assert.deepEqual([rec.metric, rec.value, rec.source, rec.quality, rec.createdBy], ["spo2", 88, "simulation", "ok", "u-medofficer"]);
  assert.ok(!h.calls.some((c) => ["astronautsRepo", "dailySummariesRepo"].includes(c.repo) && ["update", "put"].includes(c.method)), "latest / summaries are kept by measurementsRepo.add");
  const reyes = await mock.astronautsRepo.getById("a-04");
  assert.deepEqual([reyes.latest.spo2.value, reyes.latest.spo2.timestamp], [88, NOW + SEC]);
  assert.equal((await readings("a-03", "spo2")).length, beforeChen, "nobody else changed");
  const ev = await liveEvents("a-04");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, "measurement_recorded");
  assert.match(ev[0].summary, /Live control: SpO₂ 88 % \(synthetic\)/);
  assert.doesNotMatch(JSON.stringify(r), LEAKS, "no internal ids in the result");
});

test("manual reading: blood pressure is written as a pair with one timestamp and sampleId", async () => {
  await reset();
  const h = harness();
  const r = await h.service.recordManualReading(MO, { crewId: "AH-02", metric: "bpSystolic", value: 150, diastolic: 95 }, { now: NOW + SEC });
  assert.equal(r.status, "recorded");
  assert.deepEqual(r.readings.map((x) => [x.metric, x.value]), [["bpSystolic", 150], ["bpDiastolic", 95]]);
  const sys = (await readings("a-02", "bpSystolic")).at(-1);
  const dia = (await readings("a-02", "bpDiastolic")).at(-1);
  assert.equal(sys.timestamp, NOW + SEC);
  assert.equal(dia.timestamp, NOW + SEC);
  assert.ok(sys.sampleId && sys.sampleId === dia.sampleId, "same sampleId");
});

test("manual reading: time must be later than the member's latest reading (monotonic); nothing written otherwise", async () => {
  await reset();
  const h = harness();
  assert.equal((await h.service.recordManualReading(MO, { crewId: "AH-04", metric: "heartRate", value: 90 }, { now: NOW + 5 * SEC })).status, "recorded");
  const before = (await readings("a-04", "heartRate")).length;
  for (const t of [NOW + 5 * SEC, NOW + 4 * SEC]) {
    const r = await h.service.recordManualReading(MO, { crewId: "AH-04", metric: "heartRate", value: 95 }, { now: t });
    assert.deepEqual([r.status, r.reason], ["conflict", "clock_not_monotonic"]);
  }
  assert.equal((await readings("a-04", "heartRate")).length, before);
  // Another member's clock is independent.
  assert.equal((await h.service.recordManualReading(MO, { crewId: "AH-03", metric: "heartRate", value: 90 }, { now: NOW + 5 * SEC })).status, "recorded");
});

test("manual reading: refused while that member has the active run; other members still work", async () => {
  await reset();
  const h = harness();
  const start = await h.service.startSimulation(MO, { crewId: "AH-03", scenarioId: "low_oxygen", speed: 8, confirm: true }, { now: NOW + SEC });
  assert.equal(start.status, "started");
  const r = await h.service.recordManualReading(MO, { crewId: "AH-03", metric: "spo2", value: 90 }, { now: NOW + 2 * SEC });
  assert.deepEqual([r.status, r.reason], ["conflict", "run_active_for_member"]);
  assert.equal((await h.service.recordManualReading(MO, { crewId: "AH-04", metric: "spo2", value: 90 }, { now: NOW + 2 * SEC })).status, "recorded");
});

// =====================================================================================
// Risk evaluation and live events
// =====================================================================================

test("events: health:changed is published after the commit, then risk is evaluated, then alerts-changed if an alert changed", async () => {
  await reset();
  const h = harness({ evaluateRisk: "real" });
  // PHY-02 reads SpO₂ "below" on 2 consecutive readings: two low readings open an alert.
  const r1 = await h.service.recordManualReading(MO, { crewId: "AH-04", metric: "spo2", value: 85 }, { now: NOW + SEC });
  const r2 = await h.service.recordManualReading(MO, { crewId: "AH-04", metric: "spo2", value: 84 }, { now: NOW + 2 * SEC });
  assert.equal(r1.status, "recorded");
  assert.equal(r2.risk.status, "evaluated");
  const opened = r2.risk.changes.find((c) => c.ruleId === "PHY-02");
  assert.ok(opened, JSON.stringify(r2.risk.changes));
  const rule = r2.risk.rules.find((x) => x.ruleId === "PHY-02");
  assert.equal(rule.metric, "spo2");
  assert.ok(rule.explanation.length > 0 && rule.limitsText.length > 0, "the engine's own explanation and limits are passed through");
  // Order on the second write: publish(health) → evaluate → publish(health, alertsChanged) + alert:changed.
  const second = h.order.slice(h.order.lastIndexOf("evaluate") - 1);
  assert.deepEqual(second, ["publish:health:changed", "evaluate", "publish:health:changed", "publish:alert:changed"]);
  const health = h.events.filter((e) => e.name === "health:changed");
  for (const e of health) assert.deepEqual(Object.keys(e.data).sort(), ["alertsChanged", "crewId", "metric"], "safe payload only");
  assert.deepEqual(health.at(-1).data, { crewId: "AH-04", metric: "spo2", alertsChanged: true });
  const open = (await mock.alertsRepo.query({ astronautId: "a-04" })).filter((a) => a.ruleId === "PHY-02" && a.status !== "resolved");
  assert.equal(open.length, 1);
});

test("events: a refused or failed write publishes nothing and never evaluates risk; a throwing publisher never undoes a commit", async () => {
  await reset();
  let evaluated = 0;
  const h = harness({ evaluateRisk: async () => { evaluated += 1; return { status: "evaluated", rules: [] }; } });
  await h.service.recordManualReading(MO, { crewId: "AH-04", metric: "bpDiastolic", value: 80 }, { now: NOW + SEC });
  await h.service.recordManualReading(MO, { crewId: "AH-99", metric: "spo2", value: 80 }, { now: NOW + SEC });
  const broken = svc.createSimulationService({
    repos: { ...allRepos(), measurementsRepo: { ...mock.measurementsRepo, add: async () => { throw new Error("disk"); } } },
    withTransaction: mock.withTransaction,
    evaluateRisk: async () => { evaluated += 1; return { status: "evaluated", rules: [] }; },
    publish: (n, d) => h.events.push({ n, d }),
  });
  const failed = await broken.recordManualReading(MO, { crewId: "AH-04", metric: "spo2", value: 80 }, { now: NOW + SEC });
  assert.deepEqual([failed.status, failed.reason], ["unavailable", "database_error"]);
  assert.deepEqual(h.events, []);
  assert.equal(evaluated, 0);

  const throwing = harness({ publish: () => { throw new Error("channel closed"); } });
  const ok = await throwing.service.recordManualReading(MO, { crewId: "AH-04", metric: "spo2", value: 90 }, { now: NOW + 2 * SEC });
  assert.equal(ok.status, "recorded");
  assert.equal((await mock.astronautsRepo.getById("a-04")).latest.spo2.value, 90);
});

test("events: an evaluator error is reported as unavailable without hiding the committed reading", async () => {
  await reset();
  const h = harness({ evaluateRisk: async () => { throw new Error("boom"); } });
  const r = await h.service.recordManualReading(MO, { crewId: "AH-04", metric: "spo2", value: 90 }, { now: NOW + SEC });
  assert.equal(r.status, "recorded");
  assert.deepEqual([r.risk.status, r.risk.reason], ["unavailable", "unexpected_error"]);
  assert.deepEqual(h.events.map((e) => [e.name, e.data.alertsChanged]), [["health:changed", false]]);
});

// =====================================================================================
// startCustomCurve
// =====================================================================================

test("custom curve: input validation and confirmation; no run is created when refused", async () => {
  await reset();
  const h = harness();
  const ok = { crewId: "AH-04", metric: "heartRate", values: [80, 90, 100, 110, 120, 130], speed: 8, confirm: true };
  const cases = [
    [{ ...ok, metric: "sleepDuration" }, "invalid_metric"],
    [{ ...ok, metric: "activity" }, "invalid_metric"],
    [{ ...ok, values: [80, 90, 100, 110, 120] }, "invalid_curve"],
    [{ ...ok, values: Array(13).fill(90) }, "invalid_curve"],
    [{ ...ok, values: [80, 90, "x", 110, 120, 130] }, "invalid_curve"],
    [{ ...ok, metric: "bpSystolic" }, "pair_required"],
    [{ ...ok, metric: "bpSystolic", values: [120, 125, 130, 135, 140, 85], diastolic: 90 }, "invalid_pair"],
    [{ ...ok, speed: 3 }, "invalid_speed"],
    [{ ...ok, confirm: "yes" }, "confirmation_required"],
  ];
  for (const [input, reason] of cases) {
    const r = await h.service.startCustomCurve(MO, input, { now: NOW + SEC });
    assert.deepEqual([r.status, r.reason], ["invalid", reason], JSON.stringify(input));
  }
  assert.deepEqual(writes(h.calls), []);
});

test("custom curve: the drawn values are stored on the run, played one per step, then the run completes", async () => {
  await reset();
  const h = harness();
  const values = [70, 80, 95, 112, 125, 130, 400]; // last one is clamped to the input max (220)
  const s = await h.service.startCustomCurve(MO, { crewId: "AH-04", metric: "heartRate", values, speed: 4, confirm: true }, { now: NOW + SEC });
  assert.equal(s.status, "started");
  assert.equal(s.run.totalSteps, 7);
  assert.equal(s.run.crewId, "AH-04");
  const [run] = await mock.simulationRunsRepo.getByAstronaut("a-04");
  assert.equal(run.scenarioId, cat.CUSTOM_CURVE_ID);
  assert.deepEqual([run.customMetric, run.customValues], ["heartRate", [70, 80, 95, 112, 125, 130, 220]]);
  assert.equal(svc.customScenarioOf(run).totalSteps, 7);

  const got = [];
  for (let i = 0; i < 7; i += 1) {
    const r = await h.service.advanceSimulation(MO, s.runRef, { expectedStep: i }, { now: NOW + (10 + i) * SEC });
    got.push(r.reading.value);
    if (i < 6) assert.equal(r.status, "advanced");
    else assert.equal(r.status, "completed");
  }
  assert.deepEqual(got, [70, 80, 95, 112, 125, 130, 220]);
  const hr = (await readings("a-04", "heartRate")).filter((m) => m.simulationRunId === run.id).map((m) => m.value);
  assert.deepEqual(hr, got);
  assert.equal(h.events.filter((e) => e.name === "health:changed").length, 7, "one notice per committed step");
});

test("custom curve: blood-pressure steps carry the paired diastolic value; only one run can be active", async () => {
  await reset();
  const h = harness();
  const s = await h.service.startCustomCurve(MO, { crewId: "AH-02", metric: "bpSystolic", values: [120, 130, 140, 150, 145, 135], diastolic: 88, speed: 8, confirm: true }, { now: NOW + SEC });
  assert.equal(s.status, "started");
  const other = await h.service.startCustomCurve(MO, { crewId: "AH-04", metric: "spo2", values: [95, 94, 93, 92, 91, 90], speed: 8, confirm: true }, { now: NOW + 2 * SEC });
  assert.deepEqual([other.status, other.reason], ["conflict", "another_run_active"]);
  assert.deepEqual([other.activeRun.crewId, other.activeRun.name], ["AH-02", "Aisha Karim"], "says who has the run");
  const r = await h.service.advanceSimulation(MO, s.runRef, { expectedStep: 0 }, { now: NOW + 10 * SEC });
  assert.equal(r.status, "advanced");
  const sys = (await readings("a-02", "bpSystolic")).at(-1);
  const dia = (await readings("a-02", "bpDiastolic")).at(-1);
  assert.deepEqual([sys.value, dia.value, dia.timestamp, dia.sampleId], [120, 88, sys.timestamp, sys.sampleId]);
});

test("custom curve: a stored run with tampered values is not playable", () => {
  const base = { scenarioId: cat.CUSTOM_CURVE_ID, customMetric: "spo2", customValues: [95, 94, 93, 92, 91, 90] };
  assert.ok(svc.customScenarioOf(base));
  assert.equal(svc.customScenarioOf({ ...base, customValues: [95, 94, 93, 92, 91, 10] }), null, "outside the input limits");
  assert.equal(svc.customScenarioOf({ ...base, customValues: [95, 94, 93] }), null, "too few points");
  assert.equal(svc.customScenarioOf({ ...base, customMetric: "sleepDuration" }), null, "no curve for this metric");
  assert.equal(svc.customScenarioOf({ ...base, customMetric: "bpSystolic", customValues: [120, 121, 122, 123, 124, 125] }), null, "pair missing");
  assert.equal(svc.customScenarioOf({ ...base, scenarioId: "low_oxygen" }), null);
});

// =====================================================================================
// live-control-service (read model)
// =====================================================================================

const live = () => { const s = spy(allRepos()); return { calls: s.calls, service: liveSvc.createLiveControlService({ repos: s.repos }) }; };

test("read model: Medical Officer only, verified before any other read", async () => {
  await reset();
  for (const session of [null, HADDAD, REYES]) {
    const l = live();
    const r = await l.service.getLiveControl(session, { crewId: "AH-04" }, { now: NOW });
    assert.equal(r.status, "forbidden");
    assert.deepEqual(l.calls.filter((c) => c.repo !== "usersRepo"), []);
  }
});

test("read model: crew list for the picker with no default selection and no internal ids", async () => {
  await reset();
  const r = await live().service.getLiveControl(MO, {}, { now: NOW });
  assert.equal(r.status, "ready");
  assert.equal(r.selection, "none");
  assert.equal(r.selected, null);
  assert.deepEqual(r.crew.map((c) => c.crewId), ["AH-01", "AH-02", "AH-03", "AH-04"]);
  assert.deepEqual(r.crew.map((c) => c.name), ["Sami Haddad", "Aisha Karim", "Mei Chen", "Jonas Reyes"]);
  for (const c of r.crew) assert.equal(c.alerts.status, "ok");
  assert.deepEqual(r.curve, { minPoints: cat.CURVE_MIN_POINTS, maxPoints: cat.CURVE_MAX_POINTS });
  assert.equal(r.notes.synthetic, "Synthetic demonstration data");
  assert.doesNotMatch(JSON.stringify(r), LEAKS);
});

test("read model: the selected member's charts carry readings, baseline and the rule limits from the risk engine", async () => {
  await reset();
  const r = await live().service.getLiveControl(MO, { crewId: "AH-04" }, { now: NOW });
  assert.equal(r.selection, "ok");
  assert.equal(r.selected.name, "Jonas Reyes");
  assert.deepEqual(r.selected.metrics.map((m) => m.key), cat.LIVE_METRICS.map((m) => m.key), "every live metric, none invented");
  const spo2 = r.selected.metrics.find((m) => m.key === "spo2");
  assert.equal(spo2.baseline, 98);
  assert.ok(spo2.readings.items.length > 0);
  assert.ok(spo2.readings.items.every((x, i, a) => i === 0 || a[i - 1].timestamp <= x.timestamp), "oldest first");
  const stored = await mock.settingsRepo.get("thresholds");
  const rule = PHYSICAL_RULES.find((x) => x.metric === "spo2");
  const bounds = thresholdsFor(rule, stored);
  assert.deepEqual([spo2.rule.id, spo2.rule.warning, spo2.rule.critical], [rule.id, bounds.warning, bounds.critical], "limits come from the engine + stored settings");
  assert.equal(r.selected.metrics.find((m) => m.key === "fatigue").rule, null, "no rule reads fatigue, so none is shown");
  assert.doesNotMatch(JSON.stringify(r), LEAKS);
});

test("read model: an invalid or unknown crew ID gives the crew list and a reason, never someone's data", async () => {
  await reset();
  for (const [crewId, reason] of [["AH-99", "unknown_crew_id"], ["a-04", "invalid_crew_id"]]) {
    const r = await live().service.getLiveControl(MO, { crewId }, { now: NOW });
    assert.equal(r.status, "ready");
    assert.equal(r.selected, null);
    assert.equal(r.selection, reason);
  }
});

// =====================================================================================
// alerts-service.countOpenAlerts (top-bar badge)
// =====================================================================================

test("bell badge: counts only, an astronaut sees only their own open alerts", async () => {
  await reset();
  const a = alertsSvc.createAlertsService({ repos: allRepos(), withTransaction: mock.withTransaction });
  const crew = await a.countOpenAlerts(MO, { now: NOW });
  assert.equal(crew.status, "ready");
  const own = [];
  for (const [session, aid] of [[HADDAD, "a-01"], [REYES, "a-04"]]) {
    const r = await a.countOpenAlerts(session, { now: NOW });
    const expected = (await mock.alertsRepo.query({ astronautId: aid })).filter((x) => x.status === "new" || x.status === "acknowledged").length;
    assert.equal(r.open, expected, aid);
    assert.deepEqual(Object.keys(r).sort(), ["generatedAt", "open", "reason", "status", "topSeverity", "unacknowledged", "viewer"]);
    own.push(r.open);
  }
  assert.ok(crew.open >= own[0] + own[1]);
  assert.equal((await a.countOpenAlerts(null, { now: NOW })).status, "forbidden");
});

// =====================================================================================
// js/core/live-updates.js
// =====================================================================================

function fakeSource() {
  const handlers = new Map();
  return {
    on(name, fn) { const list = handlers.get(name) || []; list.push(fn); handlers.set(name, list); return () => handlers.set(name, (handlers.get(name) || []).filter((h) => h !== fn)); },
    emit(name, data) { for (const fn of handlers.get(name) || []) fn(data); },
    count: () => [...handlers.values()].reduce((n, l) => n + l.length, 0),
  };
}
function fakeSchedule() {
  const pending = new Map();
  let id = 0;
  return { set: (fn) => { id += 1; pending.set(id, fn); return id; }, clear: (i) => pending.delete(i), flush: () => { const fns = [...pending.values()]; pending.clear(); fns.forEach((f) => f()); }, size: () => pending.size };
}

test("live updates: crew filter — another member's change is ignored; crew-wide screens take every change", () => {
  assert.equal(liveUpdates.concerns("health:changed", { crewId: "AH-04" }, "AH-04"), true);
  assert.equal(liveUpdates.concerns("health:changed", { crewId: "AH-03" }, "AH-04"), false);
  assert.equal(liveUpdates.concerns("health:changed", { crewId: "AH-03" }, ""), true);
  assert.equal(liveUpdates.concerns("health:changed", { crewId: "AH-03" }, null), true);
  assert.equal(liveUpdates.concerns("alert:changed", {}, "AH-04"), true);

  const src = fakeSource();
  const sch = fakeSchedule();
  const seen = [];
  liveUpdates.onHealthChanged({ crewId: () => "AH-04", reload: (info) => seen.push(info), source: src, schedule: sch });
  src.emit("health:changed", { crewId: "AH-03", metric: "spo2", alertsChanged: true });
  sch.flush();
  assert.deepEqual(seen, [], "AH-03's change never reaches AH-04's screen");
  src.emit("health:changed", { crewId: "AH-04", metric: "spo2", alertsChanged: false });
  sch.flush();
  assert.deepEqual(seen, [{ name: "health:changed", data: { crewId: "AH-04", metric: "spo2", alertsChanged: false } }]);
});

test("live updates: a burst of events is merged into one reload; a failing reload is contained", () => {
  const src = fakeSource();
  const sch = fakeSchedule();
  let n = 0;
  liveUpdates.onHealthChanged({ crewId: () => "", reload: () => { n += 1; throw new Error("render failed"); }, source: src, schedule: sch });
  const errors = console.error;
  console.error = () => {};
  try {
    src.emit("health:changed", { crewId: "AH-01", metric: "spo2" });
    src.emit("alert:changed", {});
    src.emit("simulation:changed", {});
    assert.equal(sch.size(), 1);
    sch.flush();
  } finally {
    console.error = errors;
  }
  assert.equal(n, 1);
});

test("live updates: the navigation AbortSignal unsubscribes and cancels a pending reload (no piling listeners)", () => {
  const src = fakeSource();
  const sch = fakeSchedule();
  let n = 0;
  const c = new AbortController();
  liveUpdates.onHealthChanged({ signal: c.signal, reload: () => { n += 1; }, source: src, schedule: sch });
  assert.equal(src.count(), liveUpdates.LIVE_EVENTS.length);
  src.emit("health:changed", { crewId: "AH-01" });
  c.abort();
  sch.flush();
  assert.equal(n, 0);
  assert.equal(src.count(), 0, "all listeners removed");
  const already = new AbortController();
  already.abort();
  liveUpdates.onHealthChanged({ signal: already.signal, reload: () => { n += 1; }, source: src, schedule: sch });
  assert.equal(src.count(), 0, "an aborted view never subscribes");
});
