// tests/unit/alerts-page.test.mjs — #/alerts page module (Sprint 8) on the shared fake
// DOM, with the real alerts + risk services over the seeded mock.
// Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { FakeElement, all, byClass, byTag, byId } from "./fake-dom.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const page = await import("../../js/pages/alerts.js");
const alertsSvc = await import("../../js/services/alerts-service.js");
const riskSvc = await import("../../js/services/risk-service.js");
const mock = await import("../../js/db/mock-repositories.js");

const NOW = Date.UTC(2026, 10, 14, 15, 30);
const MO = Object.freeze({ role: "medical_officer", userId: "u-medofficer", astronautId: "" });
const REYES = Object.freeze({ role: "astronaut", userId: "u-reyes", astronautId: "a-04" });
const BANNED = /\b(healthy|unhealthy|normal health|diagnosed|medically cleared|fit for duty|risk score|health score|evidence-backed|clinical standard)\b/i;
const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0)); };

function harness() {
  const repos = { usersRepo: mock.usersRepo, astronautsRepo: mock.astronautsRepo, measurementsRepo: mock.measurementsRepo, settingsRepo: mock.settingsRepo, alertsRepo: mock.alertsRepo, alertActionsRepo: mock.alertActionsRepo, eventsRepo: mock.eventsRepo, messagesRepo: mock.messagesRepo };
  const a = alertsSvc.createAlertsService({ repos, withTransaction: mock.withTransaction });
  const r = riskSvc.createRiskService({ repos, withTransaction: mock.withTransaction });
  const calls = [];
  const o = { now: NOW };
  const service = {
    listAlerts: (s, f) => (calls.push(["list", f]), a.listAlerts(s, f, o)),
    getAlertDetail: (s, n) => (calls.push(["detail", n]), a.getAlertDetail(s, n, o)),
    acknowledgeAlert: (s, n, i) => (calls.push(["ack", n, i]), a.acknowledgeAlert(s, n, i, o)),
    resolveAlert: (s, n, i) => (calls.push(["resolve", n, i]), a.resolveAlert(s, n, i, o)),
    evaluateCrew: (s) => (calls.push(["evaluate"]), r.evaluateCrew(s, o)),
  };
  const pings = { sent: 0 };
  const render = page.createAlertsRenderer({ service, channel: { subscribe: () => () => {}, notify: () => { pings.sent += 1; } } });
  return { calls, pings, render, container: new FakeElement("main") };
}
const text = (n) => n.textContent;
const live = (root) => all(root, (e) => e.getAttribute("aria-live") === "polite")[0];
const dump = (n) => (n instanceof FakeElement ? [...n.attributes.values()].join(" ") + " " + n.childNodes.map(dump).join(" ") : n.textContent);

test("route parsing: list, detail by public number, everything else not found", () => {
  assert.deepEqual(page.parseAlertsRoute("#/alerts"), { view: "list" });
  assert.deepEqual(page.parseAlertsRoute("#/alerts/ALT-0191"), { view: "detail", number: "ALT-0191" });
  for (const h of ["#/alerts/alr_123", "#/alerts/ALT-01", "#/alerts/ALT-0191/x", "#/alerts/alt-0191", "#/alertsx"]) assert.equal(page.parseAlertsRoute(h).view, "invalid", h);
});

test("astronaut list: own alerts only, read-only, demonstration label, no evaluate/ack/resolve controls", async () => {
  await mock.resetMock({ now: NOW });
  const h = harness();
  await h.render(h.container, REYES, { signal: new AbortController().signal, focus: true });
  await flush();
  const t = text(h.container);
  assert.match(t, /Your alerts/);
  assert.match(t, /ALT-0190 · Reduced sleep duration/);
  assert.ok(!/ALT-0189|ALT-0181|ALT-0184/.test(t), "no other astronaut's alerts");
  assert.match(t, /Demonstration threshold — not clinically validated\./);
  assert.match(t, /not a diagnosis/i);
  assert.ok(!byId(h.container, "alerts-evaluate") && !byId(h.container, "alert-ack") && !byId(h.container, "alert-resolve"));
  assert.ok(!h.calls.some((c) => c[0] === "evaluate"), "no evaluation on page load");
  assert.equal(document.activeElement.getAttribute("id"), "alerts-title");
  assert.ok(byTag(h.container, "a").some((a) => a.getAttribute("href") === "#/alerts/ALT-0190"));
  assert.ok(!BANNED.test(t));
});

test("astronaut detail: own alert read-only; another astronaut's number → the same not found", async () => {
  await mock.resetMock({ now: NOW });
  const h = harness();
  await h.render(h.container, REYES, { signal: new AbortController().signal, hash: "#/alerts/ALT-0190" });
  await flush();
  const t = text(h.container);
  assert.match(t, /ALT-0190 · Reduced sleep duration/);
  assert.match(t, /Evidence/);
  assert.match(t, /Audit trail/);
  assert.match(t, /This view is read-only/);
  assert.ok(!byId(h.container, "alert-ack") && !byId(h.container, "alert-resolve"));
  const h2 = harness();
  await h2.render(h2.container, REYES, { signal: new AbortController().signal, hash: "#/alerts/ALT-0189" });
  await flush();
  assert.match(text(h2.container), /Alert not found/);
  assert.ok(!/Supportive check-in/.test(text(h2.container)));
  const h3 = harness();
  await h3.render(h3.container, REYES, { signal: new AbortController().signal, hash: "#/alerts/garbage" });
  assert.match(text(h3.container), /Alert not found/);
  assert.equal(h3.calls.length, 0, "invalid route: no service call");
});

test("officer list: filters, explicit 'Evaluate crew now' (never on load), result summary", async () => {
  await mock.resetMock({ now: NOW });
  const h = harness();
  await h.render(h.container, MO, { signal: new AbortController().signal });
  await flush();
  const root = h.container;
  assert.match(text(root), /Crew alerts/);
  assert.deepEqual(byTag(byId(root, "alerts-status"), "option").map((o) => o.getAttribute("value")), ["open", "new", "acknowledged", "resolved", "all"]);
  assert.deepEqual(byTag(byId(root, "alerts-crew"), "option").map((o) => o.getAttribute("value")), ["", "AH-01", "AH-02", "AH-03", "AH-04"]);
  assert.ok(!h.calls.some((c) => c[0] === "evaluate"), "no evaluation on page load");
  const sel = byId(root, "alerts-status");
  sel.setAttribute("value", "all");
  sel.dispatch("change");
  await flush();
  assert.deepEqual(h.calls.filter((c) => c[0] === "list").at(-1)[1], { status: "all", severity: "all", crewId: "" });
  assert.match(text(root), /ALT-0181/);
  byId(root, "alerts-evaluate").click();
  await flush();
  assert.equal(h.calls.filter((c) => c[0] === "evaluate").length, 1);
  assert.match(text(root), /Evaluated 4 crew members\. No alert changed\./);
  assert.equal(live(root).textContent, "Evaluation finished. No alert changed.");
  assert.equal(h.pings.sent, 0, "nothing changed → no ping");
});

test("officer detail: acknowledge, then resolve with a note and the required confirmation", async () => {
  await mock.resetMock({ now: NOW });
  const h = harness();
  await h.render(h.container, MO, { signal: new AbortController().signal, hash: "#/alerts/ALT-0189" });
  await flush();
  const root = h.container;
  assert.match(text(root), /ALT-0189 · Supportive check-in recommended/);
  assert.match(text(root), /Not shown \(wellbeing score\)/, "wellbeing scores hidden in evidence");
  byId(root, "alert-ack").click();
  await flush();
  assert.deepEqual(h.calls.find((c) => c[0] === "ack").slice(1), ["ALT-0189", {}]);
  assert.match(text(root), /Alert acknowledged\./);
  assert.equal(live(root).textContent, "Alert acknowledged.");
  assert.equal(h.pings.sent, 1);
  const btn = () => byId(root, "alert-resolve");
  assert.ok(btn().hasAttribute("disabled"), "disabled without a note");
  const note = byId(root, "alert-note");
  note.setAttribute("value", "Supportive conversation held.");
  note.dispatch("input");
  assert.ok(btn().hasAttribute("disabled"), "still disabled without the confirmation (condition present)");
  const box = byId(root, "alert-confirm");
  box.checked = true;
  box.dispatch("change");
  assert.ok(!btn().hasAttribute("disabled"));
  btn().click();
  await flush();
  assert.deepEqual(h.calls.find((c) => c[0] === "resolve").slice(1), ["ALT-0189", { note: "Supportive conversation held.", confirmConditionPresent: true, notifyAstronaut: true }]);
  assert.match(text(root), /Alert resolved\./);
  assert.match(text(root), /Resolved alerts are kept as history/);
  assert.match(text(root), /Supportive conversation held\./);
  assert.ok(!byId(root, "alert-resolve") && !byId(root, "alert-ack"));
});

test("no internal ids, no innerHTML, no database imports, no alert writes from the page", async () => {
  await mock.resetMock({ now: NOW });
  const h = harness();
  await h.render(h.container, MO, { signal: new AbortController().signal, hash: "#/alerts/ALT-0190" });
  await flush();
  const rendered = dump(h.container);
  for (const bad of ["a-04", "u-medofficer", "alr_", "msr_", "act_", "evt_"]) assert.ok(!rendered.includes(bad), bad);
  const src = read("js/pages/alerts.js").replace(/\/\/[^\n]*/g, "");
  const imports = [...src.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.ok(imports.every((p) => /^\.\.\/(services|components|core)\//.test(p)), imports.join());
  assert.ok(!src.includes("innerHTML"));
  assert.ok(!/alertsRepo|alertActionsRepo|eventsRepo|withTransaction/.test(src), "pages never write alerts");
});

test("late results after navigation are ignored", async () => {
  await mock.resetMock({ now: NOW });
  const h = harness();
  const ctl = new AbortController();
  const p = h.render(h.container, MO, { signal: ctl.signal });
  ctl.abort();
  await p;
  await flush();
  assert.ok(!/Crew alerts/.test(text(h.container)));
});

test("note privacy on the page: an astronaut sees the resolved lifecycle but never the Medical Officer's note", async () => {
  await mock.resetMock({ now: NOW });
  const repos = { usersRepo: mock.usersRepo, astronautsRepo: mock.astronautsRepo, alertsRepo: mock.alertsRepo, alertActionsRepo: mock.alertActionsRepo, eventsRepo: mock.eventsRepo };
  const a = alertsSvc.createAlertsService({ repos, withTransaction: mock.withTransaction });
  await a.resolveAlert(MO, "ALT-0190", { note: "MO-ONLY page note 5521", confirmConditionPresent: true }, { now: NOW + 1 });
  const h = harness();
  await h.render(h.container, REYES, { signal: new AbortController().signal, hash: "#/alerts/ALT-0190" });
  await flush();
  const t = text(h.container);
  assert.match(t, /Resolved/);
  assert.match(t, /Audit trail/);
  assert.ok(!/MO-ONLY page note 5521/.test(dump(h.container)), "note not rendered for the astronaut");
  assert.ok(!/Resolution note/.test(t));
  const h2 = harness();
  await h2.render(h2.container, MO, { signal: new AbortController().signal, hash: "#/alerts/ALT-0190" });
  await flush();
  assert.match(text(h2.container), /MO-ONLY page note 5521/, "the Medical Officer still sees it");
});
