import test from "node:test";
import assert from "node:assert/strict";
import { WELLBEING_RULE, evaluateWellbeingRule, checkinConcerns } from "../../js/engine/rules/wellbeing-rules.js";

const NOW = Date.UTC(2026, 10, 15, 10);
const checkin = (id, ago, values = {}, shared = 1) => ({
  id, astronautId: "a-01", timestamp: NOW - ago, sharedWithMedical: shared,
  mood: 4, stress: 3, sleepQuality: 4, fatigue: 2, isolation: 2, wellbeing: 4,
  source: "manual", ...values,
});

test("WB-01 is a non-diagnostic wellbeing rule", () => {
  assert.deepEqual([WELLBEING_RULE.id, WELLBEING_RULE.category, WELLBEING_RULE.type], ["WB-01", "wellbeing", "supportive_checkin"]);
  assert.match(WELLBEING_RULE.thresholdSource, /demonstration rule/i);
});

test("latest shared concern triggers; private records are excluded", () => {
  const r = evaluateWellbeingRule([
    checkin("private", 1000, { mood: 1, stress: 10 }, 0),
    checkin("shared", 2000, { mood: 2, stress: 8 }),
  ], NOW);
  assert.equal(r.outcome, "triggered");
  assert.equal(r.severity, "warning", "two concerns (low mood + high stress)");
  assert.deepEqual(r.evidence.map((e) => e.measurementId), ["shared"]);
  assert.equal(r.excluded.private, 1);
  assert.match(r.explanation, /not a diagnosis/i);
});

test("severe combined self-report is warning; two stable shared check-ins clear", () => {
  const warning = evaluateWellbeingRule([checkin("severe", 1, { mood: 1, stress: 9 })], NOW);
  assert.deepEqual([warning.outcome, warning.severity], ["triggered", "warning"]);
  const clear = evaluateWellbeingRule([checkin("older", 2000), checkin("newer", 1000)], NOW);
  assert.equal(clear.outcome, "clear");
  assert.deepEqual(clear.evidence.map((e) => e.measurementId), ["older", "newer"]);
});

test("one stable shared check-in monitors instead of prematurely clearing", () => {
  const r = evaluateWellbeingRule([checkin("only", 1000)], NOW);
  assert.deepEqual([r.outcome, r.reason], ["insufficient", "monitoring"]);
});

const DAY = 86400000;
test("v3: one concern is info; poor sleep quality counts; the review lists concerns with their values", () => {
  const r = evaluateWellbeingRule([checkin("a", 1000, { sleepQuality: 2 })], NOW);
  assert.equal(r.outcome, "triggered");
  assert.equal(r.severity, "info");
  assert.match(r.explanation, /poor sleep quality \(2\/5\)/);
  assert.deepEqual(checkinConcerns({ mood: 2, wellbeing: 4, sleepQuality: 4, stress: 7, isolation: 1, fatigue: 8 }), ["low mood (2/5)", "high stress (7/10)", "high fatigue (8/10)"]);
  assert.deepEqual(checkinConcerns({ mood: 4, wellbeing: 4, sleepQuality: 4, stress: 6, isolation: 6, fatigue: 7 }), []);
});

test("v3: mood falling over 3 shared check-ins is info even when each score is fine", () => {
  const r = evaluateWellbeingRule([checkin("a", 3 * DAY, { mood: 5 }), checkin("b", 2 * DAY, { mood: 4 }), checkin("c", DAY, { mood: 3 })], NOW);
  assert.equal(r.outcome, "triggered");
  assert.equal(r.severity, "info");
  assert.match(r.explanation, /mood falling on 3 shared check-ins in a row \(5 → 4 → 3\/5\)/);
});

test("v3: a concern in each of the last 3 shared check-ins is warning; mood 1–2 on 3 different days is critical", () => {
  const sustained = evaluateWellbeingRule([checkin("a", 3 * DAY, { stress: 7 }), checkin("b", 2 * DAY, { isolation: 7 }), checkin("c", DAY, { fatigue: 8 })], NOW);
  assert.equal(sustained.severity, "warning");
  assert.match(sustained.explanation, /each of the last 3 shared check-ins/);
  assert.equal(sustained.evidence.length, 3);
  const low = evaluateWellbeingRule([checkin("a", 3 * DAY, { mood: 2 }), checkin("b", 2 * DAY, { mood: 1 }), checkin("c", DAY, { mood: 2 })], NOW);
  assert.equal(low.severity, "critical");
  assert.match(low.explanation, /1–2\/5 in each of the last 3 shared check-ins on 3 different days/);
  const sameDay = evaluateWellbeingRule([checkin("a", 3000, { mood: 2 }), checkin("b", 2000, { mood: 1 }), checkin("c", 1000, { mood: 2 })], NOW);
  assert.notEqual(sameDay.severity, "critical", "3 check-ins on one day are not 3 days");
  const withPrivate = evaluateWellbeingRule([checkin("a", 3 * DAY, { mood: 2 }), checkin("b", 2 * DAY, { mood: 1 }, 0), checkin("c", DAY, { mood: 2 })], NOW);
  assert.notEqual(withPrivate.severity, "critical", "private check-ins never count");
});
