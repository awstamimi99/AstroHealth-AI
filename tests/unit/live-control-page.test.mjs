// tests/unit/live-control-page.test.mjs — the "Live control" tab of #/simulation
// (js/components/live-control-view.js, js/components/live-chart.js) on the
// shared fake DOM, and the live refresh of every screen that shows readings or
// alerts (overview, physical, history, alerts, crew monitor, officer overview,
// top-bar badge). Real services run over the seeded mock with a test clock.
// Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { FakeElement, all, byId } from "./fake-dom.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const code = (p) => read(p).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

const view = await import("../../js/components/live-control-view.js");
const chartMod = await import("../../js/components/live-chart.js");
const simSvc = await import("../../js/services/simulation-service.js");
const liveSvc = await import("../../js/services/live-control-service.js");
const mock = await import("../../js/db/mock-repositories.js");

const NOW = Date.UTC(2026, 10, 14, 15, 30);
const SEC = 1000;
const MO = Object.freeze({ role: "medical_officer", userId: "u-medofficer", astronautId: "", displayName: "Dr. Lena Ortiz" });
const REYES = Object.freeze({ role: "astronaut", userId: "u-reyes", astronautId: "a-04", displayName: "Jonas Reyes" });
const LEAKS = /\ba-0\d\b|\bu-[a-z]+\b|msr_|evt_|alr_|sim_[0-9a-f]/;
const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0)); };
const dump = (n) => (n instanceof FakeElement ? [...n.attributes.values()].join(" ") + " " + n.childNodes.map(dump).join(" ") : n.textContent);
const repos = () => Object.fromEntries(Object.entries(mock).filter(([k]) => k.endsWith("Repo")));

function harness({ session = MO } = {}) {
  const clock = { now: NOW };
  const sim = simSvc.createSimulationService({ repos: repos(), withTransaction: mock.withTransaction });
  const live = liveSvc.createLiveControlService({ repos: repos() });
  const sent = [];
  const service = {
    recordManualReading: (s, i) => { sent.push(["record", i]); clock.now += SEC; return sim.recordManualReading(s, i, { now: clock.now }); },
    startCustomCurve: (s, i) => { sent.push(["curve", i]); clock.now += SEC; return sim.startCustomCurve(s, i, { now: clock.now }); },
  };
  const announced = [];
  const host = { getRun: () => null, lastRisk: () => null, announce: (t) => announced.push(t), control: async () => {}, adoptRun: async () => {} };
  const resets = [];
  const reset = { resetDemoData: async (s, i) => { resets.push(i); return { status: "reset" }; } };
  let notified = 0;
  const c = view.createLiveControl({ session, service, live: { getLiveControl: (s, i) => live.getLiveControl(s, i, { now: clock.now }) }, reset, notifyReset: () => { notified += 1; }, host });
  return { c, node: c.node, sent, announced, resets, notified: () => notified, clock };
}
async function choose(h, crewId) {
  const sel = byId(h.node, "live-crew");
  sel.setAttribute("value", crewId);
  sel.dispatch("change");
  await flush();
}
const isDisabled = (e) => e.disabled === true || e.hasAttribute("disabled");
const applyButtons = (root) => all(root, (e) => e.hasAttribute("data-live-apply"));
const card = (root, id) => all(root, (e) => e.getAttribute("data-live-card") === id)[0];

// =====================================================================================
// Live control view
// =====================================================================================

test("live control: nothing is editable until a crew member is chosen; the picker lists everyone with status", async () => {
  await mock.resetMock({ now: NOW });
  const h = harness();
  await h.c.load();
  await flush();
  assert.equal(applyButtons(h.node).length, 0, "no Apply button without a selection");
  assert.ok(all(h.node, (e) => e.hasAttribute("data-live-empty")).length === 1);
  const options = all(byId(h.node, "live-crew"), (e) => e.tagName === "OPTION").map((o) => o.textContent);
  assert.equal(options[0], "Choose a crew member…", "no default selection");
  assert.equal(options.length, 5);
  assert.match(options[4], /^Jonas Reyes · AH-04 · Payload Specialist · /);
  assert.equal(all(h.node, (e) => e.hasAttribute("data-live-chip")).length, 4, "crew overview strip: one chip per member");
  assert.match(h.node.textContent, /Synthetic demonstration data/);
  assert.match(h.node.textContent, /not a medical device|not clinically validated|demonstration/i);
  assert.doesNotMatch(dump(h.node), LEAKS);
});

test("live control: the selected member is obvious — header, charts and buttons name them; rule limits come from the service", async () => {
  await mock.resetMock({ now: NOW });
  const h = harness();
  await h.c.load();
  await flush();
  await choose(h, "AH-04");
  assert.equal(byId(h.node, "live-editing-title").textContent, "Editing: Jonas Reyes · AH-04");
  const buttons = applyButtons(h.node);
  assert.ok(buttons.length >= 4);
  for (const b of buttons) assert.equal(b.textContent, "Apply to Jonas Reyes");
  const spo2 = card(h.node, "spo2");
  assert.match(spo2.textContent, /SpO₂ · Jonas Reyes/);
  assert.match(spo2.textContent, /Synthetic demonstration data/);
  assert.equal(all(spo2, (e) => e.hasAttribute("data-live-rule"))[0].getAttribute("data-live-rule"), "PHY-02");
  assert.match(card(h.node, "fatigue").textContent, /No demonstration rule reads fatigue/);
  assert.equal(all(h.node, (e) => e.getAttribute("data-live-chip") === "AH-04")[0].getAttribute("aria-pressed"), "true");
  assert.doesNotMatch(dump(h.node), LEAKS);
});

test("live control: Apply sends only the crew ID, metric and a clamped value; the result names who was updated", async () => {
  await mock.resetMock({ now: NOW });
  const h = harness();
  await h.c.load();
  await flush();
  await choose(h, "AH-04");
  const input = byId(h.node, "live-input-spo2");
  input.setAttribute("value", "12");
  input.dispatch("change");
  assert.equal(input.value, "70", "clamped to the input minimum");
  byId(h.node, "live-apply-spo2").click();
  await flush();
  assert.deepEqual(h.sent, [["record", { crewId: "AH-04", metric: "spo2", value: 70 }]], "no astronaut or user ids sent");
  assert.equal((await mock.astronautsRepo.getById("a-04")).latest.spo2.value, 70);
  assert.match(h.announced.at(-1), /^Saved for Jonas Reyes \(AH-04\): SpO₂ 70/);
  assert.ok(all(h.node, (e) => e.getAttribute("data-live-result") === "spo2").length === 1, "inline risk result panel");
});

test("live control: blood pressure is applied as one pair", async () => {
  await mock.resetMock({ now: NOW });
  const h = harness();
  await h.c.load();
  await flush();
  await choose(h, "AH-02");
  for (const [id, v] of [["live-input-bpSystolic", "150"], ["live-input-bpDiastolic", "95"]]) {
    const n = byId(h.node, id);
    n.setAttribute("value", v);
    n.dispatch("change");
  }
  byId(h.node, "live-apply-bloodPressure").click();
  await flush();
  assert.deepEqual(h.sent, [["record", { crewId: "AH-02", metric: "bpSystolic", value: 150, diastolic: 95 }]]);
});

test("live control: switching member discards unsaved values with a notice and reloads that member's charts", async () => {
  await mock.resetMock({ now: NOW });
  const h = harness();
  await h.c.load();
  await flush();
  await choose(h, "AH-04");
  const input = byId(h.node, "live-input-heartRate");
  input.setAttribute("value", "180");
  input.dispatch("change");
  assert.equal(h.c.hasUnsaved(), true);
  all(h.node, (e) => e.getAttribute("data-live-chip") === "AH-03")[0].click();
  await flush();
  assert.equal(h.c.selectedCrewId(), "AH-03");
  assert.equal(h.c.hasUnsaved(), false);
  assert.match(all(h.node, (e) => e.hasAttribute("data-live-notice"))[0].textContent, /Unsaved values for Jonas Reyes \(AH-04\) were discarded\. Nothing was written for them\./);
  assert.equal(byId(h.node, "live-editing-title").textContent, "Editing: Mei Chen · AH-03");
  const chen = await mock.astronautsRepo.getById("a-03");
  assert.equal(Number(byId(h.node, "live-input-heartRate").value), chen.latest.heartRate.value, "Chen's own value, not the draft");
  assert.deepEqual(h.sent, [], "nothing written");
});

test("live control: a curve needs the confirmation; Play sends the drawn points for the selected member", async () => {
  await mock.resetMock({ now: NOW });
  const adopted = [];
  const sim = simSvc.createSimulationService({ repos: repos(), withTransaction: mock.withTransaction });
  const live = liveSvc.createLiveControlService({ repos: repos() });
  const sent = [];
  const c = view.createLiveControl({
    session: MO,
    service: { recordManualReading: async () => ({ status: "invalid" }), startCustomCurve: (s, i) => { sent.push(i); return sim.startCustomCurve(s, i, { now: NOW + SEC }); } },
    live: { getLiveControl: (s, i) => live.getLiveControl(s, i, { now: NOW }) },
    reset: { resetDemoData: async () => ({ status: "reset" }) },
    notifyReset: () => {},
    host: { getRun: () => null, lastRisk: () => null, announce: () => {}, control: async () => {}, adoptRun: async (ref) => { adopted.push(ref); } },
  });
  await c.load();
  await flush();
  const sel = byId(c.node, "live-crew");
  sel.setAttribute("value", "AH-04");
  sel.dispatch("change");
  await flush();
  byId(c.node, "live-curve-spo2").click();
  await flush();
  const play = byId(c.node, "live-play-spo2");
  assert.equal(isDisabled(play), true, "Play is disabled until confirmed");
  assert.equal(play.textContent, "Play curve for Jonas Reyes");
  const confirm = byId(c.node, "live-curve-confirm-spo2");
  confirm.checked = true;
  confirm.dispatch("change");
  await flush();
  byId(c.node, "live-play-spo2").click();
  await flush();
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0]).sort(), ["confirm", "crewId", "metric", "speed", "values"]);
  assert.deepEqual([sent[0].crewId, sent[0].metric, sent[0].values.length, sent[0].confirm], ["AH-04", "spo2", 8, true]);
  assert.equal(adopted.length, 1, "the Simulation Center timer takes over the run");
});

test("live control: Reset demo data keeps its typed confirmation", async () => {
  await mock.resetMock({ now: NOW });
  const h = harness();
  await h.c.load();
  await flush();
  assert.equal(isDisabled(byId(h.node, "live-reset")), true);
  const phrase = byId(h.node, "live-reset-phrase");
  phrase.dispatch("input", { target: { value: "reset demo" } });
  assert.equal(byId(h.node, "live-reset").disabled, true, "wrong case is refused");
  phrase.dispatch("input", { target: { value: view.RESET_PHRASE } });
  assert.equal(byId(h.node, "live-reset").disabled, false);
  byId(h.node, "live-reset").click();
  await flush();
  assert.deepEqual(h.resets, [{ confirmation: view.RESET_PHRASE }]);
  assert.equal(h.notified(), 1);
});

test("live control: an astronaut session gets the role refusal, never crew data", async () => {
  await mock.resetMock({ now: NOW });
  const h = harness({ session: REYES });
  await h.c.load();
  await flush();
  assert.match(h.node.textContent, /Live control is for the Medical Officer role only\./);
  assert.equal(byId(h.node, "live-crew"), undefined);
});

test("live chart: keyboard steps (arrows ±1, Shift ±5, Page ±10, Home/End) and clamping are pure and bounded", () => {
  const r = { min: 70, max: 100, step: 1 };
  assert.equal(chartMod.keyStep("ArrowUp", false, 90, r), 91);
  assert.equal(chartMod.keyStep("ArrowDown", true, 90, r), 85);
  assert.equal(chartMod.keyStep("PageUp", false, 95, r), 100, "clamped");
  assert.equal(chartMod.keyStep("Home", false, 90, r), 70);
  assert.equal(chartMod.keyStep("End", false, 90, r), 100);
  assert.equal(chartMod.keyStep("a", false, 90, r), null);
  assert.equal(chartMod.snapValue(7.26, { min: 0, max: 14, step: 0.1 }), 7.3);
  assert.equal(chartMod.snapValue(Number.NaN, r), 70);
});

test("structure: no js/db import, no innerHTML, writes only through the passed-in service", () => {
  for (const p of ["js/components/live-control-view.js", "js/components/live-chart.js"]) {
    const src = code(p);
    assert.doesNotMatch(src, /from\s+["'][^"']*\/db\//, p);
    assert.doesNotMatch(src, /\.innerHTML\s*=/, p);
    assert.doesNotMatch(src, /\/services\//, `${p} imports no service`);
  }
  const svc = code("js/services/live-control-service.js");
  assert.deepEqual([...svc.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).filter((m) => m.includes("/db/")), ["../db/index.js"]);
  assert.doesNotMatch(svc, /Repo\.(add|update|put|delete)\(/, "the read model never writes");
});

// =====================================================================================
// Live refresh of every screen
// =====================================================================================

const astroOverviewPage = await import("../../js/pages/astronaut-overview.js");
const physicalPage = await import("../../js/pages/physical-health.js");
const historyPage = await import("../../js/pages/history.js");
const alertsPage = await import("../../js/pages/alerts.js");
const crewPage = await import("../../js/pages/crew-monitor.js");
const moPage = await import("../../js/pages/officer-overview.js");
const overviewSvc = await import("../../js/services/astronaut-overview-service.js");
const physSvc = await import("../../js/services/physical-health-service.js");
const historySvc = await import("../../js/services/history-service.js");
const alertsSvc = await import("../../js/services/alerts-service.js");
const crewSvc = await import("../../js/services/crew-monitor-service.js");

function capture() {
  const subs = [];
  return { subs, subscribe: (opts) => { subs.push(opts); return () => {}; } };
}
function counted(fn) {
  const f = async (...a) => { f.calls += 1; return fn(...a); };
  f.calls = 0;
  return f;
}

test("live refresh: each screen subscribes with the navigation signal and reloads on an event", async () => {
  await mock.resetMock({ now: NOW });
  const r = repos();
  const o = { now: NOW };
  const ov = overviewSvc.createAstronautOverviewService({ repos: r });
  const ph = physSvc.createPhysicalHealthService({ repos: r });
  const hi = historySvc.createHistoryService({ repos: r });
  const al = alertsSvc.createAlertsService({ repos: r, withTransaction: mock.withTransaction });
  const cm = crewSvc.createCrewMonitorService({ repos: r });

  const screens = [
    ["astronaut #/overview", REYES, "#/overview", (sub) => { const l = counted((s) => ov.getAstronautOverview(s, o)); return [astroOverviewPage.createOverviewRenderer({ loadOverview: l, subscribe: sub }), l]; }, "AH-04"],
    ["astronaut #/physical", REYES, "#/physical", (sub) => { const l = counted((s) => ph.getOwnPhysicalHealth(s, o)); return [physicalPage.createPhysicalHealthRenderer({ loadOwn: l, loadCrewMember: l, listCrew: l, subscribe: sub }), l]; }, "AH-04"],
    ["astronaut #/history", REYES, "#/history", (sub) => { const l = counted((s, x) => hi.getOwnHistory(s, { ...x, ...o })); return [historyPage.createHistoryRenderer({ service: { getOwnHistory: l, getCrewMemberHistory: l, listCrewForHistorySelection: l }, subscribe: sub }), l]; }, "AH-04"],
    ["astronaut #/alerts", REYES, "#/alerts", (sub) => { const l = counted((s, f) => al.listAlerts(s, f, o)); return [alertsPage.createAlertsRenderer({ service: { listAlerts: l, getAlertDetail: (s, n) => al.getAlertDetail(s, n, o) }, channel: { subscribe: () => () => {}, notify: () => {} }, subscribe: sub }), l]; }, null],
    ["officer #/alerts", MO, "#/alerts", (sub) => { const l = counted((s, f) => al.listAlerts(s, f, o)); return [alertsPage.createAlertsRenderer({ service: { listAlerts: l, getAlertDetail: (s, n) => al.getAlertDetail(s, n, o) }, channel: { subscribe: () => () => {}, notify: () => {} }, subscribe: sub }), l]; }, ""],
    ["officer #/crew", MO, "#/crew", (sub) => { const l = counted((s) => cm.getCrewSnapshot(s, o)); return [crewPage.createCrewMonitorRenderer({ loadSnapshot: l, loadDetail: (s, id) => cm.getCrewMemberDetail(s, id, o), subscribe: sub }), l]; }, ""],
    ["officer #/overview", MO, "#/overview", (sub) => { const l = counted((s) => cm.getCrewSnapshot(s, o)); return [moPage.createMedicalOfficerOverviewRenderer({ loadSnapshot: l, subscribe: sub }), l]; }, ""],
  ];
  for (const [name, session, hash, make, crewId] of screens) {
    const cap = capture();
    const [render, loader] = make(cap.subscribe);
    const controller = new AbortController();
    const container = new FakeElement("main");
    await render(container, session, { signal: controller.signal, hash });
    await flush();
    assert.equal(cap.subs.length, 1, `${name}: one subscription`);
    const sub = cap.subs[0];
    assert.equal(sub.signal, controller.signal, `${name}: unsubscribes on navigation`);
    assert.equal(sub.crewId(), crewId, `${name}: filters on the right crew member`);
    const before = loader.calls;
    assert.ok(before >= 1, `${name}: loaded`);
    await sub.reload({ name: "health:changed", data: { crewId: "AH-04", metric: "spo2", alertsChanged: true } });
    await flush();
    assert.equal(loader.calls, before + 1, `${name}: reloads on the event`);
    assert.ok(container.textContent.length > 0, `${name}: still shows content (no blank flash)`);
    controller.abort();
  }
});

test("live refresh: a committed Live control reading appears on the astronaut's overview after reload, AH-03's change does not", async () => {
  await mock.resetMock({ now: NOW });
  const r = repos();
  const clock = { now: NOW };
  const ov = overviewSvc.createAstronautOverviewService({ repos: r });
  const sim = simSvc.createSimulationService({ repos: r, withTransaction: mock.withTransaction });
  const cap = capture();
  const container = new FakeElement("main");
  await astroOverviewPage.createOverviewRenderer({ loadOverview: (s) => ov.getAstronautOverview(s, { now: clock.now }), subscribe: cap.subscribe })(container, REYES, {});
  await flush();
  const sub = cap.subs[0];
  assert.equal(sub.crewId(), "AH-04");
  // The real filter decides whether AH-03's event reaches this screen.
  const { concerns } = await import("../../js/core/live-updates.js");
  assert.equal(concerns("health:changed", { crewId: "AH-03" }, sub.crewId()), false);
  clock.now += SEC;
  assert.equal((await sim.recordManualReading(MO, { crewId: "AH-04", metric: "spo2", value: 83 }, { now: clock.now })).status, "recorded");
  assert.doesNotMatch(container.textContent, /blood oxygen saturation: 83 percent/);
  await sub.reload({ name: "health:changed", data: { crewId: "AH-04", metric: "spo2", alertsChanged: false } });
  await flush();
  assert.match(container.textContent, /blood oxygen saturation: 83 percent/, "the new SpO₂ value is shown");
});

test("live refresh: the app shell keeps the bell badge in step with live events", () => {
  const shell = code("js/pages/app-shell.js");
  assert.match(shell, /onHealthChanged\(\{[^}]*reload: \(\) => showAlertCount\(\)/);
  assert.match(shell, /countOpenAlerts/);
});
