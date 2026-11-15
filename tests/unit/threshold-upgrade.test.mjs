// tests/unit/threshold-upgrade.test.mjs — PHY-02 v2 demo SpO₂ bands reach browsers
// that were seeded earlier, without touching any other stored value.
import test from "node:test";
import assert from "node:assert/strict";

await import("./fake-dom.mjs");
const { upgradeDemoThresholds } = await import("../../js/db/seed.js");

test("old seeded SpO₂ thresholds are upgraded once; anything else is left alone", async () => {
  let store = { label: "x", metrics: { spo2: { warningLow: 95, criticalLow: 92 }, heartRate: { warningHigh: 100, criticalHigh: 120 } } };
  const writes = [];
  const repo = { get: async () => store, set: async (k, v, by) => { writes.push([k, by]); store = v; } };
  assert.equal(await upgradeDemoThresholds({ repo }), true);
  assert.deepEqual(store.metrics.spo2, { infoLow: 95, warningLow: 93, criticalLow: 90 });
  assert.deepEqual(store.metrics.heartRate, { warningHigh: 100, criticalHigh: 120 }, "other metrics unchanged");
  assert.deepEqual(store.metrics.bodyTemperature, { warningHigh: 37.5, criticalHigh: 38.5, warningLow: 36.1, criticalLow: 35 }, "seed v2 metrics added");
  assert.deepEqual(store.metrics.cabinCo2, { warningHigh: 4, criticalHigh: 6 });
  assert.equal(store.label, "x");
  assert.deepEqual(writes, [["thresholds", "system"]]);
  assert.equal(await upgradeDemoThresholds({ repo }), false, "second run is a no-op");
  store = { metrics: { spo2: { warningLow: 96, criticalLow: 92 }, bodyTemperature: { warningHigh: 37.9 }, cabinCo2: { warningHigh: 5 }, cabinPressure: { warningLow: 97 }, cabinHumidity: { warningHigh: 65 } } };
  assert.equal(await upgradeDemoThresholds({ repo }), false, "edited values are never overwritten");
  assert.equal(store.metrics.bodyTemperature.warningHigh, 37.9);
  assert.equal(await upgradeDemoThresholds({ repo: { get: async () => { throw new Error("db"); } } }), false, "never throws");
});
