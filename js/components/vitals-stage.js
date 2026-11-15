// js/components/vitals-stage.js — SHARED. The body-scan "vitals stage": the
// wireframe body (body-scan.js) with 4 vital rings around it, dashed
// connector lines from each ring to its body zone, and numbered alert pins.
// Used by the astronaut Overview (#/overview) and the Medical Officer's crew
// member view (#/crew/AH-0n), so both show the same picture.
//
//   const stage = createVitalsStage({
//     items,                         // vitals items from a service (key, state, value…)
//     pins: alertPins(alertItems),   // numbered pins for open alerts
//     ringFor: (item) => figure,     // the page builds each ring's text (createRing)
//     onPinClick: (pin, button) => …,
//   });
//
// Presentation only: positions and the ring fill scale carry NO health
// meaning. Every pin must also be listed as text on the page.

import { el } from "../core/utils/dom.js";
import { createBodyScan, BODY_VIEWBOX, zonePoint } from "./body-scan.js";
import { zoneForRule, ZONE_LABELS, VITAL_ZONES } from "./alert-zones.js";

const SVG_NS = "http://www.w3.org/2000/svg";
export const STAGE = Object.freeze({ width: 760, height: 560 });
const BODY_SCALE = STAGE.height / BODY_VIEWBOX.height;
const BODY_LEFT = (STAGE.width - BODY_VIEWBOX.width * BODY_SCALE) / 2;
/** Ring anchor (centre of the dial) in stage units, and the side it sits on. */
export const RING_POSITIONS = Object.freeze({
  sleepDuration: Object.freeze({ x: 112, y: 96, side: "left" }),
  spo2: Object.freeze({ x: 112, y: 340, side: "left" }),
  heartRate: Object.freeze({ x: 648, y: 120, side: "right" }),
  bloodPressure: Object.freeze({ x: 648, y: 352, side: "right" }),
});
/** Fixed display scales for the ring fill (orientation only — no health meaning). */
const RING_SCALES = Object.freeze({
  heartRate: (i) => (i.value - 30) / 150,
  spo2: (i) => (i.value - 80) / 20,
  bloodPressure: (i) => (i.systolic - 70) / 120,
  sleepDuration: (i) => i.value / 10,
});
const SEVERITY_LABEL = Object.freeze({ critical: "Critical", warning: "Warning", info: "Info" });
const pct = (v, total) => `${((v / total) * 100).toFixed(2)}%`;

/** Ring fill 0…1 for a ready item (display scale), or null when there is no value. */
export function ringFraction(item) {
  if (!item || item.state !== "ok" || !RING_SCALES[item.key]) return null;
  const f = RING_SCALES[item.key](item);
  return Number.isFinite(f) ? f : null;
}

/** A zone's point on the stage. */
function stagePoint(zone) {
  const p = zonePoint(zone);
  return { x: BODY_LEFT + p.x * BODY_SCALE, y: p.y * BODY_SCALE };
}

/** Numbered pins for open alerts (same numbers as the page's text list). `who` prefixes the label. */
export function alertPins(alertItems, { who = "" } = {}) {
  return (Array.isArray(alertItems) ? alertItems : []).map((a, i) => {
    const zone = zoneForRule(a.ruleId);
    const severity = SEVERITY_LABEL[a.severity] ? a.severity : "info";
    return {
      number: i + 1,
      zone,
      severity,
      alert: a,
      tag: a.title,
      label: `${who}Alert ${i + 1}: ${[a.number, a.title].filter(Boolean).join(" ")} — ${SEVERITY_LABEL[severity]}, ${ZONE_LABELS[zone] || "body"}. Open details.`,
    };
  });
}

/** Dashed connector lines from each ring to its body zone (decorative). */
function connectors(items) {
  const make = (name, attrs) => {
    const n = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };
  const layer = make("svg", { class: "vitals-stage__links", viewBox: `0 0 ${STAGE.width} ${STAGE.height}`, preserveAspectRatio: "none", "aria-hidden": "true", focusable: "false" });
  for (const item of items) {
    const pos = RING_POSITIONS[item.key];
    if (!pos) continue;
    const to = stagePoint(VITAL_ZONES[item.key]);
    const startX = pos.side === "left" ? pos.x + 64 : pos.x - 64;
    const elbowX = pos.side === "left" ? Math.min(to.x - 24, startX + 60) : Math.max(to.x + 24, startX - 60);
    layer.append(make("path", { class: "vitals-stage__link", d: `M${startX} ${pos.y} L${elbowX.toFixed(1)} ${pos.y} L${to.x.toFixed(1)} ${to.y.toFixed(1)}` }));
    layer.append(make("circle", { class: "vitals-stage__link-dot", cx: to.x.toFixed(1), cy: to.y.toFixed(1), r: 4 }));
  }
  return layer;
}

/** The stage, inside a keyboard-scrollable container (it scrolls sideways on small screens). */
export function createVitalsStage({ items = [], pins = [], ringFor, onPinClick = null }) {
  const placed = items.filter((item) => RING_POSITIONS[item.key]);
  const body = createBodyScan({
    pins,
    hotspots: pins.map((p) => ({ zone: p.zone, severity: p.severity })),
    onPinClick,
  });
  const rings = placed.map((item) => {
    const pos = RING_POSITIONS[item.key];
    const ring = ringFor(item);
    ring.setAttribute("class", `scan-ring vitals-stage__ring vitals-stage__ring--${pos.side}`);
    ring.style.setProperty("left", pct(pos.x, STAGE.width));
    ring.style.setProperty("top", pct(pos.y, STAGE.height));
    return ring;
  });
  const stage = el("div", { class: "vitals-stage" }, [
    connectors(placed),
    el("div", { class: "vitals-stage__body", style: { left: pct(BODY_LEFT, STAGE.width), width: pct(BODY_VIEWBOX.width * BODY_SCALE, STAGE.width) } }, body),
    ...rings,
  ]);
  return el("div", { class: "scan-stage__scroll", tabindex: "0", role: "region", "aria-label": "Body scan stage — scrolls sideways on small screens" }, stage);
}

/** On narrow screens, start every sideways-scrolling stage in `root` centred on the body. */
export function centreStages(root) {
  if (typeof globalThis.requestAnimationFrame !== "function") return;
  globalThis.requestAnimationFrame(() => {
    const boxes = root && root.querySelectorAll ? [...root.querySelectorAll(".scan-stage__scroll")] : [];
    for (const box of boxes) if (box.scrollWidth > box.clientWidth) box.scrollLeft = (box.scrollWidth - box.clientWidth) / 2;
  });
}
