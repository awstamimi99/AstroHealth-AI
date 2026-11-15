// tests/unit/risk-service.test.mjs — Sprint 8 risk evaluation: authorization, atomic
// lifecycle writes with rollback, idempotency, concurrency, recurrence, the
// simulation → alert workflow and cross-dashboard consistency.
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

const risk = await import("../../js/services/risk-service.js");
const sim = await import("../../js/services/simulation-service.js");
const alertsSvc = await import("../../js/services/alerts-service.js");
const mock = await import("../../js/db/mock-repositories.js");
const { DatabaseError } = await import("../../js/db/index.js");

const SEC = 1000;
const NOW = Date.UTC(2026, 10, 14, 15, 30);
const MO = Object.freeze({ role: "medical_officer", userId: "u-medofficer", astronautId: "" });
const MO2 = Object.freeze({ role: "medical_officer", userId: "u-medbackup", astronautId: "" });
const CHEN = Object.freeze({ role: "astronaut", userId: "u-chen", astronautId: "a-03" });

const baseRepos = () => ({
  usersRepo: mock.usersRepo, astronautsRepo: mock.astronautsRepo, measurementsRepo: mock.measurementsRepo, settingsRepo: mock.settingsRepo,
  alertsRepo: mock.alertsRepo, alertActionsRepo: mock.alertActionsRepo, eventsRepo: mock.eventsRepo, simulationRunsRepo: mock.simulationRunsRepo,
});
function spy(rs) {
  const calls = [];
  const wrapped = {};
  for (const [name, repo] of Object.entries(rs)) wrapped[name] = new Proxy(repo, { get(t, p) { const v = t[p]; return typeof v !== "function" ? v : (...a) => { calls.push({ repo: name, method: String(p), args: a }); return v.apply(t, a); }; } });
  return { repos: wrapped, calls };
}
/** Models IndexedDB: overlapping readwrite transactions run one after another. */
function serialTx() {
  let tail = Promise.resolve();
  const stores = [];
  const run = (names, mode, work) => {
    stores.push([...names]);
    const next = tail.then(() => mock.withTransaction(names, mode, work));
    tail = next.catch(() => {});
    return next;
  };
  return { run, stores };
}
function service(overrides = {}, tx = serialTx()) {
  const s = spy({ ...baseRepos(), ...overrides });
  return { ...s, tx, service: risk.createRiskService({ repos: s.repos, withTransaction: tx.run, exercise: false }) };
}
const reset = () => mock.resetMock({ now: NOW });
const allAlerts = () => mock.alertsRepo.query({});
const snapshot = async () => JSON.stringify({ alerts: await allAlerts(), actions: await Promise.all((await allAlerts()).map((a) => mock.alertActionsRepo.getByAlert(a.id))), events: await mock.eventsRepo.getRange({}), meta: await mock.metaRepo.get("alertCounter") });
/** Add synthetic readings directly through the repository (as a committed simulation step would). */
async function addReadings(aid, metric, values, startAt, stepMs = SEC, extra = {}) {
  const unit = { heartRate: "bpm", spo2: "%", bpSystolic: "mmHg", sleepDuration: "h" }[metric];
  for (let i = 0; i < values.length; i += 1) await mock.measurementsRepo.add({ astronautId: aid, metric, value: values[i], unit, timestamp: startAt + i * stepMs, source: "simulation", quality: "ok", ...extra });
}

// =====================================================================================

test("authorization first: astronauts and mismatched sessions are refused before any health or alert read", async () => {
  await reset();
  for (const [session, reason] of [[null, "no_session"], [CHEN, "not_medical_officer"], [{ role: "medical_officer", userId: "u-chen", astronautId: "" }, "account_mismatch"], [{ ...MO, astronautId: "a-01" }, "invalid_session"]]) {
    const { service: s, calls } = service();
    for (const r of [await s.evaluateCrew(session, { now: NOW }), await s.evaluateAstronaut(session, "AH-03", { now: NOW })]) assert.deepEqual([r.status, r.reason], ["forbidden", reason]);
    assert.deepEqual(calls.filter((c) => c.repo !== "usersRepo"), [], "no reads before authorization");
  }
  const { service: s, calls } = service();
  assert.equal((await s.evaluateAstronaut(MO, "a-03", { now: NOW })).reason, "invalid_crew_id");
  assert.equal((await s.evaluateAstronaut(MO, "AH-99", { now: NOW })).reason, "unknown_crew_id");
  assert.ok(!calls.some((c) => ["measurementsRepo", "alertsRepo"].includes(c.repo)));
});

test("seed dry run (mock): evaluating the untouched seed writes nothing; ALT-0190's evidence is recognised", async () => {
  await reset();
  const before = await snapshot();
  const { service: s } = service();
  const r = await s.evaluateCrew(MO, { now: NOW });
  assert.equal(r.status, "evaluated");
  assert.deepEqual(r.members.map((m) => m.crewId), ["AH-01", "AH-02", "AH-03", "AH-04"]);
  assert.ok(r.members.every((m) => m.rules.every((x) => x.change === "none")));
  const sleep = r.members[3].rules.find((x) => x.ruleId === "PHY-05");
  assert.deepEqual([sleep.outcome, sleep.reason, sleep.alertNumber], ["triggered", "no_new_evidence", "ALT-0190"]);
  assert.equal(await snapshot(), before, "no alert, action, event or counter change");
  assert.equal(r.thresholdLabel, "Demonstration threshold — not clinically validated.");
});

test("open: alert + created action + 2 events + new number, atomically; repeat evaluation is unchanged", async () => {
  await reset();
  const { service: s, tx } = service();
  await addReadings("a-03", "spo2", [92, 91], NOW + SEC); // PHY-02 v2: 90–92 % = warning
  const r = await s.evaluateAstronaut(MO, "AH-03", { now: NOW + 10 * SEC });
  const phy2 = r.rules.find((x) => x.ruleId === "PHY-02");
  assert.deepEqual([phy2.change, phy2.alertNumber, phy2.alertSeverity], ["opened", "ALT-0191", "warning"]);
  assert.deepEqual(tx.stores, [["measurements", "alerts", "meta", "alertActions", "missionEvents"]]);
  const a = (await allAlerts()).find((x) => x.number === "ALT-0191");
  assert.deepEqual([a.astronautId, a.ruleId, a.severity, a.status, a.occurrenceCount, a.detectedAt, a.createdBy, a.rule.version], ["a-03", "PHY-02", "warning", "new", 1, NOW + 10 * SEC, "system", 2]);
  assert.deepEqual(a.triggeringMeasurements.map((e) => [e.value, e.source, e.quality]), [[92, "simulation", "ok"], [91, "simulation", "ok"]]);
  assert.ok(a.triggeringMeasurements.every((e) => Object.keys(e).sort().join() === "measurementId,metric,quality,source,timestamp,unit,value"));
  assert.deepEqual((await mock.alertActionsRepo.getByAlert(a.id)).map((x) => [x.action, x.userId]), [["created", "system"]]);
  assert.deepEqual((await mock.eventsRepo.getRange({ astronautId: "a-03" })).filter((e) => e.refId === a.id).map((e) => e.type).sort(), ["alert_generated", "risk_detected"]);
  assert.equal(await mock.metaRepo.get("alertCounter"), 191);
  // Identical repeat → unchanged, nothing written.
  const before = await snapshot();
  const again = await s.evaluateAstronaut(MO, "AH-03", { now: NOW + 20 * SEC });
  assert.equal(again.rules.find((x) => x.ruleId === "PHY-02").change, "none");
  assert.equal(await snapshot(), before);
  // Presentation-safe output.
  const json = JSON.stringify(r);
  for (const bad of ["a-03", "alr_", "msr_", "u-med"]) assert.ok(!json.includes(bad), bad);
});

test("rollback after every possible failed write: open / escalate / clear write all or nothing", async () => {
  const failOn = (repo, method, when = () => true) => ({ [repo]: { ...mock[repo], [method]: async (...a) => { if (when(...a)) throw new DatabaseError("forced", { code: "QUOTA" }); return mock[repo][method](...a); } } });
  const cases = [
    ["open", failOn("alertsRepo", "add")],
    ["open", failOn("alertActionsRepo", "add")],
    ["open", failOn("eventsRepo", "add", (r) => r.type === "risk_detected")],
    ["open", failOn("eventsRepo", "add", (r) => r.type === "alert_generated")],
  ];
  for (const [label, override] of cases) {
    await reset();
    await addReadings("a-03", "spo2", [93, 92], NOW + SEC);
    const before = await snapshot();
    const r = await service(override).service.evaluateAstronaut(MO, "AH-03", { now: NOW + 10 * SEC });
    assert.deepEqual([r.status, r.reason], ["unavailable", "database_error"], label);
    assert.equal(await snapshot(), before, `${label}: nothing written (alert number not consumed)`);
  }
  // Escalate + clear failures.
  for (const [label, values, override] of [
    ["escalate", [90, 88], failOn("alertActionsRepo", "add", (r) => r.action === "escalated")],
    ["escalate", [90, 88], failOn("eventsRepo", "add", (r) => r.type === "alert_escalated")],
    ["escalate", [90, 88], failOn("alertsRepo", "update")],
    ["clear", [95, 97], failOn("alertActionsRepo", "add", (r) => r.action === "condition_cleared")],
    ["clear", [95, 97], failOn("eventsRepo", "add", (r) => r.type === "alert_condition_cleared")],
    ["clear", [95, 97], failOn("alertsRepo", "update")],
  ]) {
    await reset();
    await addReadings("a-03", "spo2", [93, 92], NOW + SEC);
    await service().service.evaluateAstronaut(MO, "AH-03", { now: NOW + 10 * SEC });
    await addReadings("a-03", "spo2", values, NOW + 20 * SEC);
    const before = await snapshot();
    const r = await service(override).service.evaluateAstronaut(MO, "AH-03", { now: NOW + 30 * SEC });
    assert.equal(r.status, "unavailable", label);
    assert.equal(await snapshot(), before, `${label}: rolled back`);
    // Next evaluation (working repositories) performs it from the current stored data.
    const ok = await service().service.evaluateAstronaut(MO, "AH-03", { now: NOW + 40 * SEC });
    assert.equal(ok.rules.find((x) => x.ruleId === "PHY-02").change, label === "escalate" ? "escalated" : "condition_cleared");
  }
});

test("escalation of an acknowledged alert: back to new, acknowledgement cleared on the record but kept in the audit trail", async () => {
  await reset();
  const s = service().service;
  const a = alertsSvc.createAlertsService({ repos: baseRepos(), withTransaction: mock.withTransaction });
  await addReadings("a-03", "spo2", [92, 91], NOW + SEC);
  await s.evaluateAstronaut(MO, "AH-03", { now: NOW + 10 * SEC });
  assert.equal((await a.acknowledgeAlert(MO, "ALT-0191", {}, { now: NOW + 11 * SEC })).status, "acknowledged");
  await addReadings("a-03", "spo2", [88, 87], NOW + 20 * SEC);
  const r = await s.evaluateAstronaut(MO, "AH-03", { now: NOW + 30 * SEC });
  assert.equal(r.rules.find((x) => x.ruleId === "PHY-02").change, "escalated");
  const alert = (await allAlerts()).find((x) => x.number === "ALT-0191");
  assert.deepEqual([alert.severity, alert.status, alert.acknowledgedAt, alert.acknowledgedBy, alert.occurrenceCount], ["critical", "new", 0, "", 2]);
  assert.deepEqual((await mock.alertActionsRepo.getByAlert(alert.id)).map((x) => x.action), ["created", "acknowledged", "escalated"]);
  const evs = (await mock.eventsRepo.getRange({ astronautId: "a-03" })).filter((e) => e.refId === alert.id).map((e) => e.type);
  assert.ok(evs.includes("alert_acknowledged") && evs.includes("alert_escalated"));
  // Severity never decreases automatically.
  await addReadings("a-03", "spo2", [93, 93], NOW + 40 * SEC);
  await s.evaluateAstronaut(MO, "AH-03", { now: NOW + 50 * SEC });
  assert.equal((await allAlerts()).find((x) => x.number === "ALT-0191").severity, "critical");
});

test("concurrent two-tab evaluation creates one alert; double click in one tab is busy", async () => {
  await reset();
  await addReadings("a-03", "spo2", [93, 92], NOW + SEC);
  const tx = serialTx();
  const t1 = risk.createRiskService({ repos: baseRepos(), withTransaction: tx.run });
  const t2 = risk.createRiskService({ repos: baseRepos(), withTransaction: tx.run });
  const [a, b] = await Promise.all([t1.evaluateAstronaut(MO, "AH-03", { now: NOW + 10 * SEC }), t2.evaluateAstronaut(MO2, "AH-03", { now: NOW + 10 * SEC })]);
  assert.deepEqual([a, b].map((x) => x.rules.find((r) => r.ruleId === "PHY-02").change).sort(), ["none", "opened"]);
  assert.equal((await allAlerts()).filter((x) => x.ruleId === "PHY-02").length, 1);
  assert.equal(await mock.metaRepo.get("alertCounter"), 191);
  const [c, d] = await Promise.all([t1.evaluateAstronaut(MO, "AH-03", { now: NOW + 20 * SEC }), t1.evaluateAstronaut(MO, "AH-03", { now: NOW + 20 * SEC })]);
  assert.deepEqual([c.status, d.status].sort(), ["busy", "evaluated"]);
});

test("resolved recurrence: a later occurrence opens a NEW alert; the resolved one is untouched", async () => {
  await reset();
  const s = service().service;
  const a = alertsSvc.createAlertsService({ repos: baseRepos(), withTransaction: mock.withTransaction });
  await addReadings("a-03", "spo2", [93, 92], NOW + SEC);
  await s.evaluateAstronaut(MO, "AH-03", { now: NOW + 10 * SEC });
  await a.acknowledgeAlert(MO, "ALT-0191", {}, { now: NOW + 11 * SEC });
  await a.resolveAlert(MO, "ALT-0191", { note: "Reviewed.", confirmConditionPresent: true }, { now: NOW + 12 * SEC });
  const resolved = JSON.stringify((await allAlerts()).find((x) => x.number === "ALT-0191"));
  await addReadings("a-03", "spo2", [93, 91], NOW + 20 * SEC);
  const r = await s.evaluateAstronaut(MO, "AH-03", { now: NOW + 30 * SEC });
  const ch = r.rules.find((x) => x.ruleId === "PHY-02");
  assert.deepEqual([ch.change, ch.alertNumber], ["opened", "ALT-0192"]);
  const fresh = (await allAlerts()).find((x) => x.number === "ALT-0192");
  assert.deepEqual([fresh.occurrenceCount, fresh.detectedAt, fresh.status], [1, NOW + 30 * SEC, "new"]);
  assert.equal(JSON.stringify((await allAlerts()).find((x) => x.number === "ALT-0191")), resolved, "resolved alert unchanged");
});

test("PHY-01, PHY-03 and PHY-05 open through the service; suspect readings never do", async () => {
  await reset();
  const s = service().service;
  await addReadings("a-01", "heartRate", [101, 125], NOW + SEC);
  await addReadings("a-01", "bpSystolic", [160, 161], NOW + SEC);
  await addReadings("a-02", "spo2", [70, 70], NOW + SEC, SEC, { quality: "suspect" });
  const r1 = await s.evaluateAstronaut(MO, "AH-01", { now: NOW + 10 * SEC });
  assert.deepEqual(r1.rules.filter((x) => x.change === "opened").map((x) => [x.ruleId, x.alertSeverity]), [["PHY-01", "warning"], ["PHY-03", "critical"]]);
  const r2 = await s.evaluateAstronaut(MO, "AH-02", { now: NOW + 10 * SEC });
  assert.ok(r2.rules.every((x) => x.change === "none"));
  // Sleep: three new consecutive short nights for a-02.
  const DAY = 86400e3;
  const day0 = Math.floor((NOW + DAY) / DAY) * DAY + 6 * 3600e3;
  for (let k = 0; k < 3; k += 1) await mock.measurementsRepo.add({ astronautId: "a-02", metric: "sleepDuration", value: 4.5, unit: "h", timestamp: day0 + k * DAY, source: "manual", quality: "ok" });
  const r3 = await s.evaluateAstronaut(MO, "AH-02", { now: day0 + 2 * DAY + 3600e3 });
  assert.deepEqual(r3.rules.filter((x) => x.change === "opened").map((x) => [x.ruleId, x.alertSeverity]), [["PHY-05", "critical"]]);
});

test("missing thresholds: nothing is evaluated or written; the result says so", async () => {
  await reset();
  await addReadings("a-03", "spo2", [80, 80], NOW + SEC);
  const before = await snapshot();
  const s = service({ settingsRepo: { ...mock.settingsRepo, get: async () => null } }).service;
  const r = await s.evaluateAstronaut(MO, "AH-03", { now: NOW + 10 * SEC });
  assert.equal(r.thresholdsAvailable, false);
  assert.ok(r.rules.every((x) => x.outcome === "insufficient" && x.reason === "threshold_missing"));
  assert.equal(await snapshot(), before);
});

test("privacy: the risk service never touches journal, wellbeing, messages or password material", () => {
  const src = code("js/services/risk-service.js");
  for (const bad of ["journalRepo", "wellbeingRepo", "messagesRepo", "cognitiveRepo", "passwordHash", "salt", "verifyPassword", "localStorage"]) assert.ok(!src.includes(bad), bad);
  const imports = [...readFileSync(join(ROOT, "js/services/risk-service.js"), "utf8").matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["../db/index.js", "./access-control.js", "../engine/rules/physical-rules.js", "../engine/risk-engine.js", "../engine/rules/exercise-rules.js"]);
});

// =====================================================================================
// Simulation → risk → alert
// =====================================================================================

function simulation(evaluator) {
  const tx = serialTx();
  const r = risk.createRiskService({ repos: baseRepos(), withTransaction: tx.run });
  return { risk: r, sim: sim.createSimulationService({ repos: baseRepos(), withTransaction: tx.run, evaluateRisk: evaluator || r.evaluateAstronaut }) };
}

test("AH-03 low oxygen (PHY-02 v2): info after 2 readings < 95 (step 3), warning after 2 < 93 (step 4), critical after 2 < 90 (step 6), cleared after 2 ≥ 95 (step 12); stays open", async () => {
  await reset();
  const { sim: s } = simulation();
  const start = await s.startSimulation(MO, { crewId: "AH-03", scenarioId: "low_oxygen", speed: 8, confirm: true }, { now: NOW + SEC });
  const changes = [];
  const values = [];
  for (let i = 0; i < 12; i += 1) {
    const r = await s.advanceSimulation(MO, start.runRef, { expectedStep: i }, { now: NOW + 10 * SEC + i * SEC });
    values.push(r.reading.value);
    assert.equal(r.risk.status, "evaluated", `step ${i + 1}`);
    changes.push(r.risk.changes.map((c) => `${c.alertNumber}:${c.change}:${c.severity}`).join(",") || "-");
  }
  assert.deepEqual(values, [95, 93, 92, 90, 88, 88, 88, 90, 92, 93, 95, 97], "Sprint 7 sequence unchanged");
  assert.deepEqual(changes, [
    "-", "-", "ALT-0191:opened:info", "ALT-0191:escalated:warning", "ALT-0191:updated:warning",
    "ALT-0191:escalated:critical", "ALT-0191:updated:critical", "ALT-0191:updated:critical", "ALT-0191:updated:critical", "ALT-0191:updated:critical",
    "-", "ALT-0191:condition_cleared:critical",
  ]);
  const a = (await allAlerts()).find((x) => x.number === "ALT-0191");
  assert.deepEqual([a.status, a.severity, a.conditionCleared], ["new", "critical", 1], "open until the Medical Officer resolves it");
  assert.match(a.explanation, /below the demonstration critical threshold of 90 % \(88 %, 88 %\)/, "the explanation still explains the critical severity (last critical-tier pair: steps 6–7)");
  assert.deepEqual((await mock.alertActionsRepo.getByAlert(a.id)).map((x) => x.action), ["created", "escalated", "escalated", "condition_cleared"]);
  assert.ok(a.triggeringMeasurements.every((e) => e.source === "simulation" && e.quality === "ok"));
  // The run still completed normally (Sprint 7 state machine unchanged).
  const run = await mock.simulationRunsRepo.getById(start.runRef);
  assert.deepEqual([run.status, run.step], ["completed", 12]);
});

test("evaluation failure after a committed step: the reading stays, the result says 'unavailable', the next evaluation catches up", async () => {
  await reset();
  let fail = true;
  const real = simulation();
  const { sim: s } = simulation(async (...args) => (fail ? (() => { throw new Error("boom"); })() : real.risk.evaluateAstronaut(...args)));
  const start = await s.startSimulation(MO, { crewId: "AH-03", scenarioId: "low_oxygen", speed: 8, confirm: true }, { now: NOW + SEC });
  const results = [];
  for (let i = 0; i < 3; i += 1) results.push(await s.advanceSimulation(MO, start.runRef, { expectedStep: i }, { now: NOW + 10 * SEC + i * SEC }));
  assert.ok(results.every((r) => r.status === "advanced" && r.risk.status === "unavailable" && r.risk.changes.length === 0));
  assert.equal((await mock.measurementsRepo.getRange("a-03", "spo2")).filter((m) => m.simulationRunId === start.runRef).length, 3, "readings kept");
  assert.equal((await allAlerts()).filter((x) => x.ruleId === "PHY-02").length, 0, "no alert claimed");
  // A risk service returning an error result is also reported as unavailable.
  const { sim: s2 } = simulation(async () => ({ status: "unavailable", reason: "database_error" }));
  const r2 = await s2.advanceSimulation(MO, start.runRef, { expectedStep: 3 }, { now: NOW + 20 * SEC });
  assert.deepEqual([r2.status, r2.risk.status, r2.risk.reason], ["advanced", "unavailable", "database_error"]);
  // Explicit evaluation on the current stored data catches up (93, 92, 90 → warning).
  fail = false;
  const caught = await real.risk.evaluateAstronaut(MO, "AH-03", { now: NOW + 30 * SEC });
  assert.equal(caught.rules.find((x) => x.ruleId === "PHY-02").change, "opened");
});

test("cross-dashboard: the same stored alert appears in Overview, officer queue, Crew Monitor list + detail, Physical Health and Alerts", async () => {
  await reset();
  const { sim: s } = simulation();
  const start = await s.startSimulation(MO, { crewId: "AH-03", scenarioId: "low_oxygen", speed: 8, confirm: true }, { now: NOW + SEC });
  for (let i = 0; i < 6; i += 1) await s.advanceSimulation(MO, start.runRef, { expectedStep: i }, { now: NOW + 10 * SEC + i * SEC }); // step 6: 88, 88 → critical
  const at = NOW + 20 * SEC;
  const mission = async () => ({ available: true, name: "TEST-1", missionDay: 3 });
  const repos = { ...baseRepos(), dailySummariesRepo: mock.dailySummariesRepo, messagesRepo: mock.messagesRepo, cognitiveRepo: mock.cognitiveRepo, wellbeingRepo: mock.wellbeingRepo };
  const ov = (await import("../../js/services/astronaut-overview-service.js")).createAstronautOverviewService({ repos, getMissionContext: mission });
  const cm = (await import("../../js/services/crew-monitor-service.js")).createCrewMonitorService({ repos, getMissionContext: mission });
  const ph = (await import("../../js/services/physical-health-service.js")).createPhysicalHealthService({ repos });
  const al = alertsSvc.createAlertsService({ repos: baseRepos(), withTransaction: mock.withTransaction });
  const has = (x) => JSON.stringify(x).includes("ALT-0191");
  const overview = await ov.getAstronautOverview(CHEN, { now: at });
  assert.equal(overview.status, "ready");
  assert.deepEqual(overview.alerts.items.filter((x) => x.number === "ALT-0191").map((x) => x.severity), ["critical"], "astronaut Overview alert list");
  assert.match(JSON.stringify(overview.overall), /critical/i, "astronaut Overview status derived from the stored open alert");
  const snap = await cm.getCrewSnapshot(MO, { now: at });
  assert.ok(has(snap), "officer queue / crew list");
  const chen = snap.crew ? snap.crew.find((c) => c.crewId === "AH-03") : null;
  if (chen) assert.match(JSON.stringify(chen), /ALT-0191/);
  assert.ok(has(await cm.getCrewMemberDetail(MO, "AH-03", { now: at })), "crew detail");
  const p = await ph.getCrewMemberPhysicalHealth(MO, "AH-03", { now: at });
  assert.deepEqual(p.alerts.items.map((x) => [x.number, x.severity]), [["ALT-0191", "critical"]], "Physical Health");
  const list = await al.listAlerts(MO, {}, { now: at });
  assert.equal(list.items[0].number, "ALT-0191", "Alerts page: critical first");
  assert.equal(list.items[0].severity, "critical");
});

test("EX-01 through the risk service: missed exercise days open a warning (1–2 days) then escalate to critical (3+); a logged day clears", async () => {
  await reset();
  const DAY = 24 * 3600 * 1000;
  const s = risk.createRiskService({ repos: baseRepos(), withTransaction: mock.withTransaction });
  const ex = (r) => r.rules.find((x) => x.ruleId === "EX-01");
  // The seed logged every day up to NOW, so evaluating now changes nothing.
  assert.equal(ex(await s.evaluateAstronaut(MO, "AH-01", { now: NOW + 1000 })).change, "none");
  // Two days later with nothing logged: one full UTC day (yesterday) was missed → warning.
  const one = ex(await s.evaluateAstronaut(MO, "AH-01", { now: NOW + 2 * DAY }));
  assert.deepEqual([one.change, one.alertSeverity], ["opened", "warning"]);
  assert.match(one.explanation, /Less than 30 min of aerobic \+ resistance exercise on 1 UTC day in a row/);
  const two = ex(await s.evaluateAstronaut(MO, "AH-01", { now: NOW + 3 * DAY }));
  assert.deepEqual([two.outcome, two.severity, two.alertSeverity], ["triggered", "warning", "warning"], "2 missed days: still warning");
  const three = ex(await s.evaluateAstronaut(MO, "AH-01", { now: NOW + 4 * DAY }));
  assert.deepEqual([three.change, three.alertSeverity], ["escalated", "critical"], "3 missed days: critical");
  await mock.eventsRepo.add({ type: "exercise_logged", timestamp: NOW + 4 * DAY + 1000, astronautId: "a-01", actorUserId: "u-haddad", refStore: "", refId: "", summary: "x", data: { sessionType: "aerobic", minutes: 45, completion: "completed" } });
  const cleared = ex(await s.evaluateAstronaut(MO, "AH-01", { now: NOW + 4 * DAY + 2000 }));
  assert.equal(cleared.change, "condition_cleared");
  const a = (await allAlerts()).find((x) => x.ruleId === "EX-01");
  assert.deepEqual([a.severity, a.status, a.conditionCleared, a.category], ["critical", "new", 1, "physical"], "stays open until the Medical Officer resolves it");
});
