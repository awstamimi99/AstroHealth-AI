// tests/unit/simulation-scenarios.test.mjs — Sprint 7 scenario catalog (pure, static, deterministic).
// Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const code = (p) => read(p).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

const cat = await import("../../js/simulation/scenarios.js");
const { METRIC_UNITS, METRICS } = await import("../../js/db/constants.js");

const BANNED = [
  /\bhealthy\b/i, /\bunhealthy\b/i, /\bsafe\b/i, /normal health/i, /\bdiagnos/i, /medically cleared/i, /fit for duty/i,
  /depression/i, /anxiety/i, /\btreatment\b/i, /\btreat\b/i, /AI health score/i, /clinical risk score/i, /hypoxi/i,
  /\bclinical\b/i, /\bNASA\b/,
];

test("7. scenario ids are stable, unique and exactly the approved two", () => {
  const ids = cat.SCENARIOS.map((s) => s.id);
  assert.deepEqual(ids, ["low_oxygen", "elevated_heart_rate"]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(cat.CATALOG_VERSION, 1);
  assert.equal(cat.getScenario("low_oxygen").metric, "spo2");
  assert.equal(cat.getScenario("sleep_deprivation"), null);
  assert.equal(cat.getScenario(undefined), null);
});

test("8. only documented metrics, with the database's canonical units", () => {
  for (const s of cat.SCENARIOS) {
    assert.ok(METRICS.includes(s.metric), s.id);
    assert.equal(s.unit, METRIC_UNITS[s.metric], s.id);
    assert.deepEqual({ ...s.phases }, { ramp: 5, hold: 2, recovery: 5 });
    assert.equal(s.totalSteps, 12);
  }
  assert.deepEqual([...cat.SIMULATION_SPEEDS], [1, 2, 4, 8]);
  assert.equal(cat.DEFAULT_SPEED, 1);
  assert.equal(cat.BASE_STEP_MS, 8000);
  assert.deepEqual(cat.SIMULATION_SPEEDS.map(cat.stepIntervalMs), [8000, 4000, 2000, 1000]);
});

test("9. exact deterministic sequences; final value equals the start value", () => {
  const low = cat.getScenario("low_oxygen");
  const hr = cat.getScenario("elevated_heart_rate");
  assert.deepEqual(cat.scenarioSequence(low, 98).map((x) => x.value), [96, 94, 92, 90, 88, 88, 88, 90, 92, 94, 96, 98]);
  assert.deepEqual(cat.scenarioSequence(hr, 72).map((x) => x.value), [83, 94, 106, 117, 128, 128, 128, 117, 106, 94, 83, 72]);
  assert.deepEqual(cat.scenarioSequence(low, 98).map((x) => x.phase), ["ramp", "ramp", "ramp", "ramp", "ramp", "hold", "hold", "recovery", "recovery", "recovery", "recovery", "recovery"]);
  // Every allowed start value: whole numbers, 12 values, target reached, back to start, identical on repeat.
  for (const s of cat.SCENARIOS) {
    for (let start = s.startRange.min; start <= s.startRange.max; start += 1) {
      const a = cat.scenarioSequence(s, start).map((x) => x.value);
      const b = cat.scenarioSequence(s, start).map((x) => x.value);
      assert.deepEqual(a, b);
      assert.equal(a.length, 12);
      assert.ok(a.every(Number.isInteger), `${s.id} ${start}`);
      assert.equal(a[4], s.target);
      assert.equal(a[11], start, `${s.id}: final value equals start ${start}`);
    }
  }
  assert.throws(() => cat.scenarioValue(low, 98, 0), RangeError);
  assert.throws(() => cat.scenarioValue(low, 98, 13), RangeError);
  assert.throws(() => cat.scenarioValue(low, 97.5, 1), RangeError);
});

test("start value uses the stored baseline only inside the approved range", () => {
  const low = cat.getScenario("low_oxygen");
  const hr = cat.getScenario("elevated_heart_rate");
  assert.deepEqual(cat.resolveScenarioStartValue(low, { spo2: 97 }), { value: 97, source: "baseline" });
  assert.deepEqual(cat.resolveScenarioStartValue(low, { spo2: 93 }), { value: 98, source: "default" });
  assert.deepEqual(cat.resolveScenarioStartValue(low, { spo2: 101 }), { value: 98, source: "default" });
  assert.deepEqual(cat.resolveScenarioStartValue(low, { spo2: null }), { value: 98, source: "default" });
  assert.deepEqual(cat.resolveScenarioStartValue(low, null), { value: 98, source: "default" });
  assert.deepEqual(cat.resolveScenarioStartValue(hr, { heartRate: 70.4 }), { value: 70, source: "baseline" });
  assert.deepEqual(cat.resolveScenarioStartValue(hr, { heartRate: 96 }), { value: 72, source: "default" });
  assert.deepEqual(cat.resolveScenarioStartValue(hr, { heartRate: "72" }), { value: 72, source: "default" });
  assert.deepEqual(cat.resolveScenarioStartValue(hr, { heartRate: Number.NaN }), { value: 72, source: "default" });
});

test("10. no diagnostic, treatment, clinical or endorsement claims; every scenario carries the disclaimer", () => {
  for (const s of cat.SCENARIOS) {
    const text = [s.name, s.description, s.metricLabel].join(" ");
    for (const re of BANNED) assert.ok(!re.test(text), `${s.id}: ${re}`);
    assert.equal(s.disclaimer, cat.SCENARIO_DISCLAIMER);
  }
  assert.match(cat.SCENARIO_DISCLAIMER, /Synthetic/);
  assert.match(cat.SCENARIO_DISCLAIMER, /not a medical device/i);
  assert.match(cat.SCENARIO_DISCLAIMER, /not clinically validated/i);
  assert.match(cat.SCENARIO_DISCLAIMER, /not affiliated with or endorsed by NASA/);
});

test("11 + purity: js/simulation/ files import nothing, use no randomness, clock or side effects", () => {
  const files = readdirSync(join(ROOT, "js/simulation")).filter((f) => f.endsWith(".js"));
  assert.deepEqual(files, ["scenarios.js"]);
  for (const f of files) {
    const src = code(`js/simulation/${f}`);
    assert.ok(!/^\s*import\s/m.test(src), `${f}: no static imports`);
    assert.ok(!/\bimport\s*\(/.test(src), `${f}: no dynamic imports`);
    for (const bad of ["Math.random", "Date.now", "new Date", "crypto", "localStorage", "indexedDB", "document", "window", "fetch(", "setTimeout", "setInterval"]) {
      assert.ok(!src.includes(bad), `${f}: ${bad}`);
    }
  }
});

test("catalog objects are frozen and helpers never mutate their inputs", () => {
  assert.ok(Object.isFrozen(cat.SCENARIOS));
  assert.ok(Object.isFrozen(cat.SIMULATION_SPEEDS));
  for (const s of cat.SCENARIOS) {
    assert.ok(Object.isFrozen(s));
    assert.ok(Object.isFrozen(s.phases));
    assert.ok(Object.isFrozen(s.startRange));
  }
  const before = JSON.stringify(cat.SCENARIOS);
  const baseline = Object.freeze({ spo2: 97, heartRate: 70 });
  for (const s of cat.SCENARIOS) {
    const seq = cat.scenarioSequence(s, cat.resolveScenarioStartValue(s, baseline).value);
    assert.ok(Object.isFrozen(seq) && seq.every(Object.isFrozen));
  }
  assert.equal(JSON.stringify(cat.SCENARIOS), before);
  assert.throws(() => { "use strict"; cat.SCENARIOS[0].target = 1; }, TypeError);
});
