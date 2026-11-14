// tests/unit/wellbeing-service.test.mjs — Sprint 6 wellbeing reads, check-in write, privacy.
// Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

globalThis.self = globalThis;
globalThis.BroadcastChannel = class { postMessage() {} addEventListener() {} close() {} };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const code = (p) => read(p).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

const svc = await import("../../js/services/wellbeing-service.js");
const mock = await import("../../js/db/mock-repositories.js");

const HOUR = 3600e3;
const NOW = Date.UTC(2026, 10, 14, 15, 30);
const HADDAD = Object.freeze({ role: "astronaut", userId: "u-haddad", astronautId: "a-01" });
const CHEN = Object.freeze({ role: "astronaut", userId: "u-chen", astronautId: "a-03" });
const MO = Object.freeze({ role: "medical_officer", userId: "u-medofficer", astronautId: "" });
const ANSWERS = Object.freeze({ mood: 4, stress: 3, sleepQuality: 4, fatigue: 2, isolation: 1, wellbeing: 4 });

const repos = () => ({ usersRepo: mock.usersRepo, astronautsRepo: mock.astronautsRepo, wellbeingRepo: mock.wellbeingRepo, cognitiveRepo: mock.cognitiveRepo, alertsRepo: mock.alertsRepo, eventsRepo: mock.eventsRepo });
function spy(rs) {
  const calls = [];
  const wrapped = {};
  for (const [name, repo] of Object.entries(rs)) wrapped[name] = new Proxy(repo, { get(t, p) { const v = t[p]; return typeof v !== "function" ? v : (...a) => { calls.push({ repo: name, method: String(p), args: a }); return v.apply(t, a); }; } });
  return { repos: wrapped, calls };
}
function service(overrides = {}) {
  const s = spy({ ...repos(), ...overrides });
  return { ...s, service: svc.createWellbeingService({ repos: s.repos, withTransaction: mock.withTransaction }) };
}
const reset = () => mock.resetMock({ now: NOW });
const countRecords = async (aid) => (await mock.wellbeingRepo.getRange(aid)).length;
const countEvents = async (aid) => (await mock.eventsRepo.getRange({ astronautId: aid, types: "checkin_completed" })).length;

await reset();

// =====================================================================================
// Reads and privacy
// =====================================================================================

test("21. an astronaut gets only their own check-ins (private and shared) — no ids leak", async () => {
  const { service: s, calls } = service();
  const r = await s.getOwnWellbeing(HADDAD, { now: NOW, astronautId: "a-03" });
  assert.equal(r.status, "ready");
  assert.equal(r.profile.crewId, "AH-01");
  assert.ok(r.checkins.items.length >= 28);
  assert.ok(r.checkins.items.some((c) => !c.shared), "own private check-ins are visible to the owner");
  assert.ok(calls.filter((c) => c.repo === "wellbeingRepo").every((c) => c.args[0] === "a-01"));
  const json = JSON.stringify(r);
  for (const bad of ['"a-0', "u-haddad", "wba_", "createdBy", "sharedWithMedical"]) assert.ok(!json.includes(bad), bad);
  assert.deepEqual(r.summary.basedOn, svc.OWN_SUMMARY_LABEL);
});

test("22–24. the officer gets only SHARED check-ins; private ones are never returned or counted", async () => {
  const { service: s, calls } = service();
  const r = await s.getCrewMemberSharedWellbeing(MO, "AH-01", { now: NOW });
  const own = await service().service.getOwnWellbeing(HADDAD, { now: NOW });
  const privateCount = own.checkins.items.filter((c) => !c.shared).length;
  assert.ok(privateCount >= 3);
  assert.equal(r.checkins.items.length, own.checkins.items.length - privateCount);
  assert.ok(r.checkins.items.every((c) => c.shared === true));
  assert.equal(r.summary.basedOn, "Based only on check-ins shared by the astronaut.");
  // Officer path never uses per-astronaut wellbeing reads.
  const wb = calls.filter((c) => c.repo === "wellbeingRepo").map((c) => c.method);
  assert.deepEqual(wb, ["getSharedRange"]);
  // Averages are computed from shared records only (a faulty repository returning private rows can't leak).
  const leaky = { ...mock.wellbeingRepo, getSharedRange: async () => [
    { astronautId: "a-01", timestamp: NOW - HOUR, sharedWithMedical: 0, mood: 1, stress: 10, sleepQuality: 1, fatigue: 10, isolation: 10, wellbeing: 1, source: "manual" },
    { astronautId: "a-01", timestamp: NOW - 2 * HOUR, sharedWithMedical: 1, mood: 5, stress: 0, sleepQuality: 5, fatigue: 0, isolation: 0, wellbeing: 5, source: "manual" },
    { astronautId: "a-02", timestamp: NOW - HOUR, sharedWithMedical: 1, mood: 1, stress: 9, sleepQuality: 1, fatigue: 9, isolation: 9, wellbeing: 1, source: "manual" },
    { astronautId: "a-01", timestamp: NOW + HOUR, sharedWithMedical: 1, mood: 1, stress: 9, sleepQuality: 1, fatigue: 9, isolation: 9, wellbeing: 1, source: "manual" },
  ] };
  const l = await service({ wellbeingRepo: leaky }).service.getCrewMemberSharedWellbeing(MO, "AH-01", { now: NOW });
  assert.equal(l.checkins.items.length, 1);
  assert.deepEqual(l.summary, { basedOn: svc.SHARED_SUMMARY_LABEL, count: 1, averages: { mood: 5, stress: 0, sleepQuality: 5, fatigue: 0, isolation: 0, wellbeing: 5 } });
});

test("officer path: verified first, strict crew ID, no todayCheckin or private signal in the output", async () => {
  for (const [session, id, status] of [[HADDAD, "AH-01", "forbidden"], [MO, "a-01", "not_found"], [MO, "AH-99", "not_found"], [{ ...MO, userId: "u-chen" }, "AH-01", "forbidden"]]) {
    const { service: s, calls } = service();
    const r = await s.getCrewMemberSharedWellbeing(session, id, { now: NOW });
    assert.equal(r.status, status, `${session.userId} ${id}`);
    assert.ok(calls.every((c) => ["usersRepo", "astronautsRepo"].includes(c.repo)), "no wellbeing read");
  }
  const r = await service().service.getCrewMemberSharedWellbeing(MO, "AH-01", { now: NOW });
  assert.equal(r.todayCheckin, undefined);
  assert.ok(!JSON.stringify(r).includes('"shared":false'));
});

test("25. no Sprint 6 module imports or calls journalRepo; officer/physical code has no write paths", () => {
  const files = ["js/services/access-control.js", "js/services/physical-health-service.js", "js/services/wellbeing-service.js", "js/components/health-view.js", "js/pages/physical-health.js", "js/pages/wellbeing.js"];
  // Access, not wording: the officer view legitimately SAYS "the private journal is never shown".
  for (const f of files) assert.doesNotMatch(code(f), /journalRepo|privateJournal|getByAstronaut\(/, f);
  assert.match(code("js/pages/wellbeing.js"), /private journal are never shown or counted/, "the privacy notice is present");
});

test("26. cognitive scores never leave the service (last-completed time only)", async () => {
  for (const r of [await service().service.getOwnWellbeing(HADDAD, { now: NOW }), await service().service.getCrewMemberSharedWellbeing(MO, "AH-04", { now: NOW })]) {
    assert.deepEqual(Object.keys(r.cognitive).sort(), ["lastAt", "status"]);
    const json = JSON.stringify(r);
    assert.ok(!json.includes("meanReactionMs") && !json.includes("misses"));
  }
});

test("wellbeing alerts: open, wellbeing category only (Chen ALT-0189; Reyes's physical ALT-0190 excluded)", async () => {
  const chen = await service().service.getOwnWellbeing(CHEN, { now: NOW });
  assert.deepEqual(chen.alerts.items.map((a) => a.number), ["ALT-0189"]);
  const reyes = await service().service.getCrewMemberSharedWellbeing(MO, "AH-04", { now: NOW });
  assert.deepEqual(reyes.alerts.items, []);
});

// =====================================================================================
// Validation
// =====================================================================================

test("27–29. all six scores required, whole numbers in range; share must be exactly true/false", () => {
  assert.deepEqual(svc.validateCheckin({ ...ANSWERS, share: false }), { ok: true, value: { ...ANSWERS, share: false } });
  const missing = svc.validateCheckin({});
  assert.deepEqual(Object.keys(missing.errors).sort(), ["fatigue", "isolation", "mood", "share", "sleepQuality", "stress", "wellbeing"]);
  const bad = [
    ["mood", 0], ["mood", 6], ["mood", 2.5], ["mood", "3"], ["mood", true], ["mood", NaN], ["mood", Infinity], ["mood", null],
    ["stress", -1], ["stress", 11], ["sleepQuality", 0], ["fatigue", 10.1], ["isolation", -0.5], ["wellbeing", 6],
  ];
  for (const [field, value] of bad) {
    const r = svc.validateCheckin({ ...ANSWERS, [field]: value, share: false });
    assert.equal(r.ok, false, `${field}=${String(value)}`);
    assert.ok(r.errors[field], field);
  }
  for (const share of [undefined, null, "true", 1, 0, "shared"]) {
    assert.ok(svc.validateCheckin({ ...ANSWERS, share }).errors.share, String(share));
  }
  for (const [field, [min, max]] of Object.entries({ mood: [1, 5], stress: [0, 10], sleepQuality: [1, 5], fatigue: [0, 10], isolation: [0, 10], wellbeing: [1, 5] })) {
    assert.equal(svc.validateCheckin({ ...ANSWERS, [field]: min, share: true }).ok, true);
    assert.equal(svc.validateCheckin({ ...ANSWERS, [field]: max, share: true }).ok, true);
  }
});

test("30. invalid input performs no writes", async () => {
  await reset();
  const before = await countRecords("a-01");
  const { service: s, calls } = service();
  const r = await s.createCheckin(HADDAD, { ...ANSWERS, mood: 9, share: false }, { now: NOW });
  assert.equal(r.status, "invalid");
  assert.ok(r.errors.mood);
  assert.ok(!calls.some((c) => ["add", "getLatest"].includes(c.method)));
  assert.equal(await countRecords("a-01"), before);
});

// =====================================================================================
// Writes
// =====================================================================================

test("31–33 + 39. sharing needs its own confirmation; the record uses documented fields; the event has no scores; both written together", async () => {
  await reset();
  const { service: s, calls } = service();
  const first = await s.createCheckin(HADDAD, { ...ANSWERS, share: true, extra: "ignored", astronautId: "a-03", source: "seed", createdBy: "u-chen", timestamp: 1 }, { now: NOW + 1000, confirmSameDay: true });
  assert.deepEqual(first, { status: "confirm_share", reason: "" });
  assert.ok(!calls.some((c) => c.method === "add"), "nothing written before share confirmation");
  const saved = await s.createCheckin(HADDAD, { ...ANSWERS, share: true, extra: "ignored", astronautId: "a-03", source: "seed", createdBy: "u-chen", timestamp: 1 }, { now: NOW + 1000, confirmShare: true, confirmSameDay: true });
  assert.deepEqual(saved, { status: "saved", reason: "", checkin: { timestamp: NOW + 1000, shared: true } });
  const record = (await mock.wellbeingRepo.getRange("a-01")).at(-1);
  const { id, createdAt, updatedAt, ...rest } = record;
  assert.match(id, /^wba_/);
  assert.deepEqual(rest, { astronautId: "a-01", timestamp: NOW + 1000, ...ANSWERS, sharedWithMedical: 1, source: "manual", createdBy: "u-haddad" });
  const event = (await mock.eventsRepo.getRange({ astronautId: "a-01", types: "checkin_completed", limit: 1 }))[0];
  assert.deepEqual(
    { type: event.type, astronautId: event.astronautId, actorUserId: event.actorUserId, refStore: event.refStore, refId: event.refId, summary: event.summary, data: event.data },
    { type: "checkin_completed", astronautId: "a-01", actorUserId: "u-haddad", refStore: "wellbeingAssessments", refId: id, summary: "Check-in completed (shared with the Medical Officer)", data: { shared: 1 } }
  );
  assert.doesNotMatch(JSON.stringify({ s: event.summary, d: event.data }), /mood|stress|sleep|fatigue|isolation|wellbeing|\d+\s*\/\s*\d+/i, "no scores in the event");
  // Private check-in: no share confirmation needed; event says private.
  const priv = await s.createCheckin(HADDAD, { ...ANSWERS, share: false }, { now: NOW + 2000, confirmSameDay: true });
  assert.equal(priv.status, "saved");
  const pe = (await mock.eventsRepo.getRange({ astronautId: "a-01", types: "checkin_completed", limit: 1 }))[0];
  assert.deepEqual({ summary: pe.summary, data: pe.data }, { summary: "Check-in completed (private)", data: { shared: 0 } });
  // The officer sees the shared one, not the private one.
  const officer = await service().service.getCrewMemberSharedWellbeing(MO, "AH-01", { now: NOW + 3000 });
  assert.equal(officer.checkins.items[0].timestamp, NOW + 1000);
  assert.ok(!officer.checkins.items.some((c) => c.timestamp === NOW + 2000));
});

test("34. a failed second write rolls back the first (no partial save, no success)", async () => {
  await reset();
  const beforeRecords = await countRecords("a-01");
  const beforeEvents = await countEvents("a-01");
  const failingEvents = { ...mock.eventsRepo, add: async () => { throw new Error("event write failed"); } };
  const { service: s } = service({ eventsRepo: failingEvents });
  const r = await s.createCheckin(HADDAD, { ...ANSWERS, share: false }, { now: NOW + 1000, confirmSameDay: true });
  assert.deepEqual(r, { status: "unavailable", reason: "database_error" });
  assert.equal(await countRecords("a-01"), beforeRecords, "assessment rolled back");
  assert.equal(await countEvents("a-01"), beforeEvents);
  // Lock released after failure: the next (working) attempt saves.
  const ok = await service().service.createCheckin(HADDAD, { ...ANSWERS, share: false }, { now: NOW + 2000, confirmSameDay: true });
  assert.equal(ok.status, "saved");
});

test("35–37. concurrent saves are blocked per astronaut, other astronauts aren't, and the lock is released", async () => {
  await reset();
  let release;
  const gate = new Promise((r) => { release = r; });
  const slowWellbeing = { ...mock.wellbeingRepo, getLatest: async (aid) => { await gate; return mock.wellbeingRepo.getLatest(aid); } };
  const { service: s } = service({ wellbeingRepo: slowWellbeing });
  const before = await countRecords("a-01");
  const p1 = s.createCheckin(HADDAD, { ...ANSWERS, share: false }, { now: NOW + 1000, confirmSameDay: true });
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  const second = await s.createCheckin(HADDAD, { ...ANSWERS, share: false }, { now: NOW + 1001, confirmSameDay: true });
  assert.deepEqual(second, { status: "busy", reason: "save_in_progress" });
  const otherP = s.createCheckin(CHEN, { ...ANSWERS, share: false }, { now: NOW + 1002, confirmSameDay: true });
  release();
  const [first, other] = await Promise.all([p1, otherP]);
  assert.equal(first.status, "saved");
  assert.equal(other.status, "saved", "Chen wasn't blocked by Haddad's lock");
  assert.equal(await countRecords("a-01"), before + 1, "exactly one record from the double submit");
  const third = await s.createCheckin(HADDAD, { ...ANSWERS, share: false }, { now: NOW + 3000, confirmSameDay: true });
  assert.equal(third.status, "saved", "lock released after success");
});

test("38. a second check-in on the same UTC day needs explicit confirmation, every time", async () => {
  await reset(); // seed: today's 08:00 check-in exists
  const { service: s } = service();
  const r1 = await s.createCheckin(HADDAD, { ...ANSWERS, share: false }, { now: NOW });
  assert.equal(r1.status, "confirm_same_day");
  assert.equal(r1.existingAt, Date.UTC(2026, 10, 14, 8, 0));
  const r2 = await s.createCheckin(HADDAD, { ...ANSWERS, share: false }, { now: NOW, confirmSameDay: true });
  assert.equal(r2.status, "saved");
  const r3 = await s.createCheckin(HADDAD, { ...ANSWERS, share: false }, { now: NOW + 1 });
  assert.equal(r3.status, "confirm_same_day", "confirmation isn't remembered between attempts");
  // Before today's first check-in, no confirmation is needed.
  const early = Date.UTC(2026, 10, 14, 7, 0);
  await mock.resetMock({ now: early });
  const r4 = await service().service.createCheckin(HADDAD, { ...ANSWERS, share: false }, { now: early });
  assert.equal(r4.status, "saved");
  await reset();
});

test("40. inputs are not mutated", async () => {
  await reset();
  const answers = Object.freeze({ ...ANSWERS, share: false });
  const options = Object.freeze({ now: NOW + 5, confirmSameDay: true });
  const r = await service().service.createCheckin(Object.freeze({ ...HADDAD }), answers, options);
  assert.equal(r.status, "saved");
  assert.deepEqual(answers, { ...ANSWERS, share: false });
});

test("forbidden sessions can't write", async () => {
  await reset();
  for (const s of [null, MO, { ...HADDAD, astronautId: "a-03" }, { ...HADDAD, userId: "u-chen" }]) {
    const { service: w, calls } = service();
    const r = await w.createCheckin(s, { ...ANSWERS, share: false }, { now: NOW, confirmSameDay: true });
    assert.equal(r.status, "forbidden", JSON.stringify(s));
    assert.ok(!calls.some((c) => c.method === "add"));
  }
});

test("54 + regression guards: DB_VERSION is 1; services import only the public DB index and sibling services", async () => {
  const { DB_VERSION } = await import("../../js/core/config.js");
  assert.equal(DB_VERSION, 1);
  for (const f of readdirSync(join(ROOT, "js/services"))) {
    const imports = [...read(`js/services/${f}`).matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    // Sprint 7: a service may also import the pure scenario catalog in js/simulation/.
    // Sprint 8: …and the pure risk engine modules in js/engine/.
    const PURE = ["../simulation/scenarios.js", "../engine/risk-engine.js", "../engine/rules/physical-rules.js"];
    for (const p of imports) assert.ok(p === "../db/index.js" || /^\.\/[a-z-]+\.js$/.test(p) || PURE.includes(p), `${f}: ${p}`);
  }
});
