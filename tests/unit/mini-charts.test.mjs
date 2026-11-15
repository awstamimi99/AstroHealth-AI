// tests/unit/mini-charts.test.mjs — js/components/mini-charts.js and the
// "Crew at a glance" section of #/crew. Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";

import { FakeElement, all, byClass } from "./fake-dom.mjs";

const charts = await import("../../js/components/mini-charts.js");
const crewPage = await import("../../js/pages/crew-monitor.js");
const crewSvc = await import("../../js/services/crew-monitor-service.js");
const mock = await import("../../js/db/mock-repositories.js");

const NOW = Date.UTC(2026, 10, 14, 15, 30);
const MO = { role: "medical_officer", userId: "u-medofficer", astronautId: "", displayName: "Dr. Lena Ortiz" };

test("severity bar: one segment per severity present; legend always has icon, word and number", () => {
  const node = charts.severityBar({ counts: { critical: 2, warning: 1, info: 0 } });
  assert.deepEqual(byClass(node, "mc-sev__seg").map((s) => s.classList.find((c) => c.startsWith("mc-sev__seg--"))), ["mc-sev__seg--critical", "mc-sev__seg--warning"]);
  const legend = byClass(node, "mc-sev__item");
  assert.deepEqual(legend.map((l) => l.textContent), ["Critical2", "Warning1", "Info0"]);
  for (const l of legend) assert.ok(all(l, (e) => e.tagName === "SVG").length === 1, "icon");
  assert.equal(all(node, (e) => e.getAttribute("role") === "img")[0].getAttribute("aria-label"), "2 critical, 1 warning, 0 info");
  assert.equal(all(charts.severityBar({ counts: {} }), (e) => e.getAttribute("role") === "img")[0].getAttribute("aria-label"), "No open alerts");
});

test("sparkline: missing days are gaps (two line segments), points are focusable and update the readout", () => {
  const points = [
    { date: "2026-11-10", value: 70 }, { date: "2026-11-11", value: 72 }, { date: "2026-11-12", value: null },
    { date: "2026-11-13", value: 68 }, { date: "2026-11-14", value: 66 },
  ];
  const node = charts.sparkline({ points, baseline: 70, unit: "bpm", label: "Jonas Reyes Heart rate" });
  assert.equal(byClass(node, "mc-spark__line").length, 2, "gap, never zero");
  const dots = byClass(node, "mc-spark__dot");
  assert.equal(dots.length, 4);
  assert.ok(dots.every((d) => d.getAttribute("tabindex") === "0"));
  assert.match(dots[0].getAttribute("aria-label"), /^Jonas Reyes Heart rate, 10 Nov: 70 bpm$/);
  const readout = byClass(node, "mc-spark__readout")[0];
  assert.equal(readout.textContent, "14 Nov · 66 bpm", "latest value by default");
  dots[1].dispatch("focus");
  assert.equal(readout.textContent, "11 Nov · 72 bpm");
  dots[1].dispatch("blur");
  assert.equal(readout.textContent, "14 Nov · 66 bpm");
  assert.equal(byClass(node, "mc-spark__base").length, 1);
  assert.match(charts.sparkline({ points: [{ date: "2026-11-14", value: null }] }).textContent, /No data in the last 7 days/);
});

test("bar list: rows link to the member; an unknown value says so instead of showing zero", () => {
  const node = charts.barList({ items: [{ label: "Mei Chen", value: 10, href: "#/wellbeing/AH-03" }, { label: "Jonas Reyes", value: null }] });
  const rows = byClass(node, "mc-bars__row");
  assert.equal(rows[0].tagName, "A");
  assert.equal(rows[0].getAttribute("href"), "#/wellbeing/AH-03");
  assert.match(rows[1].textContent, /Couldn't load/);
});

test("#/crew shows 'Crew at a glance' with severity, shared check-ins and a trend row per crew member", async () => {
  await mock.resetMock({ now: NOW });
  const repos = Object.fromEntries(Object.entries(mock).filter(([k]) => k.endsWith("Repo")));
  const svc = crewSvc.createCrewMonitorService({ repos, getMissionContext: async () => null });
  const render = crewPage.createCrewMonitorRenderer({ loadSnapshot: (s) => svc.getCrewSnapshot(s, { now: NOW }), loadDetail: (s, id) => svc.getCrewMemberDetail(s, id, { now: NOW }), subscribe: () => () => {} });
  const c = new FakeElement("main");
  await render(c, MO, { hash: "#/crew" });
  const glance = all(c, (e) => e.getAttribute("aria-labelledby") === "crew-glance-title")[0];
  assert.ok(glance, "section rendered");
  assert.equal(all(glance, (e) => e.getAttribute("data-chart") === "severity").length, 1);
  assert.equal(all(glance, (e) => e.getAttribute("data-chart") === "bars").length, 1);
  assert.equal(all(glance, (e) => e.getAttribute("data-chart") === "sparkline").length, 4 * 3);
  const links = all(glance, (e) => e.classList.includes("crew-glance__member")).map((a) => a.getAttribute("href"));
  assert.deepEqual([...links].sort(), ["#/crew/AH-01", "#/crew/AH-02", "#/crew/AH-03", "#/crew/AH-04"]);
});
