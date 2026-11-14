// tests/unit/alerts-service.test.mjs — Sprint 8 role-scoped alerts: list, detail by
// public number, acknowledge / resolve lifecycle, rollback, privacy.
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

const svc = await import("../../js/services/alerts-service.js");
const mock = await import("../../js/db/mock-repositories.js");
const { DatabaseError } = await import("../../js/db/index.js");

const NOW = Date.UTC(2026, 10, 14, 15, 30);
const DAY = 86400e3;
const MO = Object.freeze({ role: "medical_officer", userId: "u-medofficer", astronautId: "" });
const MO2 = Object.freeze({ role: "medical_officer", userId: "u-medbackup", astronautId: "" });
const HADDAD = Object.freeze({ role: "astronaut", userId: "u-haddad", astronautId: "a-01" });
const CHEN = Object.freeze({ role: "astronaut", userId: "u-chen", astronautId: "a-03" });
const REYES = Object.freeze({ role: "astronaut", userId: "u-reyes", astronautId: "a-04" });

const baseRepos = () => ({ usersRepo: mock.usersRepo, astronautsRepo: mock.astronautsRepo, alertsRepo: mock.alertsRepo, alertActionsRepo: mock.alertActionsRepo, eventsRepo: mock.eventsRepo });
function spy(rs) {
  const calls = [];
  const wrapped = {};
  for (const [name, repo] of Object.entries(rs)) wrapped[name] = new Proxy(repo, { get(t, p) { const v = t[p]; return typeof v !== "function" ? v : (...a) => { calls.push({ repo: name, method: String(p), args: a }); return v.apply(t, a); }; } });
  return { repos: wrapped, calls };
}
function serialTx() {
  let tail = Promise.resolve();
  const stores = [];
  const run = (names, mode, work) => { stores.push([...names]); const next = tail.then(() => mock.withTransaction(names, mode, work)); tail = next.catch(() => {}); return next; };
  return { run, stores };
}
function service(overrides = {}, tx = serialTx()) {
  const s = spy({ ...baseRepos(), ...overrides });
  return { ...s, tx, service: svc.createAlertsService({ repos: s.repos, withTransaction: tx.run }) };
}
const reset = () => mock.resetMock({ now: NOW });
const byNumber = async (n) => (await mock.alertsRepo.query({})).find((a) => a.number === n);
const snapshot = async () => JSON.stringify({ alerts: await mock.alertsRepo.query({}), actions: await Promise.all((await mock.alertsRepo.query({})).map((a) => mock.alertActionsRepo.getByAlert(a.id))), events: await mock.eventsRepo.getRange({}) });
const IDS = /"(a-0\d|u-[a-z]+|alr_[^"]*|msr_[^"]*|act_[^"]*|evt_[^"]*|wba_[^"]*)"|astronautId|acknowledgedBy":"u|measurementId|dedupeKey/;

test("authorization first: malformed sessions are refused before any alert read", async () => {
  await reset();
  for (const session of [null, { role: "astronaut", userId: "u-haddad", astronautId: "a-03" }, { role: "medical_officer", userId: "u-haddad", astronautId: "" }, { role: "admin", userId: "u-medofficer" }]) {
    const { service: s, calls } = service();
    for (const r of [await s.listAlerts(session, {}, { now: NOW }), await s.getAlertDetail(session, "ALT-0190", { now: NOW }), await s.acknowledgeAlert(session, "ALT-0189", {}, { now: NOW }), await s.resolveAlert(session, "ALT-0190", { note: "x" }, { now: NOW })]) {
      assert.equal(r.status, "forbidden", JSON.stringify(session));
    }
    assert.ok(!calls.some((c) => c.repo === "alertsRepo"), "no alert reads");
  }
});

test("astronaut list: own open alerts + own alerts resolved in the last 30 days; read-only; no ids", async () => {
  await reset();
  const { service: s } = service();
  const reyes = await s.listAlerts(REYES, { crewId: "AH-01", status: "all" }, { now: NOW });
  assert.equal(reyes.viewer, "astronaut");
  assert.deepEqual(reyes.items.map((a) => a.number), ["ALT-0190"], "filters can't widen the astronaut's scope");
  const haddad = await s.listAlerts(HADDAD, {}, { now: NOW });
  assert.deepEqual(haddad.items.map((a) => [a.number, a.status]), [["ALT-0181", "resolved"]], "resolved within 30 days");
  const later = await s.listAlerts(HADDAD, {}, { now: NOW + 40 * DAY });
  assert.deepEqual(later.items, [], "resolved more than 30 days ago is not listed");
  assert.ok(!IDS.test(JSON.stringify(reyes)), JSON.stringify(reyes).match(IDS)?.[0]);
});

test("officer list: crew-wide, filters validated, crew resolved after verification, critical first", async () => {
  await reset();
  const { service: s } = service();
  const open = await s.listAlerts(MO, {}, { now: NOW });
  assert.deepEqual(open.items.map((a) => [a.number, a.crewId]), [["ALT-0190", "AH-04"], ["ALT-0189", "AH-03"]]);
  assert.deepEqual(open.filters, { status: "open", severity: "all", crewId: "" });
  assert.deepEqual(open.crew.map((c) => c.crewId), ["AH-01", "AH-02", "AH-03", "AH-04"]);
  assert.deepEqual((await s.listAlerts(MO, { status: "all" }, { now: NOW })).items.map((a) => a.number).sort(), ["ALT-0181", "ALT-0184", "ALT-0189", "ALT-0190"]);
  assert.deepEqual((await s.listAlerts(MO, { status: "resolved", severity: "warning" }, { now: NOW })).items.map((a) => a.number).sort(), ["ALT-0181", "ALT-0184"]);
  assert.deepEqual((await s.listAlerts(MO, { status: "all", crewId: "AH-03" }, { now: NOW })).items.map((a) => a.number), ["ALT-0189"]);
  assert.equal((await s.listAlerts(MO, { status: "bogus" }, { now: NOW })).reason, "invalid_filter");
  assert.equal((await s.listAlerts(MO, { severity: "high" }, { now: NOW })).reason, "invalid_filter");
  assert.equal((await s.listAlerts(MO, { crewId: "a-03" }, { now: NOW })).reason, "invalid_crew_id");
  assert.equal((await s.listAlerts(MO, { crewId: "AH-77" }, { now: NOW })).reason, "unknown_crew_id");
  assert.ok(!IDS.test(JSON.stringify(open)));
});

test("detail by public number: evidence without ids, rule snapshot, audit trail with names; other astronaut → not found", async () => {
  await reset();
  const { service: s } = service();
  const d = await s.getAlertDetail(MO, "ALT-0190", { now: NOW });
  assert.equal(d.status, "ready");
  const a = d.alert;
  assert.deepEqual([a.number, a.crewId, a.severity, a.status, a.rule.id, a.rule.version], ["ALT-0190", "AH-04", "warning", "acknowledged", "PHY-05", null], "historical PHY snapshot readable unchanged");
  assert.equal(a.evidence.length, 3);
  // Seeded (pre-Sprint 8) evidence never recorded source/quality: shown as "not recorded", never guessed.
  assert.ok(a.evidence.every((e) => e.unit === "h" && e.source === "not_recorded" && e.quality === "not_recorded" && !("measurementId" in e)));
  assert.equal(a.acknowledgedBy, "Dr. Lena Ortiz");
  assert.deepEqual(d.timeline.items.map((x) => [x.label, x.by]), [["Created", "System"], ["Acknowledged", "Dr. Lena Ortiz"]]);
  assert.deepEqual(d.actions, { canAcknowledge: false, canResolve: true, needsConfirmation: true });
  assert.equal(d.thresholdLabel, "Demonstration threshold — not clinically validated.");
  assert.ok(!IDS.test(JSON.stringify(d)), JSON.stringify(d).match(IDS)?.[0]);
  // Astronauts: own → read-only detail; other's / unknown / malformed → the same not found.
  const own = await s.getAlertDetail(REYES, "ALT-0190", { now: NOW });
  assert.deepEqual([own.status, own.viewer, own.actions.canResolve, own.actions.canAcknowledge], ["ready", "astronaut", false, false]);
  for (const n of ["ALT-0189", "ALT-9999", "alt-0190", "ALT-01", "0190", undefined]) {
    const r = await s.getAlertDetail(REYES, n, { now: NOW });
    assert.deepEqual([r.status, r.reason], ["not_found", "unknown_alert"], String(n));
  }
});

test("seeded WB-01 stays readable (no score values) and actionable", async () => {
  await reset();
  const { service: s } = service();
  const d = await s.getAlertDetail(MO, "ALT-0189", { now: NOW });
  assert.equal(d.alert.category, "wellbeing");
  assert.ok(d.alert.evidence.length > 0 && d.alert.evidence.every((e) => e.value === null && e.valueHidden === true));
  assert.equal((await s.acknowledgeAlert(MO, "ALT-0189", {}, { now: NOW + 1 })).status, "acknowledged");
  assert.equal((await s.resolveAlert(MO, "ALT-0189", { note: "Supportive conversation held.", confirmConditionPresent: true }, { now: NOW + 2 })).status, "resolved");
});

test("acknowledge: new → acknowledged atomically (alert + action + event); repeat unchanged; astronauts can't", async () => {
  await reset();
  const { service: s, tx } = service();
  assert.equal((await s.acknowledgeAlert(CHEN, "ALT-0189", {}, { now: NOW + 1 })).reason, "not_medical_officer");
  const r = await s.acknowledgeAlert(MO, "ALT-0189", { note: "  Seen.  " }, { now: NOW + 1000 });
  assert.deepEqual([r.status, r.alertStatus], ["acknowledged", "acknowledged"]);
  assert.deepEqual(tx.stores, [["alerts", "alertActions", "missionEvents"]]);
  const a = await byNumber("ALT-0189");
  assert.deepEqual([a.status, a.acknowledgedAt, a.acknowledgedBy], ["acknowledged", NOW + 1000, "u-medofficer"]);
  const acts = await mock.alertActionsRepo.getByAlert(a.id);
  assert.deepEqual(acts.map((x) => [x.action, x.userId, x.note]).at(-1), ["acknowledged", "u-medofficer", "Seen."]);
  assert.ok((await mock.eventsRepo.getRange({ astronautId: "a-03", types: "alert_acknowledged" })).some((e) => e.refId === a.id));
  const before = await snapshot();
  assert.equal((await s.acknowledgeAlert(MO2, "ALT-0189", {}, { now: NOW + 2000 })).status, "unchanged");
  assert.equal((await s.acknowledgeAlert(MO, "ALT-0181", {}, { now: NOW + 2000 })).reason, "invalid_transition", "resolved can't be acknowledged");
  assert.equal(await snapshot(), before);
});

test("resolve: only from acknowledged; trimmed note 1…500; confirmation when the condition is still present; repeat unchanged", async () => {
  await reset();
  const { service: s } = service();
  assert.equal((await s.resolveAlert(MO, "ALT-0189", { note: "x" }, { now: NOW })).reason, "not_acknowledged");
  assert.equal((await s.resolveAlert(MO, "ALT-0190", { note: "   " }, { now: NOW })).reason, "note_required");
  assert.equal((await s.resolveAlert(MO, "ALT-0190", {}, { now: NOW })).reason, "note_required");
  assert.equal((await s.resolveAlert(MO, "ALT-0190", { note: "x".repeat(501) }, { now: NOW })).reason, "note_too_long");
  assert.equal((await s.resolveAlert(MO, "ALT-0190", { note: 5 }, { now: NOW })).reason, "invalid_note");
  const before = await snapshot();
  const needs = await s.resolveAlert(MO, "ALT-0190", { note: "Rest period scheduled." }, { now: NOW });
  assert.deepEqual([needs.status, needs.reason], ["confirm_required", "condition_present"]);
  assert.equal((await s.resolveAlert(MO, "ALT-0190", { note: "x", confirmConditionPresent: "yes" }, { now: NOW })).status, "confirm_required");
  assert.equal(await snapshot(), before, "nothing written without confirmation");
  const ok = await s.resolveAlert(MO, "ALT-0190", { note: " Rest period scheduled. ", confirmConditionPresent: true }, { now: NOW + 5 });
  assert.equal(ok.status, "resolved");
  const a = await byNumber("ALT-0190");
  assert.deepEqual([a.status, a.resolvedAt, a.resolvedBy, a.resolutionNote], ["resolved", NOW + 5, "u-medofficer", "Rest period scheduled."]);
  assert.equal((await mock.alertActionsRepo.getByAlert(a.id)).at(-1).action, "resolved");
  assert.equal((await s.resolveAlert(MO, "ALT-0190", { note: "again" }, { now: NOW + 6 })).status, "unchanged");
  assert.equal((await s.acknowledgeAlert(MO, "ALT-0190", {}, { now: NOW + 7 })).reason, "invalid_transition");
  assert.equal(JSON.stringify((await s.getAlertDetail(MO, "ALT-0190", { now: NOW + 8 })).actions), JSON.stringify({ canAcknowledge: false, canResolve: false, needsConfirmation: false }));
  assert.equal(note500().length, 500);
  assert.equal((await s.acknowledgeAlert(MO, "ALT-0189", { note: note500() }, { now: NOW + 9 })).status, "acknowledged", "500 characters allowed");
});
const note500 = () => "n".repeat(500);

test("rollback: a failed action or event write leaves the alert unchanged (acknowledge and resolve)", async () => {
  const fail = (repo, method) => ({ [repo]: { ...mock[repo], [method]: async () => { throw new DatabaseError("forced", { code: "QUOTA" }); } } });
  for (const [kind, override] of [["ack", fail("alertActionsRepo", "add")], ["ack", fail("eventsRepo", "add")], ["ack", fail("alertsRepo", "update")], ["resolve", fail("alertActionsRepo", "add")], ["resolve", fail("eventsRepo", "add")], ["resolve", fail("alertsRepo", "update")]]) {
    await reset();
    const before = await snapshot();
    const s = service(override).service;
    const r = kind === "ack" ? await s.acknowledgeAlert(MO, "ALT-0189", {}, { now: NOW }) : await s.resolveAlert(MO, "ALT-0190", { note: "x", confirmConditionPresent: true }, { now: NOW });
    assert.deepEqual([r.status, r.reason], ["unavailable", "database_error"], kind);
    assert.equal(await snapshot(), before, `${kind}: nothing written`);
  }
});

test("two tabs acknowledging at once: one acknowledgement, one 'unchanged' (no duplicate audit record)", async () => {
  await reset();
  const tx = serialTx();
  const t1 = svc.createAlertsService({ repos: baseRepos(), withTransaction: tx.run });
  const t2 = svc.createAlertsService({ repos: baseRepos(), withTransaction: tx.run });
  const res = await Promise.all([t1.acknowledgeAlert(MO, "ALT-0189", {}, { now: NOW }), t2.acknowledgeAlert(MO2, "ALT-0189", {}, { now: NOW })]);
  assert.deepEqual(res.map((r) => r.status).sort(), ["acknowledged", "unchanged"]);
  const a = await byNumber("ALT-0189");
  assert.equal((await mock.alertActionsRepo.getByAlert(a.id)).filter((x) => x.action === "acknowledged").length, 1);
  const [x, y] = await Promise.all([t1.acknowledgeAlert(MO, "ALT-0189", {}, { now: NOW }), t1.acknowledgeAlert(MO, "ALT-0189", {}, { now: NOW })]);
  assert.ok([x.status, y.status].includes("busy") || [x.status, y.status].every((s) => s === "unchanged"));
});

test("privacy + structure: no journal / wellbeing / message / password access; imports limited", () => {
  const src = code("js/services/alerts-service.js");
  for (const bad of ["journalRepo", "wellbeingRepo", "messagesRepo", "passwordHash", "salt", "measurementsRepo", "settingsRepo"]) assert.ok(!src.includes(bad), bad);
  const imports = [...readFileSync(join(ROOT, "js/services/alerts-service.js"), "utf8").matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["../db/index.js", "./access-control.js", "./crew-monitor-service.js", "../engine/rules/physical-rules.js"]);
});

// =====================================================================================
// Medical Officer lifecycle notes are internal: astronauts never receive them
// =====================================================================================

const NOTE_KEYS = /"(resolutionNote|note|notes|acknowledgementNote|acknowledgeNote)"\s*:/;

test("note privacy: astronaut list/detail/evidence/timeline omit every lifecycle note key and text; the officer still gets them", async () => {
  await reset();
  const riskSvc = await import("../../js/services/risk-service.js");
  const repos = { ...baseRepos(), measurementsRepo: mock.measurementsRepo, settingsRepo: mock.settingsRepo };
  const risk = riskSvc.createRiskService({ repos, withTransaction: mock.withTransaction });
  const s = service().service;
  // A generated alert for Chen (two low SpO₂ readings), acknowledged + resolved with notes.
  for (const [v, k] of [[93, 2], [92, 1]]) await mock.measurementsRepo.add({ astronautId: "a-03", metric: "spo2", value: v, unit: "%", timestamp: NOW + 1000 - k, source: "simulation", quality: "ok" });
  const ev = await risk.evaluateAstronaut(MO, "AH-03", { now: NOW + 2000 });
  const gen = ev.rules.find((r) => r.ruleId === "PHY-02").alertNumber;
  const ACK = "MO-ONLY acknowledgement text 7731";
  const RES = "MO-ONLY resolution text 9912";
  assert.equal((await s.acknowledgeAlert(MO, gen, { note: ACK }, { now: NOW + 3000 })).status, "acknowledged");
  assert.equal((await s.resolveAlert(MO, gen, { note: RES, confirmConditionPresent: true }, { now: NOW + 4000 })).status, "resolved");
  // Seeded alert with notes too (Chen's ALT-0189).
  const SEED_RES = "MO-ONLY seeded-alert note 4410";
  await s.acknowledgeAlert(MO, "ALT-0189", { note: "MO-ONLY ack 2" }, { now: NOW + 5000 });
  await s.resolveAlert(MO, "ALT-0189", { note: SEED_RES, confirmConditionPresent: true }, { now: NOW + 6000 });

  const secrets = [ACK, RES, SEED_RES, "MO-ONLY", "Readings returned toward the stored baseline", "exercise session"];
  const astronautOutputs = [
    await s.listAlerts(CHEN, {}, { now: NOW + 7000 }),
    await s.listAlerts(CHEN, { status: "all" }, { now: NOW + 7000 }),
    await s.getAlertDetail(CHEN, gen, { now: NOW + 7000 }),
    await s.getAlertDetail(CHEN, "ALT-0189", { now: NOW + 7000 }),
    await s.getAlertDetail(HADDAD, "ALT-0181", { now: NOW + 7000 }), // seeded, resolved with a note
    await s.listAlerts(HADDAD, {}, { now: NOW + 7000 }),
  ];
  for (const out of astronautOutputs) {
    assert.equal(out.status, "ready");
    const json = JSON.stringify(out);
    assert.ok(!NOTE_KEYS.test(json), `note key leaked: ${json.match(NOTE_KEYS)?.[0]}`);
    for (const t of secrets) assert.ok(!json.includes(t), `note text leaked: ${t}`);
    assert.ok(!IDS.test(json), `id leaked: ${json.match(IDS)?.[0]}`);
  }
  // The astronaut still sees the lifecycle: status, labels, timestamps.
  const d = astronautOutputs[2];
  assert.equal(d.alert.status, "resolved");
  assert.ok(d.alert.resolvedAt > 0 && d.alert.acknowledgedAt > 0);
  assert.ok(!("resolutionNote" in d.alert));
  assert.deepEqual(d.timeline.items.map((x) => x.label), ["Created", "Acknowledged", "Resolved"]);
  assert.ok(d.timeline.items.every((x) => !("note" in x) && x.timestamp > 0));

  // The Medical Officer still receives the permitted notes (no ids).
  const mo = await s.getAlertDetail(MO, gen, { now: NOW + 7000 });
  assert.equal(mo.alert.resolutionNote, RES);
  assert.deepEqual(mo.timeline.items.filter((x) => x.note).map((x) => [x.label, x.note]), [["Acknowledged", ACK], ["Resolved", RES]]);
  assert.equal((await s.getAlertDetail(MO, "ALT-0181", { now: NOW })).alert.resolutionNote, "Readings returned toward the stored baseline after rest. Demo alert closed.");
  assert.ok(!IDS.test(JSON.stringify(mo)));

  // Stored records are unchanged by the presentation policy.
  const stored = await byNumber(gen);
  assert.equal(stored.resolutionNote, RES);
  assert.equal((await mock.alertActionsRepo.getByAlert(stored.id)).find((x) => x.action === "acknowledged").note, ACK);
});
