// tests/unit/format.test.mjs — js/core/utils/format.js (UTC option + relative times).
// Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";

const f = await import("../../js/core/utils/format.js");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T = Date.UTC(2026, 10, 15, 0, 5); // 15 Nov 2026, 00:05 UTC

test("formatTime: { timeZone: 'UTC' } uses the mission clock and a 00–23 hour cycle", () => {
  assert.match(f.formatTime(T, { timeZone: "UTC" }), /^00.05$/, "just after midnight is 00:05, never 24:05");
  assert.match(f.formatTime(Date.UTC(2026, 10, 14, 23, 59), { timeZone: "UTC" }), /^23.59$/);
  assert.match(f.formatTime(Date.UTC(2026, 10, 14, 14, 0, 9), { timeZone: "UTC", seconds: true }), /^14.00.09$/);
});

test("without timeZone the existing local-time behaviour is unchanged", () => {
  const expected = new Date(T).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  assert.equal(f.formatTime(T), expected);
  assert.equal(f.formatDate(T), new Date(T).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }));
});

test("formatDate / formatDateTime accept the UTC option", () => {
  const late = Date.UTC(2026, 10, 14, 23, 30);
  assert.match(f.formatDate(late, { timeZone: "UTC" }), /14/, "still the 14th in UTC");
  assert.ok(f.formatDateTime(late, { timeZone: "UTC" }).includes(f.formatTime(late, { timeZone: "UTC" })));
  assert.ok(f.formatDateTime(late, { timeZone: "UTC" }).startsWith(f.formatDate(late, { timeZone: "UTC" })));
});

test("invalid values are handled safely", () => {
  for (const bad of [null, undefined, "not a date", NaN, Infinity]) {
    assert.equal(f.formatTime(bad, { timeZone: "UTC" }), "—", String(bad));
    assert.equal(f.formatDate(bad, { timeZone: "UTC" }), "—", String(bad));
    assert.equal(f.formatDateTime(bad, { timeZone: "UTC" }), "—", String(bad));
    assert.equal(f.formatRelative(bad, T), "—", String(bad));
  }
  assert.equal(f.formatRelative(T, NaN), "—");
});

test("formatRelative: past times", () => {
  assert.equal(f.formatRelative(T - 10 * 1000, T), "just now");
  assert.equal(f.formatRelative(T - 5 * MIN, T), "5 min ago");
  assert.equal(f.formatRelative(T - 3 * HOUR, T), "3 h ago");
  assert.equal(f.formatRelative(T - 2 * DAY, T), "2 d ago");
});

test("formatRelative: future times are described honestly, not as 'just now'", () => {
  assert.equal(f.formatRelative(T + 10 * 1000, T), "just now", "tiny clock differences are ignored");
  assert.equal(f.formatRelative(T + 5 * MIN, T), "in 5 min");
  assert.equal(f.formatRelative(T + 3 * HOUR, T), "in 3 h");
  assert.equal(f.formatRelative(T + 2 * DAY, T), "in 2 d");
});
