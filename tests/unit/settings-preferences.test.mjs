// tests/unit/settings-preferences.test.mjs — Sprint 9 read-only settings service and
// browser-only personal preferences (js/core/preferences.js).
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

const settings = await import("../../js/services/settings-service.js");
const prefsMod = await import("../../js/core/preferences.js");
const mock = await import("../../js/db/mock-repositories.js");

const NOW = Date.UTC(2026, 10, 14, 15, 30);
const MO = Object.freeze({ role: "medical_officer", userId: "u-medofficer", astronautId: "" });
const HADDAD = Object.freeze({ role: "astronaut", userId: "u-haddad", astronautId: "a-01" });

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
class FakeRoot { constructor() { this.attrs = {}; } setAttribute(k, v) { this.attrs[k] = v; } }
class FakeEvents {
  constructor() { this.handlers = []; }
  addEventListener(t, fn) { if (t === "storage") this.handlers.push(fn); }
  removeEventListener(t, fn) { this.handlers = this.handlers.filter((h) => h !== fn); }
  fire(key) { for (const h of [...this.handlers]) h({ key }); }
}

// ---- settings service -------------------------------------------------------------

test("settings view: role-aware; thresholds + simulation never returned to astronauts; read-only", async () => {
  await mock.resetMock({ now: NOW });
  const calls = [];
  const repos = { usersRepo: mock.usersRepo, astronautsRepo: mock.astronautsRepo, settingsRepo: new Proxy(mock.settingsRepo, { get: (t, p) => (typeof t[p] === "function" ? (...a) => { calls.push(String(p)); return t[p](...a); } : t[p]) }) };
  const s = settings.createSettingsService({ repos });
  const a = await s.getSettingsView(HADDAD, { now: NOW });
  assert.equal(a.status, "ready");
  assert.equal(a.viewer, "astronaut");
  assert.ok(!("thresholds" in a) && !("simulation" in a));
  assert.ok(!/warningLow|criticalHigh|"speed"/.test(JSON.stringify(a)));
  assert.deepEqual(a.mission, { status: "ok", name: "ODYSSEY-7", missionDay: 147, startDate: a.mission.startDate });
  assert.equal(a.units.find((u) => u.key === "spo2").unit, "%");
  const m = await s.getSettingsView(MO, { now: NOW });
  assert.equal(m.thresholds.label, "Demonstration thresholds — not clinically validated.");
  assert.deepEqual(m.thresholds.rows.map((r) => [r.rule, r.warning, r.critical]), [["PHY-01", 100, 120], ["PHY-02", 95, 92], ["PHY-03", 140, 160], ["PHY-05", 6.5, 5]]);
  assert.deepEqual(m.simulation, { status: "ok", speed: 1 });
  assert.ok(!calls.includes("set"), "never writes settings");
  for (const r of [a, m]) assert.ok(!/u-[a-z]+|a-0\d|passwordHash|salt|session/.test(JSON.stringify(r)));
  for (const bad of [null, { role: "admin", userId: "u-medofficer" }, { ...MO, astronautId: "a-01" }, { ...HADDAD, astronautId: "a-03" }]) {
    assert.equal((await s.getSettingsView(bad, { now: NOW })).status, "forbidden");
  }
  const src = code("js/services/settings-service.js");
  assert.ok(!/settingsRepo\.set|\.set\(/.test(src), "no settingsRepo.set anywhere");
});

// ---- preferences -------------------------------------------------------------------

test("validation: only allow-listed values; malformed JSON / shapes fall back safely", () => {
  assert.deepEqual(prefsMod.validatePrefs({ textSize: "large", motion: "reduce" }), { textSize: "large", motion: "reduce" });
  assert.deepEqual(prefsMod.validatePrefs({ textSize: "huge", motion: 1, extra: "x" }), prefsMod.DEFAULT_PREFS);
  for (const bad of ["{", "[]", "null", "42", '"x"', JSON.stringify({ "../evil": { textSize: "large" } })]) assert.deepEqual(prefsMod.parseStore(bad), {}, bad);
  assert.deepEqual(prefsMod.parseStore(JSON.stringify({ "u-a": { textSize: "larger", motion: "nope", password: "x" } })), { "u-a": { textSize: "larger", motion: "system" } });
  const storage = new MemoryStorage();
  storage.setItem(prefsMod.PREFS_KEY, "not json");
  const p = prefsMod.createPreferences({ storage: () => storage, root: () => new FakeRoot(), events: new FakeEvents() });
  assert.deepEqual(p.get("u-haddad"), prefsMod.DEFAULT_PREFS);
  assert.deepEqual(p.set("u-haddad", { textSize: "gigantic" }), { ok: false, reason: "invalid_value", prefs: prefsMod.DEFAULT_PREFS, persisted: false });
  assert.equal(p.set("../x", { textSize: "large" }).reason, "invalid_user");
});

test("per-user isolation, apply attributes, reset only the current user; only two keys stored", () => {
  const storage = new MemoryStorage();
  const root = new FakeRoot();
  const p = prefsMod.createPreferences({ storage: () => storage, root: () => root, events: new FakeEvents() });
  assert.deepEqual(p.set("u-haddad", { textSize: "larger" }), { ok: true, prefs: { textSize: "larger", motion: "system" }, persisted: true });
  assert.deepEqual(root.attrs, { "data-text-size": "larger", "data-motion": "system" });
  p.set("u-chen", { motion: "reduce" });
  assert.deepEqual(p.get("u-haddad"), { textSize: "larger", motion: "system" });
  assert.deepEqual(p.get("u-chen"), { textSize: "standard", motion: "reduce" });
  const stored = JSON.parse(storage.getItem(prefsMod.PREFS_KEY));
  assert.deepEqual(Object.keys(stored).sort(), ["u-chen", "u-haddad"]);
  assert.ok(Object.values(stored).every((v) => Object.keys(v).sort().join() === "motion,textSize"));
  assert.ok(!/session|password|token|role|astronautId/.test(storage.getItem(prefsMod.PREFS_KEY)));
  p.reset("u-haddad");
  assert.deepEqual(p.get("u-haddad"), prefsMod.DEFAULT_PREFS);
  assert.deepEqual(p.get("u-chen"), { textSize: "standard", motion: "reduce" }, "another user's entry is untouched");
  assert.deepEqual(root.attrs, { "data-text-size": "standard", "data-motion": "system" });
  p.reset("u-chen");
  assert.equal(storage.getItem(prefsMod.PREFS_KEY), null);
});

test("blocked storage: kept in memory for this tab, persisted:false; nothing thrown", () => {
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  for (const storage of [() => { throw new Error("SecurityError"); }, () => null, () => throwing]) {
    const root = new FakeRoot();
    const p = prefsMod.createPreferences({ storage, root: () => root, events: new FakeEvents() });
    assert.equal(p.isPersistent(), false);
    const r = p.set("u-haddad", { textSize: "large" });
    assert.deepEqual([r.ok, r.persisted, r.prefs.textSize], [true, false, "large"]);
    assert.equal(p.get("u-haddad").textSize, "large", "this tab keeps it");
    assert.equal(root.attrs["data-text-size"], "large");
  }
});

test("cross-tab sync: a storage event re-reads and re-applies; unrelated keys are ignored", () => {
  const storage = new MemoryStorage();
  const events = new FakeEvents();
  const root = new FakeRoot();
  const tabB = prefsMod.createPreferences({ storage: () => storage, root: () => root, events });
  const seen = [];
  const stop = tabB.subscribe("u-haddad", (p) => seen.push(p));
  // "Tab A" writes directly to the shared storage.
  storage.setItem(prefsMod.PREFS_KEY, JSON.stringify({ "u-haddad": { textSize: "larger", motion: "reduce" } }));
  events.fire("astrohealth.session");
  assert.equal(seen.length, 0, "other keys ignored");
  events.fire(prefsMod.PREFS_KEY);
  assert.deepEqual(seen, [{ textSize: "larger", motion: "reduce" }]);
  assert.deepEqual(root.attrs, { "data-text-size": "larger", "data-motion": "reduce" });
  stop();
  events.fire(prefsMod.PREFS_KEY);
  assert.equal(seen.length, 1, "unsubscribed");
});

test("structure: preferences touch only their own key; base.css has the hooks; app-shell applies at startup", () => {
  const src = code("js/core/preferences.js");
  assert.ok(!/SESSION_KEY|astrohealth\.session|password|location\.|innerHTML|indexedDB|\/db\//.test(src));
  const css = readFileSync(join(ROOT, "css/base.css"), "utf8");
  assert.match(css, /html\[data-text-size="large"\]/);
  assert.match(css, /html\[data-text-size="larger"\]/);
  assert.match(css, /html\[data-motion="reduce"\] \*/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, "system preference still respected");
  const shell = readFileSync(join(ROOT, "js/pages/app-shell.js"), "utf8");
  assert.match(shell, /preferences\.apply\(current\.userId\)/);
});
