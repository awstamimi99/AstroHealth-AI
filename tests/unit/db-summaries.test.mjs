// Unit tests for js/db/summaries.js and js/db/ids.js — run with: npm run test:unit
import test from "node:test";
import assert from "node:assert/strict";
import {
  toDateKey, dateKeyToStart, startOfUtcDay, summaryId, summarize, mergeIntoSummary, applyToLatest,
} from "../../js/db/summaries.js";
import { newId, seedId, formatAlertNumber, parseAlertNumber, nextAlertNumber } from "../../js/db/ids.js";
import { DatabaseError } from "../../js/db/errors.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 14, 0, 0, 0); // 2026-11-14 00:00 UTC
const m = (value, timestamp, extra = {}) => ({ astronautId: "a-01", metric: "heartRate", value, timestamp, quality: "ok", ...extra });

// ---- dates ------------------------------------------------------------------

test("toDateKey uses the UTC calendar day", () => {
  assert.equal(toDateKey(T0), "2026-11-14");
  assert.equal(toDateKey(T0 + DAY - 1), "2026-11-14");
  assert.equal(toDateKey(T0 + DAY), "2026-11-15");
  assert.equal(toDateKey(T0 - 1), "2026-11-13");
});

test("dateKeyToStart and startOfUtcDay round-trip", () => {
  assert.equal(dateKeyToStart("2026-11-14"), T0);
  assert.equal(startOfUtcDay(T0 + 13 * 3600 * 1000), T0);
});

test("summaryId format", () => {
  assert.equal(summaryId("a-01", "spo2", "2026-11-14"), "a-01:spo2:2026-11-14");
});

// ---- aggregation ------------------------------------------------------------

test("summarize: min/max/avg/count per astronaut, metric and day", () => {
  const list = [
    m(60, T0 + 1000), m(80, T0 + 2000), m(70, T0 + 3000), // day 1
    m(90, T0 + DAY + 1000),                                // day 2
    m(97, T0 + 5000, { metric: "spo2" }),                  // other metric
    m(55, T0 + 6000, { astronautId: "a-02" }),             // other astronaut
  ];
  const result = summarize(list, 123);
  const day1 = result.find((s) => s.id === "a-01:heartRate:2026-11-14");
  assert.deepEqual(
    { min: day1.min, max: day1.max, avg: day1.avg, count: day1.count, date: day1.date },
    { min: 60, max: 80, avg: 70, count: 3, date: "2026-11-14" }
  );
  assert.equal(result.find((s) => s.id === "a-01:heartRate:2026-11-15").count, 1);
  assert.equal(result.find((s) => s.id === "a-01:spo2:2026-11-14").avg, 97);
  assert.equal(result.find((s) => s.id === "a-02:heartRate:2026-11-14").min, 55);
  assert.equal(result.length, 4);
  assert.equal(day1.updatedAt, 123);
});

test("summarize skips invalid readings but keeps suspect ones", () => {
  const result = summarize([m(70, T0), m(200, T0 + 1, { quality: "invalid" }), m(40, T0 + 2, { quality: "suspect" })]);
  assert.equal(result[0].count, 2);
  assert.equal(result[0].max, 70);
  assert.equal(result[0].min, 40);
});

test("incremental mergeIntoSummary gives the same result as a batch summarize", () => {
  const values = [72, 68, 75.5, 81, 64, 70.25, 77];
  let running = null;
  values.forEach((v, i) => (running = mergeIntoSummary(running, m(v, T0 + i), 1)));
  const [batch] = summarize(values.map((v, i) => m(v, T0 + i)), 1);
  assert.equal(running.count, batch.count);
  assert.equal(running.min, batch.min);
  assert.equal(running.max, batch.max);
  assert.ok(Math.abs(running.avg - batch.avg) < 1e-9);
  assert.ok(Math.abs(batch.avg - values.reduce((a, b) => a + b) / values.length) < 1e-9);
});

test("mergeIntoSummary does not change its input", () => {
  const first = mergeIntoSummary(null, m(70, T0));
  const copy = structuredClone(first);
  mergeIntoSummary(first, m(90, T0 + 1));
  assert.deepEqual(first, copy);
});

// ---- latest cache -----------------------------------------------------------

test("applyToLatest only moves forward and ignores invalid readings", () => {
  let { changed, latest } = applyToLatest({}, m(70, 1000));
  assert.ok(changed);
  assert.deepEqual(latest.heartRate, { value: 70, timestamp: 1000 });

  ({ changed } = applyToLatest(latest, m(99, 500))); // older
  assert.equal(changed, false);
  ({ changed } = applyToLatest(latest, m(99, 2000, { quality: "invalid" })));
  assert.equal(changed, false);
  ({ changed, latest } = applyToLatest(latest, m(75, 2000)));
  assert.ok(changed);
  assert.equal(latest.heartRate.value, 75);
});

// ---- IDs --------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("newId: prefix + underscore + v4 UUID, unique", () => {
  const id = newId("msr");
  assert.match(id, /^msr_/);
  assert.match(id.slice(4), UUID);
  const many = new Set(Array.from({ length: 1000 }, () => newId("evt")));
  assert.equal(many.size, 1000);
});

test("newId rejects bad prefixes", () => {
  assert.throws(() => newId(""), DatabaseError);
  assert.throws(() => newId("Bad Prefix"), DatabaseError);
});

test("seedId is fixed-width and deterministic", () => {
  assert.equal(seedId("msr", 42), "msr_seed_00042");
});

test("alert numbers: format and parse", () => {
  assert.equal(formatAlertNumber(1), "ALT-0001");
  assert.equal(formatAlertNumber(193), "ALT-0193");
  assert.equal(formatAlertNumber(12345), "ALT-12345");
  assert.equal(parseAlertNumber("ALT-0193"), 193);
  assert.ok(Number.isNaN(parseAlertNumber("ALERT-1")));
  assert.throws(() => formatAlertNumber(0), DatabaseError);
});

test("nextAlertNumber increments meta.alertCounter (fake object store)", async () => {
  // Minimal stand-in for an IDBObjectStore: get/put return request objects.
  const rows = new Map([["alertCounter", { key: "alertCounter", value: 190 }]]);
  const request = (fn) => {
    const req = {};
    queueMicrotask(() => { req.result = fn(); req.onsuccess?.(); });
    return req;
  };
  const fakeMeta = {
    get: (key) => request(() => rows.get(key)),
    put: (row) => request(() => rows.set(row.key, row)),
  };
  assert.equal(await nextAlertNumber(fakeMeta), "ALT-0191");
  assert.equal(await nextAlertNumber(fakeMeta), "ALT-0192");
  assert.equal(rows.get("alertCounter").value, 192);
  await assert.rejects(nextAlertNumber(null), DatabaseError);
});
