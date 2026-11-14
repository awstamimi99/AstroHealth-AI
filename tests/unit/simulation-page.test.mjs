// tests/unit/simulation-page.test.mjs — #/simulation page module (Sprint 7) on the
// shared fake DOM: rendering, start flow, timer ownership and cleanup, stale
// runs, controls, refusals, no ids rendered. The real service runs over the
// seeded mock with a test clock and fake timers.
// Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { FakeElement, all, byClass, byTag, byId, sectionOf } from "./fake-dom.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const page = await import("../../js/pages/simulation-center.js");
const svc = await import("../../js/services/simulation-service.js");
const mock = await import("../../js/db/mock-repositories.js");

const NOW = Date.UTC(2026, 10, 14, 15, 30);
const MO = Object.freeze({ role: "medical_officer", userId: "u-medofficer", astronautId: "", displayName: "Dr. Lena Ortiz" });
const BANNED = /\b(healthy|unhealthy|normal health|diagnos\w*|medically cleared|fit for duty|treatment|risk score|health score|hypoxi\w*|detected)\b/i;
const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0)); };

function harness() {
  const clock = { now: NOW };
  const real = svc.createSimulationService({
    repos: { usersRepo: mock.usersRepo, astronautsRepo: mock.astronautsRepo, measurementsRepo: mock.measurementsRepo, simulationRunsRepo: mock.simulationRunsRepo, eventsRepo: mock.eventsRepo },
    withTransaction: mock.withTransaction,
  });
  const calls = [];
  const opts = () => ({ now: clock.now });
  const service = {
    getSimulationCenter: (s) => (calls.push(["center"]), real.getSimulationCenter(s, opts())),
    previewSimulation: (s, i) => (calls.push(["preview", i]), real.previewSimulation(s, i, opts())),
    startSimulation: (s, i) => (calls.push(["start", i]), real.startSimulation(s, i, opts())),
    advanceSimulation: (s, r, i) => (calls.push(["advance", i]), real.advanceSimulation(s, r, i, opts())),
    pauseSimulation: (s, r) => (calls.push(["pause"]), real.pauseSimulation(s, r, opts())),
    resumeSimulation: (s, r) => (calls.push(["resume"]), real.resumeSimulation(s, r, opts())),
    stopSimulation: (s, r, i) => (calls.push(["stop", i]), real.stopSimulation(s, r, i, opts())),
  };
  const pending = new Map();
  let nextId = 1;
  const timers = {
    set: (fn, ms) => { const id = nextId++; pending.set(id, { fn, ms }); return id; },
    clear: (id) => { pending.delete(id); },
  };
  const pings = { sent: 0, listener: null, unsubscribed: false };
  const channel = { subscribe: (fn) => { pings.listener = fn; return () => { pings.unsubscribed = true; }; }, notify: () => { pings.sent += 1; } };
  const render = page.createSimulationCenterRenderer({ service, timers, channel });
  const container = new FakeElement("main");
  const fire = async () => {
    const [[id, t]] = [...pending];
    pending.delete(id);
    clock.now += t.ms;
    t.fn();
    await flush();
  };
  return { clock, real, calls, pending, timers, pings, render, container, fire };
}
const button = (root, id) => byId(root, id);
const text = (root) => root.textContent;
const liveOf = (root) => all(root, (e) => e.getAttribute("aria-live") === "polite")[0];
const runs = async () => (await Promise.all(["a-01", "a-02", "a-03", "a-04"].map((a) => mock.simulationRunsRepo.getByAstronaut(a)))).flat();

async function startRun(h, root, { crewId = "AH-03", scenarioId = "low_oxygen", speed = "8" } = {}) {
  const crew = byId(root, "sim-crew");
  crew.setAttribute("value", crewId);
  crew.dispatch("change");
  await flush();
  const radio = byId(root, `sim-scenario-${scenarioId}`);
  radio.dispatch("change");
  await flush();
  const sp = byId(root, "sim-speed");
  sp.setAttribute("value", speed);
  sp.dispatch("change");
  await flush();
  const box = byId(root, "sim-confirm");
  box.checked = true;
  box.dispatch("change");
  await flush();
  button(root, "sim-start").click();
  await flush();
}

test("renders the header, disclaimers, notes and the start form; nothing is fabricated", async () => {
  await mock.resetMock({ now: NOW });
  const h = harness();
  await h.render(h.container, MO, { signal: new AbortController().signal, focus: true });
  await flush();
  const root = h.container;
  const t = text(root);
  assert.match(t, /Simulation Center/);
  assert.match(t, /SIMULATED/);
  assert.match(t, /not a medical device/i);
  assert.match(t, /not affiliated with or endorsed by NASA/);
  assert.match(t, /No risk rules are evaluated and no alerts are created\. Risk evaluation will be implemented in the Risk Engine sprint\./);
  assert.match(t, /The simulation advances only while this page is open\. Background tabs may be delayed\./);
  assert.match(t, /No simulation runs yet\./);
  assert.ok(!BANNED.test(t), t.match(BANNED)?.[0]);
  assert.equal(document.activeElement && document.activeElement.getAttribute("id"), "sim-title", "heading focused on navigation");
  // Form: crew select, scenario fieldset/legend + radios, speed select; Start disabled with a reason.
  assert.equal(byTag(root, "fieldset").length, 1);
  assert.equal(byTag(root, "legend")[0].textContent, "Scenario");
  assert.deepEqual(byTag(byId(root, "sim-crew"), "option").map((o) => o.getAttribute("value")), ["", "AH-01", "AH-02", "AH-03", "AH-04"]);
  assert.deepEqual(byTag(byId(root, "sim-speed"), "option").map((o) => o.getAttribute("value")), ["1", "2", "4", "8"]);
  assert.ok(button(root, "sim-start").hasAttribute("disabled"));
  assert.equal(button(root, "sim-start").getAttribute("aria-describedby"), "sim-start-help");
  assert.equal(byId(root, "sim-start-help").textContent, "Choose a crew member.");
  assert.equal(h.pending.size, 0, "no timer without a run");
});

test("start flow: preview, explicit confirmation, exact page input, then this tab drives the run", async () => {
  await mock.resetMock({ now: NOW });
  const h = harness();
  await h.render(h.container, MO, { signal: new AbortController().signal });
  await flush();
  const root = h.container;
  await startRun(h, root);
  const previews = h.calls.filter((c) => c[0] === "preview");
  assert.deepEqual(previews.at(-1)[1], { crewId: "AH-03", scenarioId: "low_oxygen" });
  const starts = h.calls.filter((c) => c[0] === "start");
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0][1], { crewId: "AH-03", scenarioId: "low_oxygen", speed: 8, confirm: true }, "page sends only the four allowed fields");
  assert.equal((await runs()).length, 1);
  assert.match(text(root), /Active run/);
  assert.match(text(root), /Running/);
  assert.match(text(root), /Step 0 of 12/);
  assert.equal(liveOf(root).textContent, "Simulation started for Mei Chen.");
  assert.equal(h.pings.sent, 1, "other tabs get a payload-free refresh ping");
  // <progress> with max + value
  const prog = byTag(root, "progress")[0];
  assert.deepEqual([prog.getAttribute("max"), prog.getAttribute("value")], ["12", "0"]);
  // Exactly one pending timer at 8× = 1000 ms.
  assert.equal(h.pending.size, 1);
  assert.equal([...h.pending.values()][0].ms, 1000);
  // Start form is hidden while a run is active.
  assert.equal(byId(root, "sim-crew"), undefined);
});

test("start is not sent without confirmation; preview resets confirmation when the selection changes", async () => {
  await mock.resetMock({ now: NOW });
  const h = harness();
  await h.render(h.container, MO, { signal: new AbortController().signal });
  await flush();
  const root = h.container;
  const crew = byId(root, "sim-crew");
  crew.setAttribute("value", "AH-01");
  crew.dispatch("change");
  await flush();
  byId(root, "sim-scenario-elevated_heart_rate").dispatch("change");
  await flush();
  assert.match(text(root), /Preview · Sami Haddad · AH-01/);
  assert.match(text(root), /83 bpm/);
  button(root, "sim-start").click();
  await flush();
  assert.equal(h.calls.filter((c) => c[0] === "start").length, 0, "no start without the checkbox");
  const box = byId(root, "sim-confirm");
  box.checked = true;
  box.dispatch("change");
  await flush();
  assert.ok(!button(root, "sim-start").hasAttribute("disabled"));
  byId(root, "sim-scenario-low_oxygen").dispatch("change");
  await flush();
  assert.ok(button(root, "sim-start").hasAttribute("disabled"), "changing the scenario clears the confirmation");
  assert.ok(!byId(root, "sim-confirm").hasAttribute("checked"));
});

test("timer chain: one step per timeout, the next timer only after success, completion stops it; no per-step announcements", async () => {
  await mock.resetMock({ now: NOW });
  const h = harness();
  await h.render(h.container, MO, { signal: new AbortController().signal });
  await flush();
  const root = h.container;
  await startRun(h, root);
  for (let i = 0; i < 11; i += 1) {
    assert.equal(h.pending.size, 1, `one pending timer before step ${i + 1}`);
    await h.fire();
    assert.match(text(root), new RegExp(`Step ${i + 1} of 12`));
    assert.equal(liveOf(root).textContent, "Simulation started for Mei Chen.", "steps are not announced");
  }
  assert.deepEqual(h.calls.filter((c) => c[0] === "advance").map((c) => c[1].expectedStep), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  await h.fire();
  assert.equal(h.pending.size, 0, "no timer after completion");
  assert.match(text(root), /Last run/);
  assert.match(text(root), /Completed/);
  assert.equal(liveOf(root).textContent, "Simulation completed. All 12 steps were generated.");
  assert.equal(byTag(sectionOf(root, "sim-readings-title"), "tr").length, 13, "12 rows + header");
  assert.match(text(sectionOf(root, "sim-readings-title")), /Simulated/);
  assert.ok(byId(root, "sim-crew"), "a new run can be configured");
  // Links to the selected astronaut's dashboards.
  const hrefs = byTag(root, "a").map((a) => a.getAttribute("href"));
  assert.ok(hrefs.includes("#/physical/AH-03") && hrefs.includes("#/crew/AH-03"));
  assert.ok(!hrefs.some((x) => /alerts/.test(x)), "no link to an Alerts/Risk page that doesn't exist yet");
});

test("pause clears the timer; resume restarts it; stop needs a confirmation panel", async () => {
  await mock.resetMock({ now: NOW });
  const h = harness();
  await h.render(h.container, MO, { signal: new AbortController().signal });
  await flush();
  const root = h.container;
  await startRun(h, root);
  await h.fire();
  button(root, "sim-pause").click();
  await flush();
  assert.equal(h.pending.size, 0, "paused → no timer");
  assert.match(text(root), /Paused/);
  assert.equal(liveOf(root).textContent, "Simulation paused.");
  assert.ok(button(root, "sim-advance").hasAttribute("disabled"));
  assert.equal(button(root, "sim-advance").getAttribute("aria-describedby"), "sim-advance-help");
  assert.match(byId(root, "sim-advance-help").textContent, /paused/);
  h.clock.now += 5000;
  button(root, "sim-resume").click();
  await flush();
  assert.equal(h.pending.size, 1, "resumed → timer");
  assert.equal(liveOf(root).textContent, "Simulation resumed.");
  button(root, "sim-stop").click();
  await flush();
  assert.equal(h.calls.filter((c) => c[0] === "stop").length, 0, "Stop opens a confirmation first");
  assert.match(text(root), /Stop this simulation\?/);
  button(root, "sim-stop-cancel").click();
  await flush();
  assert.ok(!/Stop this simulation\?/.test(text(root)));
  button(root, "sim-stop").click();
  await flush();
  button(root, "sim-stop-confirm").click();
  await flush();
  assert.deepEqual(h.calls.filter((c) => c[0] === "stop").map((c) => c[1]), [{ confirm: true }]);
  assert.equal(h.pending.size, 0);
  assert.match(text(root), /Stopped/);
  assert.equal(liveOf(root).textContent, "Simulation stopped.");
});

test("33. navigation/abort clears the timer, unsubscribes, ignores late results and writes nothing", async () => {
  await mock.resetMock({ now: NOW });
  const h = harness();
  const ctl = new AbortController();
  await h.render(h.container, MO, { signal: ctl.signal });
  await flush();
  await startRun(h, h.container);
  assert.equal(h.pending.size, 1);
  const before = h.calls.length;
  ctl.abort();
  assert.equal(h.pending.size, 0, "timer cleared on abort");
  assert.equal(h.pings.unsubscribed, true);
  await flush();
  assert.equal(h.calls.length, before, "no implicit pause/stop/advance after leaving");
  const [run] = await runs();
  assert.equal(run.status, "running", "leaving the page doesn't auto-pause");
  assert.equal(run.step, 0, "no backfill");

  // Late result: abort while a load is in flight → the container isn't touched afterwards.
  const h2 = harness();
  const ctl2 = new AbortController();
  const p = h2.render(h2.container, MO, { signal: ctl2.signal });
  ctl2.abort();
  await p;
  await flush();
  assert.ok(!/Active run|New simulation run/.test(text(h2.container)), "late result dropped");
});

test("31 + 14. refresh reconstructs the run; a stale run waits for a deliberate Continue (no backfill)", async () => {
  await mock.resetMock({ now: NOW });
  const h = harness();
  await h.render(h.container, MO, { signal: new AbortController().signal });
  await flush();
  await startRun(h, h.container);
  await h.fire();
  await h.fire();
  // "Refresh": a new renderer instance, 2 minutes later.
  const h2 = harness();
  h2.clock.now = h.clock.now + 120000;
  await h2.render(h2.container, MO, { signal: new AbortController().signal });
  await flush();
  const root = h2.container;
  assert.match(text(root), /Step 2 of 12/);
  assert.match(text(root), /Not advancing/);
  assert.match(text(root), /Not advancing — the page may have been closed/);
  assert.equal(h2.pending.size, 0, "a stale run is not auto-advanced");
  assert.equal(h2.calls.filter((c) => c[0] === "advance").length, 0);
  assert.ok(button(root, "sim-continue") && button(root, "sim-pause") && button(root, "sim-stop"));
  button(root, "sim-continue").click();
  await flush();
  assert.equal(h2.pending.size, 1, "Continue schedules the next step");
  await h2.fire();
  assert.deepEqual(h2.calls.filter((c) => c[0] === "advance").map((c) => c[1].expectedStep), [2], "continues from step 2, nothing filled in");
  assert.match(text(root), /Step 3 of 12/);

  // Fresh but not driven by this tab: "may be advancing in another tab", still no timer.
  const h3 = harness();
  h3.clock.now = h2.clock.now + 100;
  await h3.render(h3.container, MO, { signal: new AbortController().signal });
  await flush();
  assert.match(text(h3.container), /may be advancing in another tab or window/);
  assert.equal(h3.pending.size, 0);
  // A ping from another tab reloads the view.
  const n = h3.calls.filter((c) => c[0] === "center").length;
  h3.pings.listener();
  await flush();
  assert.equal(h3.calls.filter((c) => c[0] === "center").length, n + 1);
});

test("a step conflict from another tab keeps the state honest; other failures stop the timer with a message", async () => {
  await mock.resetMock({ now: NOW });
  const h = harness();
  await h.render(h.container, MO, { signal: new AbortController().signal });
  await flush();
  await startRun(h, h.container);
  // Another tab advances step 1 first.
  const [run] = await runs();
  assert.equal((await h.real.advanceSimulation(MO, run.id, { expectedStep: 0 }, { now: h.clock.now + 10 })).status, "advanced");
  await h.fire();
  assert.match(text(h.container), /advanced elsewhere/);
  assert.match(text(h.container), /Step 1 of 12/);
  assert.equal(h.pending.size, 1, "keeps driving from the stored step");
  // Clock goes backwards → clock_not_monotonic → timer stops, message shown.
  const [[id, t]] = [...h.pending];
  h.pending.delete(id);
  h.clock.now -= 60000;
  t.fn();
  await flush();
  assert.equal(h.pending.size, 0);
  assert.match(text(h.container), /clock is not later than the last generated step/);
  assert.equal(liveOf(h.container).textContent.length > 0, true);
});

test("another active run: conflict message, no second run", async () => {
  await mock.resetMock({ now: NOW });
  const h = harness();
  await h.render(h.container, MO, { signal: new AbortController().signal });
  await flush();
  // Form is drawn; meanwhile another tab starts a run.
  await h.real.startSimulation(MO, { crewId: "AH-02", scenarioId: "elevated_heart_rate", speed: 1, confirm: true }, { now: NOW + 1 });
  await startRun(h, h.container);
  assert.match(text(h.container), /Another simulation is already active/);
  assert.match(text(h.container), /Aisha Karim \(AH-02\)/);
  assert.equal((await runs()).length, 1);
});

test("refusals render a safe view; no internal ids or the run reference are ever rendered", async () => {
  await mock.resetMock({ now: NOW });
  const h = harness();
  await h.render(h.container, { role: "medical_officer", userId: "u-haddad", astronautId: "" }, { signal: new AbortController().signal });
  await flush();
  assert.match(text(h.container), /Please sign in again/);
  assert.equal(h.pending.size, 0);

  const h2 = harness();
  await h2.render(h2.container, MO, { signal: new AbortController().signal });
  await flush();
  await startRun(h2, h2.container);
  await h2.fire();
  const [run] = await runs();
  const dump = (n) => (n instanceof FakeElement ? [...n.attributes.values()].join(" ") + " " + n.childNodes.map(dump).join(" ") : n.textContent);
  const rendered = dump(h2.container);
  for (const bad of [run.id, "a-03", "u-medofficer", "msr_", "evt_"]) assert.ok(!rendered.includes(bad), bad);
  assert.ok(!/sim_[0-9a-f]/.test(rendered), "no run id (sim_<uuid>) in text or attributes");
  assert.ok(!BANNED.test(h2.container.textContent));
  // Status = icon + text (badge), never colour only.
  const badges = byClass(h2.container, "badge").filter((b) => /Running|Paused|Completed|Stopped|Not advancing/.test(b.textContent));
  assert.ok(badges.length >= 1 && badges.every((b) => byTag(b, "svg").length === 1));
});

test("38 + structure: the page imports no database module and uses no innerHTML or setInterval", () => {
  const src = read("js/pages/simulation-center.js").replace(/\/\/[^\n]*/g, "");
  const imports = [...src.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.ok(imports.every((p) => /^\.\.\/(services|components|core)\//.test(p)), imports.join(", "));
  assert.ok(!imports.some((p) => p.includes("/db/")));
  assert.ok(!src.includes("innerHTML"));
  assert.ok(!src.includes("setInterval"));
  assert.ok(!/location\.hash\s*=|history\.pushState/.test(src), "the run reference never goes into a URL");
  assert.equal(page.durationText(96000), "1 min 36 s");
  assert.equal(page.durationText(12000), "12 s");
  assert.equal(page.durationText(60000), "1 min");
});
