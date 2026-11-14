// tests/unit/history-service.test.mjs — Sprint 9 #/history service: authorization,
// allow-list mapping, privacy, UTC ranges, deterministic capped snapshot.
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

const svc = await import("../../js/services/history-service.js");
const mock = await import("../../js/db/mock-repositories.js");
const { EVENT_TYPES } = await import("../../js/db/index.js");

const NOW = Date.UTC(2026, 10, 14, 15, 30);
const DAY = 86400e3;
const MO = Object.freeze({ role: "medical_officer", userId: "u-medofficer", astronautId: "" });
const HADDAD = Object.freeze({ role: "astronaut", userId: "u-haddad", astronautId: "a-01" });
const CHEN = Object.freeze({ role: "astronaut", userId: "u-chen", astronautId: "a-03" });
const LEAKS = /a-0\d|u-[a-z]+|msr_|evt_|alr_|wba_|sim_|act_|msg_|mood \d|stress \d|reaction|Understood|Please prioritise|Routine request|explanation|resolutionNote|"summary"|"data"|"refId"|"refStore"|"actorUserId"/;

const repos = () => ({ usersRepo: mock.usersRepo, astronautsRepo: mock.astronautsRepo, eventsRepo: mock.eventsRepo, alertsRepo: mock.alertsRepo, simulationRunsRepo: mock.simulationRunsRepo });
function spy(rs) {
  const calls = [];
  const wrapped = {};
  for (const [name, repo] of Object.entries(rs)) wrapped[name] = new Proxy(repo, { get(t, p) { const v = t[p]; return typeof v !== "function" ? v : (...a) => { calls.push({ repo: name, method: String(p), args: a }); return v.apply(t, a); }; } });
  return { repos: wrapped, calls };
}
const service = (overrides = {}) => { const s = spy({ ...repos(), ...overrides }); return { ...s, service: svc.createHistoryService({ repos: s.repos }) }; };
const reset = () => mock.resetMock({ now: NOW });
const ctx = (viewer = "astronaut", extra = {}) => ({ viewer, alertsById: new Map(), runsById: new Map(), scenarioName: () => "", ...extra });
const ev = (type, extra = {}) => ({ id: "evt_x", type, timestamp: NOW - 1000, astronautId: "a-01", actorUserId: "u-medofficer", refStore: "", refId: "", summary: "SECRET-SUMMARY mood 1/5", data: { mood: 1, body: "SECRET-BODY", note: "SECRET-NOTE" }, ...extra });

test("authorization before any read; astronauts can't use the crew functions", async () => {
  await reset();
  for (const [session, reason] of [[null, "no_session"], [{ ...HADDAD, astronautId: "a-03" }, "account_mismatch"], [{ role: "admin", userId: "u-haddad" }, "not_astronaut"]]) {
    const { service: s, calls } = service();
    const r = await s.getOwnHistory(session, {}, { now: NOW });
    assert.deepEqual([r.status, r.reason], ["forbidden", reason]);
    assert.ok(!calls.some((c) => c.repo !== "usersRepo"), "no history reads");
  }
  const { service: s, calls } = service();
  assert.equal((await s.getCrewMemberHistory(HADDAD, "AH-01", {}, { now: NOW })).reason, "not_medical_officer");
  assert.equal((await s.listCrewForHistorySelection(HADDAD, { now: NOW })).reason, "not_medical_officer");
  assert.ok(!calls.some((c) => ["eventsRepo", "alertsRepo", "simulationRunsRepo", "astronautsRepo"].includes(c.repo)));
  for (const [crewId, reason] of [["a-01", "invalid_crew_id"], ["AH-1", "invalid_crew_id"], ["AH-99", "unknown_crew_id"], [undefined, "invalid_crew_id"]]) {
    assert.equal((await s.getCrewMemberHistory(MO, crewId, {}, { now: NOW })).reason, reason);
  }
});

test("role scoping: an astronaut only ever gets their own events; filters can't widen it", async () => {
  await reset();
  const { service: s, calls } = service();
  const r = await s.getOwnHistory(HADDAD, { days: 7, astronautId: "a-03", crewId: "AH-03" }, { now: NOW });
  assert.equal(r.status, "ready");
  assert.equal(r.profile.crewId, "AH-01");
  assert.ok(calls.filter((c) => c.repo === "eventsRepo").every((c) => c.args[0].astronautId === "a-01"));
  assert.ok(!/ALT-0189|ALT-0190|ALT-0184/.test(JSON.stringify(r)), "no other astronaut's alerts");
  assert.ok(r.entries.some((e) => /ALT-0181/.test(e.text)));
  assert.ok(!LEAKS.test(JSON.stringify(r)), JSON.stringify(r).match(LEAKS)?.[0]);
});

test("UTC ranges: 7/14/30 whole days, inclusive; anything else is invalid", async () => {
  const r7 = svc.historyRange(7, NOW);
  assert.deepEqual([r7.from, r7.to], ["2026-11-08", "2026-11-14"]);
  assert.equal(r7.fromTs, Date.UTC(2026, 10, 8));
  assert.equal(r7.toTs, Date.UTC(2026, 10, 15) - 1);
  assert.deepEqual([svc.historyRange(30, NOW).from], ["2026-10-16"]);
  const edge = [ev("cognitive_check_completed", { id: "e1", timestamp: r7.fromTs }), ev("cognitive_check_completed", { id: "e0", timestamp: r7.fromTs - 1 }), ev("cognitive_check_completed", { id: "e2", timestamp: r7.toTs })];
  const s = service({ eventsRepo: { getRange: async () => edge } }).service;
  const r = await s.getOwnHistory(HADDAD, { days: 7 }, { now: NOW });
  assert.equal(r.entries.length, 2, "the start instant is included, the instant before is not");
  for (const days of [0, 5, 31, "7", null, 7.5]) assert.equal((await s.getOwnHistory(HADDAD, { days }, { now: NOW })).reason, "invalid_range", String(days));
  assert.equal((await s.getOwnHistory(HADDAD, {}, { now: NOW })).range.days, 7, "default 7 days");
});

test("allow-list: every supported type gets fixed safe wording; stored summary/data never appear", () => {
  const alert = { id: "alr_1", number: "ALT-0191", title: "Low SpO₂", explanation: "SECRET-EXPLANATION", resolutionNote: "SECRET-NOTE" };
  const run = { id: "sim_1", astronautId: "a-01", scenarioId: "low_oxygen" };
  const c = ctx("astronaut", { alertsById: new Map([["alr_1", alert]]), runsById: new Map([["sim_1", run]]), scenarioName: () => "Low oxygen saturation demonstration" });
  const cases = [
    [ev("measurement_recorded", { refStore: "simulationRuns", refId: "sim_1", data: { step: 3, metric: "spo2", value: 92, unit: "%", body: "SECRET" } }), "readings", "Simulated reading: SpO₂ 92 % (step 3)", "simulation"],
    [ev("measurement_recorded", { refStore: "measurements", data: { samples: 12, from: 1, to: 2 } }), "readings", "12 vital-sign samples recorded", "not_recorded"],
    [ev("measurement_recorded", { refStore: "measurements", data: { metric: "sleepDuration", value: 6.2 } }), "readings", "Sleep duration recorded: 6.2 h", "not_recorded"],
    [ev("measurement_recorded", { data: { metric: "spo2", value: 92, unit: "bpm" } }), "readings", "Reading recorded", "not_recorded"],
    [ev("checkin_completed", { data: { shared: 1, mood: 2, stress: 7 } }), "wellbeing", "Daily check-in completed · shared", null],
    [ev("checkin_completed", { data: { shared: 0 } }), "wellbeing", "Daily check-in completed · private", null],
    [ev("cognitive_check_completed", { data: { meanReactionMs: 342, misses: 1 } }), "wellbeing", "Cognitive check completed", null],
    [ev("risk_detected", { refStore: "alerts", refId: "alr_1" }), "alerts", "Demonstration rule matched for ALT-0191 Low SpO₂", null],
    [ev("alert_generated", { refStore: "alerts", refId: "alr_1", data: { severity: "warning" } }), "alerts", "ALT-0191 Low SpO₂ opened (warning)", null],
    [ev("alert_escalated", { refStore: "alerts", refId: "alr_1", data: { severity: "critical" } }), "alerts", "ALT-0191 Low SpO₂ escalated to critical", null],
    [ev("alert_condition_cleared", { refStore: "alerts", refId: "alr_1" }), "alerts", "ALT-0191 Low SpO₂: condition cleared", null],
    [ev("alert_acknowledged", { refStore: "alerts", refId: "alr_1" }), "alerts", "ALT-0191 Low SpO₂ acknowledged by the Medical Officer", null],
    [ev("alert_resolved", { refStore: "alerts", refId: "alr_1" }), "alerts", "ALT-0191 Low SpO₂ resolved by the Medical Officer", null],
    [ev("message_sent", { data: { templateId: "rest_and_reassess" } }), "messages", "Message from the Medical Officer: Rest and reassess", null],
    [ev("message_sent", { data: { templateId: "free_text_SECRET" } }), "messages", "Message from the Medical Officer", null],
    [ev("message_acknowledged"), "messages", "Message acknowledged", null],
    [ev("astronaut_response", { summary: "Response: SECRET-REPLY" }), "messages", "Response sent", null],
    [ev("simulation_started", { refStore: "simulationRuns", refId: "sim_1", data: { phase: "started" } }), "simulation", "Simulation started: Low oxygen saturation demonstration", "simulation"],
    [ev("simulation_started", { refStore: "simulationRuns", refId: "sim_1", data: { phase: "resumed" } }), "simulation", "Simulation resumed: Low oxygen saturation demonstration", "simulation"],
    [ev("simulation_paused", { refStore: "simulationRuns", refId: "sim_1" }), "simulation", "Simulation paused: Low oxygen saturation demonstration", "simulation"],
    [ev("simulation_stopped", { refStore: "simulationRuns", refId: "sim_1", data: { outcome: "completed" } }), "simulation", "Simulation completed: Low oxygen saturation demonstration", "simulation"],
    [ev("simulation_stopped", { refStore: "simulationRuns", refId: "sim_gone", data: { outcome: "stopped" } }), "simulation", "Simulation stopped", "not_recorded"],
  ];
  for (const [e, category, text, provenance] of cases) {
    const out = svc.describeEvent(e, c);
    assert.ok(out, e.type);
    assert.deepEqual([out.category, out.text, out.provenance], [category, text, provenance], e.type);
    assert.deepEqual(Object.keys(out).sort(), ["alertNumber", "category", "day", "kind", "provenance", "text", "timestamp"]);
    assert.ok(!/SECRET|mood|stress|342/.test(JSON.stringify(out)), `${e.type}: ${JSON.stringify(out)}`);
  }
  // Every documented type is either mapped or deliberately excluded.
  const mapped = new Set(cases.map(([e]) => e.type));
  for (const t of EVENT_TYPES) if (!mapped.has(t)) assert.equal(svc.describeEvent(ev(t), c), null, `${t} excluded`);
  assert.deepEqual(EVENT_TYPES.filter((t) => !mapped.has(t)).sort(), ["data_imported", "data_reset", "report_generated", "settings_changed"]);
  assert.equal(svc.describeEvent(ev("totally_new_type"), c), null, "unknown types are omitted");
  assert.equal(svc.describeEvent({ type: "message_acknowledged" }, c), null, "no timestamp → omitted");
  // Source code never touches stored summaries.
  assert.ok(!/\.summary\b/.test(code("js/services/history-service.js")), "stored summary is never read");
});

test("private check-ins: visible (without scores) only to their astronaut; the officer never learns one exists", async () => {
  const o = svc.describeEvent(ev("checkin_completed", { data: { shared: 0 } }), ctx("officer"));
  assert.equal(o, null);
  for (const shared of ["1", true, 2, undefined, null]) {
    assert.equal(svc.describeEvent(ev("checkin_completed", { data: { shared } }), ctx("officer")), null, `officer: ${String(shared)}`);
    assert.equal(svc.describeEvent(ev("checkin_completed", { data: { shared } }), ctx("astronaut")), null, `astronaut: unknown share state ${String(shared)} omitted`);
  }
  await reset();
  const { service: s } = service();
  const own = await s.getOwnHistory(HADDAD, { days: 30 }, { now: NOW });
  assert.ok(own.entries.filter((e) => e.text === "Daily check-in completed · private").length >= 3);
  const mo = await s.getCrewMemberHistory(MO, "AH-01", { days: 30 }, { now: NOW });
  assert.equal(mo.entries.filter((e) => /private/.test(e.text)).length, 0);
  assert.equal(own.entries.filter((e) => /shared/.test(e.text)).length, mo.entries.filter((e) => /shared/.test(e.text)).length);
  assert.ok(!JSON.stringify(mo).includes("private"), "no private-check-in signal in the officer's output");
  for (const r of [own, mo]) assert.ok(!LEAKS.test(JSON.stringify(r)), JSON.stringify(r).match(LEAKS)?.[0]);
});

test("snapshot: 650 events at one timestamp → 500 returned, deterministic order, no duplicates, no ids", async () => {
  const many = Array.from({ length: 650 }, (_, i) => Object.freeze(ev(["cognitive_check_completed", "message_acknowledged", "alert_resolved"][i % 3], { id: `evt_${String(i).padStart(4, "0")}`, timestamp: NOW - 5000, refStore: "", data: {} })));
  const frozen = Object.freeze([...many].reverse());
  const s = service({ eventsRepo: { getRange: async () => frozen }, alertsRepo: { query: async () => [] } }).service;
  const a = await s.getOwnHistory(HADDAD, { days: 7 }, { now: NOW });
  const b = await s.getOwnHistory(HADDAD, { days: 7 }, { now: NOW });
  assert.deepEqual([a.totalAvailable, a.returnedCount, a.truncated, a.pageSize], [650, 500, true, 100]);
  assert.deepEqual(a.entries, b.entries, "deterministic");
  // Category rank then the internal tie-breaker: alerts first, then wellbeing, then messages.
  assert.deepEqual([...new Set(a.entries.map((e) => e.category))], ["alerts", "wellbeing", "messages"]);
  assert.ok(!/evt_/.test(JSON.stringify(a)), "the tie-breaker id never leaves the service");
  assert.equal(frozen.length, 650, "input not mutated");
});

test("alert references: public number with link; lookup failure → 'an alert' without a link (partial)", async () => {
  await reset();
  const ok = await service().service.getOwnHistory(HADDAD, { days: 7 }, { now: NOW });
  const alertEntries = ok.entries.filter((e) => e.category === "alerts");
  assert.ok(alertEntries.length >= 4 && alertEntries.every((e) => e.alertNumber === "ALT-0181" && /ALT-0181 Elevated blood pressure/.test(e.text)));
  const fail = await service({ alertsRepo: { query: async () => { throw new Error("boom"); } } }).service.getOwnHistory(HADDAD, { days: 7 }, { now: NOW });
  assert.equal(fail.status, "ready");
  assert.equal(fail.partial.alerts, true);
  const ae = fail.entries.filter((e) => e.category === "alerts");
  assert.ok(ae.length >= 4 && ae.every((e) => e.alertNumber === "" && /an alert/i.test(e.text)));
  const down = await service({ eventsRepo: { getRange: async () => { throw new Error("x"); } } }).service.getOwnHistory(HADDAD, {}, { now: NOW });
  assert.deepEqual([down.status, down.reason], ["unavailable", "database_error"]);
});

test("simulation + alert lifecycle entries appear for the subject astronaut (Sprint 7/8 integration)", async () => {
  await reset();
  const repos2 = { ...repos(), measurementsRepo: mock.measurementsRepo, settingsRepo: mock.settingsRepo, alertActionsRepo: mock.alertActionsRepo };
  const risk = (await import("../../js/services/risk-service.js")).createRiskService({ repos: repos2, withTransaction: mock.withTransaction });
  const sim = (await import("../../js/services/simulation-service.js")).createSimulationService({ repos: repos2, withTransaction: mock.withTransaction, evaluateRisk: risk.evaluateAstronaut });
  const st = await sim.startSimulation(MO, { crewId: "AH-03", scenarioId: "low_oxygen", speed: 8, confirm: true }, { now: NOW + 1000 });
  for (let i = 0; i < 5; i += 1) await sim.advanceSimulation(MO, st.runRef, { expectedStep: i }, { now: NOW + 10000 + i * 1000 });
  const h = await service().service.getOwnHistory(CHEN, { days: 7 }, { now: NOW + 60000 });
  const texts = h.entries.map((e) => e.text);
  assert.ok(texts.includes("Simulation started: Low oxygen saturation demonstration"));
  assert.ok(texts.includes("Simulated reading: SpO₂ 92 % (step 3)"));
  assert.ok(texts.includes("ALT-0191 Low SpO₂ opened (warning)"));
  assert.ok(texts.includes("ALT-0191 Low SpO₂ escalated to critical"));
  assert.ok(h.entries.filter((e) => e.category === "simulation" || e.text.startsWith("Simulated")).every((e) => e.provenance === "simulation"));
  assert.ok(!LEAKS.test(JSON.stringify(h)), JSON.stringify(h).match(LEAKS)?.[0]);
});

test("history writes nothing and never touches journal / wellbeing / messages repositories", async () => {
  const src = code("js/services/history-service.js");
  for (const bad of ["journalRepo", "wellbeingRepo", "messagesRepo", "cognitiveRepo", ".add(", ".update(", ".set(", "settingsRepo", "localStorage"]) assert.ok(!src.includes(bad), bad);
});
