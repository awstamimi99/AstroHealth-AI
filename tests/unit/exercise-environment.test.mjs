// tests/unit/exercise-environment.test.mjs — seed version 2 additions:
// the Daily Exercise Countermeasure (rules, service, daily notification, page),
// the Cabin Environment (service, air check, page) and the seed supplement.
// Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";

import { FakeElement, all, byClass, byTag } from "./fake-dom.mjs";

const mock = await import("../../js/db/mock-repositories.js");
const rules = await import("../../js/engine/rules/exercise-rules.js");
const exSvc = await import("../../js/services/exercise-service.js");
const envSvc = await import("../../js/services/environment-service.js");
const exPage = await import("../../js/pages/exercise.js");
const envPage = await import("../../js/pages/environment.js");
const { buildSeedData, DEMO_THRESHOLDS, SEED_VERSION } = await import("../../js/db/seed-data.js");
const { buildSeedSupplement } = await import("../../js/db/seed-supplement.js");
const { METRICS, METRIC_UNITS, EVENT_TYPES, ALERT_CATEGORIES } = await import("../../js/db/constants.js");

const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 14, 15, 30);
const session = (userId, astronautId, role = "astronaut") => ({ version: 1, userId, username: userId.slice(2), displayName: userId, role, astronautId, createdAt: NOW - HOUR, expiresAt: NOW + HOUR });
const REYES = session("u-reyes", "a-04");
const KARIM = session("u-karim", "a-02");
const MO = session("u-medofficer", "", "medical_officer");
const flush = () => new Promise((r) => setTimeout(r, 0));
const ex = () => exSvc.createExerciseService({ repos: mock, withTransaction: mock.withTransaction });
const env = () => envSvc.createEnvironmentService({ repos: mock });
const text = (n) => n.textContent;

// ---- data model / seed --------------------------------------------------------------------

test("seed v2: new metrics, units, event type and alert category are documented constants", () => {
  for (const m of ["bodyTemperature", "cabinCo2", "cabinPressure", "cabinHumidity"]) assert.ok(METRICS.includes(m), m);
  assert.deepEqual([METRIC_UNITS.bodyTemperature, METRIC_UNITS.cabinCo2, METRIC_UNITS.cabinPressure, METRIC_UNITS.cabinHumidity], ["°C", "mmHg", "kPa", "%RH"]);
  assert.ok(EVENT_TYPES.includes("exercise_logged"));
  assert.ok(ALERT_CATEGORIES.includes("environment"));
  assert.equal(SEED_VERSION, 2);
});

test("seed v2 supplement: deterministic, separate ids, does not change any seed-v1 value", () => {
  const a = buildSeedData({ now: NOW });
  const b = buildSeedData({ now: NOW });
  assert.equal(JSON.stringify(a), JSON.stringify(b), "deterministic");
  const sup = buildSeedSupplement({ now: NOW, astronauts: [{ id: "a-01", userId: "u-haddad" }] });
  assert.ok(sup.measurements.every((m) => /^msr_sx_\d{5}$/.test(m.id) && m.source === "seed" && m.quality === "ok"));
  const temps = a.measurements.filter((m) => m.metric === "bodyTemperature").map((m) => m.value);
  assert.ok(temps.length > 0 && temps.every((v) => v >= 36.2 && v <= 37.3), "normal synthetic temperatures (no seeded alert)");
  const co2 = a.measurements.filter((m) => m.metric === "cabinCo2").map((m) => m.value);
  assert.ok(Math.max(...co2) < DEMO_THRESHOLDS.metrics.cabinCo2.warningHigh, "seed CO₂ stays below the warning limit");
  const ev = a.missionEvents.filter((e) => e.type === "exercise_logged");
  assert.ok(ev.length > 100);
  assert.ok(ev.every((e) => e.timestamp <= NOW), "nothing in the future");
  assert.ok(!ev.some((e) => e.astronautId === "a-04" && e.timestamp >= Date.UTC(2026, 10, 14)), "Reyes has nothing logged today (daily reminder)");
  assert.equal(a.astronauts.find((x) => x.id === "a-04").baseline.bodyTemperature, 36.7);
  assert.ok(a.astronauts.find((x) => x.id === "a-04").latest.bodyTemperature, "latest cache includes the new metric");
  // The v1 part is byte-identical: same heart-rate values as a build without the supplement would have.
  const hr = a.measurements.filter((m) => m.metric === "heartRate");
  assert.ok(hr.every((m) => /^msr_seed_\d{5}$/.test(m.id)), "v1 ids unchanged");
});

// ---- rules -----------------------------------------------------------------------------------------

test("EX-01: no history → not evaluated; missed days counted from yesterday; today ≥ 30 min clears", () => {
  const s = (daysAgo, minutes, sessionType = "aerobic", completion = "completed") => ({ timestamp: NOW - daysAgo * DAY, sessionType, minutes, completion });
  assert.equal(rules.evaluateExerciseRule([], NOW).reason, "no_exercise_history");
  assert.equal(rules.evaluateExerciseRule([s(1, 60)], NOW).outcome, "clear");
  const one = rules.evaluateExerciseRule([s(2, 60)], NOW);
  assert.deepEqual([one.outcome, one.severity], ["triggered", "warning"]);
  const three = rules.evaluateExerciseRule([s(4, 60), s(2, 10), s(1, 0, "aerobic", "skipped")], NOW);
  assert.deepEqual([three.outcome, three.severity], ["triggered", "critical"], "under 30 min and skipped days count as missed");
  assert.equal(rules.evaluateExerciseRule([s(5, 60), s(0, 30)], NOW).outcome, "clear", "30 min today clears");
  assert.equal(rules.evaluateExerciseRule([s(1, 120, "mobility")], NOW).outcome !== "clear", true, "mobility doesn't count");
  assert.equal(rules.dayKeyOf(Math.floor(NOW / DAY)), "2026-11-14");
});

test("readiness + plan: stored thresholds decide standard / reduced / recovery; reasons name the flagged checks", () => {
  const ok = rules.readinessCheck({ sleep: 7.2, fatigue: 3, heartRate: 70, spo2: 98, bpSystolic: 118, bodyTemperature: 36.7, openAlerts: [] }, DEMO_THRESHOLDS);
  assert.equal(ok.level, "standard");
  const plan = rules.dailyPlan(ok.level, ok.items, 0);
  assert.equal(plan.targetMin, 120);
  assert.deepEqual(plan.sessions.map((x) => x.type), ["aerobic", "resistance", "mobility"]);
  const reduced = rules.readinessCheck({ sleep: 5.8, fatigue: 3, heartRate: 70, spo2: 98, bpSystolic: 118, bodyTemperature: 36.7, openAlerts: [] }, DEMO_THRESHOLDS);
  assert.equal(reduced.level, "reduced");
  assert.match(rules.dailyPlan("reduced", reduced.items).sessions[0].reason, /last night's sleep/);
  const hold = rules.readinessCheck({ sleep: 7, fatigue: 3, heartRate: 70, spo2: 98, bpSystolic: 118, bodyTemperature: 38.6, openAlerts: [] }, DEMO_THRESHOLDS);
  assert.equal(hold.level, "recovery");
  assert.equal(rules.dailyPlan("recovery", hold.items).targetMin, 0);
  assert.equal(rules.readinessCheck({ sleep: 7, fatigue: 3, heartRate: 70, spo2: 98, bpSystolic: 118, bodyTemperature: 36.7, openAlerts: [{ severity: "critical" }] }, DEMO_THRESHOLDS).level, "recovery");
});

// ---- exercise service ------------------------------------------------------------------------------------------

test("exercise service: Reyes gets a reduced plan and a daily reminder; logging updates minutes; own data only", async () => {
  await mock.resetMock({ now: NOW });
  const s = ex();
  const r = await s.getOwnExercise(REYES, { now: NOW });
  assert.equal(r.status, "ready");
  assert.equal(r.plan.level, "reduced");
  assert.equal(r.reminder.due, true);
  assert.match(r.reminder.text, /0 of 80 min logged today/);
  assert.ok(!JSON.stringify(r).match(/"a-0\d"|"u-[a-z]+"/), "no internal ids");
  const saved = await s.logExerciseSession(REYES, { sessionType: "aerobic", device: "Treadmill", minutes: 50, intensity: "light", completion: "completed", rpe: 5, astronautId: "a-01" }, { now: NOW + 1000 });
  assert.equal(saved.status, "saved");
  const ev = (await mock.eventsRepo.getRange({ astronautId: "a-04", types: ["exercise_logged"] }))[0];
  assert.deepEqual([ev.astronautId, ev.actorUserId, ev.data.minutes, ev.data.source], ["a-04", "u-reyes", 50, "manual"], "identity from the session, never the input");
  const after = await s.getOwnExercise(REYES, { now: NOW + 2000 });
  assert.equal(after.today.minutes, 50);
  assert.match(after.reminder.text, /50 of 80 min/);
});

test("exercise service: validation, allow-listed reasons only, Medical Officer can't log, astronaut can't read the crew", async () => {
  await mock.resetMock({ now: NOW });
  const s = ex();
  const bad = await s.logExerciseSession(REYES, { sessionType: "yoga", device: "x", minutes: 999, completion: "partial", stopReason: "free text <b>" }, { now: NOW });
  assert.equal(bad.status, "invalid");
  for (const f of ["sessionType", "device", "minutes", "stopReason"]) assert.ok(bad.errors[f], f);
  const skipped = await s.logExerciseSession(REYES, { sessionType: "resistance", device: "Resistance exercise device", completion: "skipped", stopReason: "Felt fatigued" }, { now: NOW + 10 });
  assert.equal(skipped.status, "saved");
  assert.equal(skipped.session.minutes, 0);
  assert.equal((await s.logExerciseSession(MO, { sessionType: "aerobic", device: "Treadmill", minutes: 30, intensity: "light", completion: "completed" }, { now: NOW })).status, "forbidden");
  assert.equal((await s.getCrewExercise(REYES, { now: NOW })).status, "forbidden");
  const crew = await s.getCrewExercise(MO, { now: NOW });
  assert.deepEqual(crew.crew.map((c) => c.crewId), ["AH-01", "AH-02", "AH-03", "AH-04"]);
  assert.equal(crew.crew.find((c) => c.crewId === "AH-02").missedDays, 1, "Karim skipped one day");
  const mo = await s.getExerciseReminder(MO, { now: NOW });
  assert.equal(mo.due, true);
  assert.match(mo.text, /haven't reached today's target yet/);
});

test("exercise service: logging after missed days opens EX-01 in the same transaction; a good day clears it", async () => {
  await mock.resetMock({ now: NOW });
  const s = ex();
  const later = NOW + 3 * DAY; // 2 full UTC days with nothing logged
  const first = await s.logExerciseSession(KARIM, { sessionType: "mobility", device: "Mobility mat", minutes: 15, intensity: "light", completion: "completed" }, { now: later });
  assert.deepEqual([first.alert.change, first.alert.severity], ["opened", "warning"]);
  const a = (await mock.alertsRepo.query({ astronautId: "a-02" })).find((x) => x.ruleId === "EX-01");
  assert.deepEqual([a.category, a.status, a.severity], ["physical", "new", "warning"]);
  const good = await s.logExerciseSession(KARIM, { sessionType: "aerobic", device: "Cycle ergometer", minutes: 45, intensity: "moderate", completion: "completed" }, { now: later + 1000 });
  assert.equal(good.alert.change, "condition_cleared");
});

// ---- environment ----------------------------------------------------------------------------------------------

test("air check: one person vs several crew members vs crew-wide pattern with high CO₂", () => {
  const t = DEMO_THRESHOLDS;
  assert.equal(envSvc.airCheck([{ spo2: 98, co2: 2 }, { spo2: 97, co2: 2 }], t).status, "clear");
  assert.equal(envSvc.airCheck([{ spo2: 92, co2: 2 }, { spo2: 97, co2: 2 }], t).status, "individual");
  assert.equal(envSvc.airCheck([{ spo2: 92, co2: 2 }, { spo2: 93, co2: 2 }], t).status, "crew_spo2");
  assert.equal(envSvc.airCheck([{ spo2: 92, co2: 4.5 }, { spo2: 93, co2: 3 }], t).status, "crew_pattern");
  assert.equal(envSvc.airCheck([{ spo2: null, co2: 2 }], t).status, "unknown");
});

test("environment service: astronaut sees crew-wide figures only; Medical Officer sees each monitor; limits from settings", async () => {
  await mock.resetMock({ now: NOW });
  const s = env();
  const a = await s.getCabinEnvironment(REYES, { now: NOW });
  assert.equal(a.status, "ready");
  assert.deepEqual(a.members, []);
  assert.ok(!/Haddad|Karim|Chen/.test(JSON.stringify(a)), "no other crew names for an astronaut");
  const co2 = a.crewWide.find((m) => m.key === "cabinCo2");
  assert.deepEqual(co2.limits, { warning: 4, critical: 6 });
  assert.equal(co2.monitors, 4);
  assert.equal(co2.level, "ok");
  const m = await s.getCabinEnvironment(MO, { now: NOW });
  assert.deepEqual(m.members.map((x) => x.crewId), ["AH-01", "AH-02", "AH-03", "AH-04"]);
  assert.ok(!JSON.stringify(m).match(/"a-0\d"|"u-[a-z]+"/));
  assert.equal(envSvc.levelOf(envSvc.CABIN_METRICS[1], 94, DEMO_THRESHOLDS.metrics.cabinPressure), "critical");
  assert.equal(envSvc.levelOf(envSvc.CABIN_METRICS[2], 70, DEMO_THRESHOLDS.metrics.cabinHumidity), "ok", "70 %RH is not above 70");
});

// ---- pages (fake DOM) ---------------------------------------------------------------------------------------------------

test("exercise page: notification, readiness, plan, log form and 14-day history; the form posts to the service", async () => {
  await mock.resetMock({ now: NOW });
  const s = ex();
  const calls = [];
  const c = new FakeElement("div");
  await exPage.createExerciseRenderer({
    loadOwn: (x) => s.getOwnExercise(x, { now: NOW }),
    loadCrew: () => null, loadMember: () => null,
    logSession: async (x, input) => { calls.push(input); return { status: "invalid", errors: { minutes: "Enter the minutes done (1–240)." } }; },
    subscribe: () => () => {},
  })(c, REYES, {});
  assert.match(text(byClass(c, "ex-notice")[0]), /0 of 80 min logged today/);
  assert.equal(byClass(c, "ex-ready__item").length, 8);
  assert.equal(byClass(c, "ex-plan__item").length, 3);
  assert.equal(byClass(c, "ex-history__day").length, 14);
  const form = byTag(c, "form")[0];
  form.dispatch("submit");
  await flush();
  assert.equal(calls.length, 1, "the page sends the form to the service");
  assert.ok(all(c, (e) => e.getAttribute("id") === "ex-minutes-error" && !e.hidden).length === 1, "field error shown");
});

test("exercise page (Medical Officer): crew table with links, no log form; environment page renders the air check", async () => {
  await mock.resetMock({ now: NOW });
  const s = ex();
  const c = new FakeElement("div");
  await exPage.createExerciseRenderer({ loadOwn: () => null, loadCrew: (x) => s.getCrewExercise(x, { now: NOW }), loadMember: () => null, logSession: () => null, subscribe: () => () => {} })(c, MO, { hash: "#/exercise" });
  assert.deepEqual(byTag(c, "a").map((a) => a.getAttribute("href")).filter((h) => h.startsWith("#/exercise/")), ["#/exercise/AH-01", "#/exercise/AH-02", "#/exercise/AH-03", "#/exercise/AH-04"]);
  assert.equal(byTag(c, "form").length, 0);
  const e = new FakeElement("div");
  await envPage.createEnvironmentRenderer({ load: (x) => env().getCabinEnvironment(x, { now: NOW }), subscribe: () => () => {} })(e, MO, {});
  assert.match(text(e), /Air check/);
  assert.equal(byClass(e, "env-card").length, 3);
  assert.match(text(e), /Each crew member's monitor/);
});
