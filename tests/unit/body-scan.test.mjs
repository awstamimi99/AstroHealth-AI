// tests/unit/body-scan.test.mjs — the shared body-scan components:
// body-scan.js (wireframe body, pins, rings), alert-zones.js, dialog.js,
// action-plans.js and core/action-plan-progress.js.
// Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";

import { FakeElement, all, byClass, byTag, byId } from "./fake-dom.mjs";

const scan = await import("../../js/components/body-scan.js");
const zones = await import("../../js/components/alert-zones.js");
const plans = await import("../../js/components/action-plans.js");
const { openDialog } = await import("../../js/components/dialog.js");
const { createPlanProgress, PROGRESS_KEY } = await import("../../js/core/action-plan-progress.js");

const ids = (root) => all(root, (e) => e.hasAttribute("id")).map((e) => e.getAttribute("id"));
const PIN = { number: 1, zone: "lungs", severity: "critical", label: "Alert 1: ALT-0191 Low SpO₂ — Critical, Chest (lungs). Open details.", tag: "Low SpO₂" };

// ---- body-scan.js -------------------------------------------------------------------

test("body: decorative SVG with clip path, glow filter, mesh, outline, scan line and floor ring", () => {
  const body = scan.createBodyScan({});
  const svg = byClass(body, "scan-body__svg")[0];
  assert.equal(svg.getAttribute("aria-hidden"), "true");
  assert.equal(svg.getAttribute("focusable"), "false");
  assert.equal(svg.getAttribute("viewBox"), "0 0 300 640");
  for (const tag of ["clipPath", "filter", "linearGradient"]) assert.ok(all(svg, (e) => e.tagName.toLowerCase() === tag.toLowerCase()).length >= 1, tag);
  for (const cls of ["scan-body__mesh", "scan-body__outline", "scan-body__scanline", "scan-body__floor", "scan-body__grid"]) assert.equal(byClass(svg, cls).length, 1, cls);
  assert.ok(byClass(svg, "scan-body__ring-front").length, "front mesh rings");
  const mesh = byClass(svg, "scan-body__mesh")[0];
  assert.ok(byClass(mesh, "scan-body__ring-front").length > 20, "horizontal mesh rings (front halves)");
  assert.equal(byClass(mesh, "scan-body__ring-front").length, byClass(mesh, "scan-body__ring-back").length, "each ring has a faint back half");
  for (const cls of ["scan-body__rim", "scan-body__frame", "scan-body__beam"]) assert.equal(byClass(svg, cls).length, 1, cls);
  assert.equal(byClass(body, "scan-pin").length, 0);
});

test("body: the outline path is deterministic and closed", () => {
  const a = scan.bodyOutlinePath();
  assert.equal(a, scan.bodyOutlinePath());
  assert.match(a, /^M[\d.]+ [\d.]+ C/);
  assert.match(a, /Z$/);
});

test("body: SVG ids are unique per instance and every url(#…) reference resolves inside its own drawing", () => {
  const one = scan.createBodyScan({ hotspots: [{ zone: "head", severity: "warning" }] });
  const two = scan.createBodyScan({ hotspots: [{ zone: "head", severity: "warning" }] });
  const a = ids(one);
  const b = ids(two);
  assert.ok(a.length >= 4);
  assert.equal(new Set(a).size, a.length);
  assert.equal(a.filter((id) => b.includes(id)).length, 0, "no shared ids between two bodies");
  const refs = all(one, () => true).flatMap((e) => [...(e.attributes ? e.attributes.values() : [])]).join(" ").match(/url\(#([^)]+)\)/g) || [];
  assert.ok(refs.length >= 4);
  for (const ref of refs) assert.ok(a.includes(ref.slice(5, -1)), ref);
});

test("body: crop 'upper' uses a shorter viewBox and drops the floor ring", () => {
  const body = scan.createBodyScan({ crop: "upper" });
  assert.equal(byClass(body, "scan-body__svg")[0].getAttribute("viewBox"), "0 0 300 340");
  assert.equal(byClass(body, "scan-body__floor").length, 0);
  assert.ok(body.classList.includes("scan-body--upper"));
});

test("pins: real buttons with aria-label, number, pulse and tag; click calls onPinClick(pin, button)", () => {
  const calls = [];
  const body = scan.createBodyScan({ pins: [PIN, { ...PIN, number: 2, severity: "warning", tag: "" }], onPinClick: (pin, button) => calls.push([pin.number, button]) });
  const pins = byClass(body, "scan-pin");
  assert.equal(pins.length, 2);
  const [p1, p2] = pins;
  assert.equal(p1.tagName, "BUTTON");
  assert.equal(p1.getAttribute("type"), "button");
  assert.equal(p1.getAttribute("aria-label"), PIN.label);
  assert.ok(p1.classList.includes("scan-pin--critical"));
  assert.equal(byClass(p1, "scan-pin__num")[0].textContent, "1");
  assert.equal(byClass(p1, "scan-pin__pulse").length, 1);
  const tag = byClass(p1, "scan-pin__tag")[0];
  assert.equal(byClass(tag, "scan-pin__title")[0].textContent, "Low SpO₂");
  const sev = byClass(tag, "scan-pin__sev")[0];
  assert.equal(sev.textContent, "Critical", "severity word, not colour alone");
  assert.equal(byTag(sev, "svg").length, 1, "severity icon");
  for (const span of p1.childNodes) assert.equal(span.getAttribute("aria-hidden"), "true", "the aria-label is the accessible name");
  assert.equal(byClass(p2, "scan-pin__tag").length, 0);
  assert.notEqual(p1.style.top, p2.style.top, "pins on one zone don't overlap");
  p2.click();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 2);
  assert.equal(calls[0][1], p2);
});

test("pins: unknown severity falls back to info; unknown zone falls back to the chest", () => {
  const body = scan.createBodyScan({ pins: [{ ...PIN, severity: "bogus", zone: "nowhere" }] });
  const pin = byClass(body, "scan-pin")[0];
  assert.ok(pin.classList.includes("scan-pin--info"));
  assert.deepEqual({ x: scan.zonePoint("nowhere").x, y: scan.zonePoint("nowhere").y }, { x: scan.ZONES.chest.x, y: scan.ZONES.chest.y });
});

test("pins: labels and tags are inserted as text, never markup", () => {
  const body = scan.createBodyScan({ pins: [{ ...PIN, label: '<img src=x onerror="1">', tag: "<b>x</b>" }] });
  assert.equal(byTag(body, "img").length, 0);
  assert.equal(byTag(body, "b").length, 0);
  assert.equal(byClass(body, "scan-pin__title")[0].textContent, "<b>x</b>");
  assert.ok(all(body, (e) => Boolean(e.svgMarkup) && !String(e.getAttribute("class") || "").startsWith("icon")).length === 0, "only built-in icons receive markup");
});

test("ring: labelled figure, real text value/unit/baseline, arc only with a value, clamped display scale", () => {
  const ring = scan.createRing({ id: "r1", label: "Heart rate", value: "72", unit: "bpm", fraction: 1.7, baseline: "Your baseline: 70 bpm", spoken: "Heart rate: 72 beats per minute" });
  assert.equal(ring.tagName, "FIGURE");
  assert.equal(byId(ring, ring.getAttribute("aria-labelledby")).textContent, "Heart rate");
  assert.equal(byClass(ring, "scan-ring__value")[0].getAttribute("aria-hidden"), "true");
  assert.ok(byClass(ring, "sr-only").some((e) => e.textContent === "Heart rate: 72 beats per minute"));
  const arc = byClass(ring, "scan-ring__arc")[0];
  const [dash, total] = arc.getAttribute("stroke-dasharray").split(" ").map(Number);
  assert.equal(dash, total, "fraction is clamped to 1");
  assert.match(ring.textContent, /Your baseline: 70 bpm/);
  const empty = scan.createRing({ id: "r2", label: "SpO₂", value: "—", unit: "", fraction: null, meta: "No recent reading." });
  assert.equal(byClass(empty, "scan-ring__arc").length, 0);
  assert.equal(byClass(empty, "scan-ring__value")[0].getAttribute("aria-hidden"), null, "without a spoken text the value is read as is");
});

// ---- alert-zones.js / action-plans.js ---------------------------------------------------

test("alert zones: each demonstration rule maps to a known zone with a label; unknown → chest", () => {
  assert.equal(zones.zoneForRule("PHY-01"), "heart");
  assert.equal(zones.zoneForRule("PHY-02"), "lungs");
  assert.equal(zones.zoneForRule("PHY-03"), "arm");
  assert.equal(zones.zoneForRule("PHY-05"), "head");
  assert.equal(zones.zoneForRule("WB-01"), "head");
  assert.equal(zones.zoneForRule("XYZ"), "chest");
  assert.equal(zones.zoneForRule(undefined), "chest");
  for (const z of Object.keys(scan.ZONES)) assert.ok(zones.ZONE_LABELS[z], z);
  for (const z of Object.values(zones.VITAL_ZONES)) assert.ok(scan.ZONES[z], z);
});

test("action plans: synthetic, non-clinical review steps with unique, storable ids", () => {
  assert.match(plans.PLAN_NOTICE, /Synthetic educational content — not medical advice/);
  const BANNED = /\b(diagnos|prescri|medicat|dose|treat(?!ment instructions)|take \d|cure)\w*/i;
  for (const rule of ["PHY-01", "PHY-02", "PHY-03", "PHY-05", "WB-01", "UNKNOWN"]) {
    const plan = plans.planForRule(rule);
    assert.ok(plan.title && plan.steps.length >= 2, rule);
    const stepIds = plan.steps.map((s) => s.id);
    assert.equal(new Set(stepIds).size, stepIds.length, rule);
    for (const s of plan.steps) {
      assert.match(s.id, /^[a-z][a-z0-9-]{0,31}$/);
      assert.doesNotMatch(s.text, BANNED, s.text);
    }
  }
  assert.equal(plans.planForRule("UNKNOWN").title, "Alert review");
  assert.match(plans.VIDEO_PLACEHOLDER.text, /local video files/);
});

// ---- dialog.js -----------------------------------------------------------------------------

function dialog(extra = {}) {
  const host = new FakeElement("body");
  const opener = new FakeElement("button");
  let closed = 0;
  const d = openDialog({ title: "ALT-0190 · Reduced sleep duration", body: ["Body text"], footer: [new FakeElement("button")], returnFocus: opener, onClose: () => { closed += 1; }, host, ...extra });
  return { host, opener, d, closedCount: () => closed };
}

test("dialog: role=dialog + aria-modal, labelled by its focused heading, with a Close button", () => {
  const { host, d } = dialog();
  const backdrop = host.childNodes[0];
  assert.ok(backdrop.classList.includes("modal-backdrop"));
  assert.equal(d.panel.getAttribute("role"), "dialog");
  assert.equal(d.panel.getAttribute("aria-modal"), "true");
  const heading = byId(d.panel, d.panel.getAttribute("aria-labelledby"));
  assert.equal(heading.tagName, "H2");
  assert.equal(heading.textContent, "ALT-0190 · Reduced sleep duration");
  assert.equal(globalThis.document.activeElement, heading, "focus moves into the dialog");
  assert.equal(byClass(d.panel, "dialog__close")[0].getAttribute("aria-label"), "Close");
  assert.ok(d.isOpen());
});

test("dialog: Esc, the Close button and a backdrop click close it once and return focus", () => {
  for (const how of ["escape", "button", "backdrop"]) {
    const { host, opener, d, closedCount } = dialog();
    const backdrop = host.childNodes[0];
    if (how === "escape") backdrop.dispatch("keydown", { key: "Escape" });
    if (how === "button") byClass(d.panel, "dialog__close")[0].click();
    if (how === "backdrop") backdrop.dispatch("click", { target: backdrop });
    assert.equal(host.childNodes.length, 0, how);
    assert.equal(globalThis.document.activeElement, opener, how);
    assert.equal(closedCount(), 1, how);
    d.close();
    assert.equal(closedCount(), 1, "closing twice is harmless");
    assert.equal(d.isOpen(), false);
  }
});

test("dialog: a click inside the panel doesn't close it; kind 'drawer' uses the drawer classes", () => {
  const { host, d } = dialog();
  host.childNodes[0].dispatch("click", { target: d.panel });
  assert.ok(d.isOpen());
  const { host: h2, d: drawer } = dialog({ kind: "drawer" });
  assert.ok(h2.childNodes[0].classList.includes("drawer-backdrop"));
  assert.ok(drawer.panel.classList.includes("drawer"));
});

// ---- core/action-plan-progress.js ----------------------------------------------------------

function storage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}
const ALLOWED = ["recent", "repeat", "review", "contact"];

test("plan progress: per user and per alert, only allowed step ids, in plan order", () => {
  const s = storage();
  const p = createPlanProgress({ storage: () => s });
  assert.deepEqual(p.get("u-reyes", "ALT-0190", ALLOWED), []);
  p.set("u-reyes", "ALT-0190", "review", true, ALLOWED);
  const r = p.set("u-reyes", "ALT-0190", "recent", true, ALLOWED);
  assert.deepEqual(r, { ok: true, done: ["recent", "review"], persisted: true });
  assert.deepEqual(p.get("u-chen", "ALT-0190", ALLOWED), [], "another user sees nothing");
  assert.deepEqual(p.get("u-reyes", "ALT-0189", ALLOWED), [], "another alert sees nothing");
  assert.deepEqual(p.set("u-reyes", "ALT-0190", "review", false, ALLOWED).done, ["recent"]);
  assert.deepEqual(JSON.parse(s.getItem(PROGRESS_KEY)), { "u-reyes": { "ALT-0190": ["recent"] } });
  assert.deepEqual(p.get("u-reyes", "ALT-0190", ["review"]), [], "limited to the current plan's steps");
});

test("plan progress: invalid users, alert numbers and step ids are refused", () => {
  const s = storage();
  const p = createPlanProgress({ storage: () => s });
  assert.equal(p.set("", "ALT-0190", "recent", true, ALLOWED).ok, false);
  assert.equal(p.set("u reyes<", "ALT-0190", "recent", true, ALLOWED).ok, false);
  assert.equal(p.set("u-reyes", "alert-1", "recent", true, ALLOWED).ok, false);
  assert.equal(p.set("u-reyes", "ALT-0190", "inject", true, ALLOWED).ok, false);
  assert.equal(s.getItem(PROGRESS_KEY), null, "nothing was written");
});

test("plan progress: malformed stored data falls back to empty and is cleaned on write", () => {
  for (const bad of ["{not json", "[]", '"x"', JSON.stringify({ "u-reyes": { "ALT-0190": "recent" } }), JSON.stringify({ "bad user!": { "ALT-0190": ["recent"] } })]) {
    const s = storage();
    s.setItem(PROGRESS_KEY, bad);
    const p = createPlanProgress({ storage: () => s });
    assert.deepEqual(p.get("u-reyes", "ALT-0190", ALLOWED), [], bad);
  }
  const s = storage();
  s.setItem(PROGRESS_KEY, JSON.stringify({ "u-reyes": { "ALT-0190": ["recent", "<script>", 5, "recent"], nope: ["x"] } }));
  const p = createPlanProgress({ storage: () => s });
  assert.deepEqual(p.get("u-reyes", "ALT-0190", ALLOWED), ["recent"]);
  p.set("u-reyes", "ALT-0190", "repeat", true, ALLOWED);
  assert.deepEqual(JSON.parse(s.getItem(PROGRESS_KEY)), { "u-reyes": { "ALT-0190": ["recent", "repeat"] } });
});

test("plan progress: blocked storage keeps ticks in memory for this tab and says so", () => {
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() {} };
  for (const getter of [() => blocked, () => { throw new Error("SecurityError"); }, () => null]) {
    const p = createPlanProgress({ storage: getter });
    const r = p.set("u-reyes", "ALT-0190", "recent", true, ALLOWED);
    assert.deepEqual(r, { ok: true, done: ["recent"], persisted: false });
    assert.deepEqual(p.get("u-reyes", "ALT-0190", ALLOWED), ["recent"]);
  }
});

test("pins and hot spots: each severity has its own class; hot spots get a severity ring; legend shows swatch + icon + word", async () => {
  const body = scan.createBodyScan({
    pins: ["critical", "warning", "info"].map((severity, i) => ({ ...PIN, number: i + 1, severity, zone: ["lungs", "head", "arm"][i] })),
    hotspots: [{ zone: "lungs", severity: "critical" }, { zone: "head", severity: "warning" }],
  });
  assert.deepEqual(byClass(body, "scan-pin").map((p) => p.getAttribute("class")), ["scan-pin scan-pin--critical", "scan-pin scan-pin--warning", "scan-pin scan-pin--info"]);
  assert.deepEqual(byClass(body, "scan-pin__sev").map((e) => e.textContent), ["Critical", "Warning", "Info"]);
  assert.equal(byClass(body, "scan-body__hot-ring--critical").length, 1);
  assert.equal(byClass(body, "scan-body__hot-ring--warning").length, 1);
  const { severityLegend } = await import("../../js/components/vitals-stage.js");
  const legend = severityLegend();
  assert.equal(legend.tagName, "UL");
  assert.deepEqual(byTag(legend, "li").map((li) => li.textContent), ["Critical", "Warning", "Info"]);
  assert.ok(byTag(legend, "li").every((li) => byTag(li, "svg").length === 1 && byClass(li, "scan-legend__swatch").length === 1));
});
