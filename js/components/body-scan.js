// js/components/body-scan.js — SHARED. The dark "scan stage" wireframe body.
//
//   import { createBodyScan, createRing, scanStage, zonePoint } from "../components/body-scan.js";
//   const body = createBodyScan({
//     crop: "full",                       // or "upper" (head to waist)
//     pins: [{ number: 1, zone: "chest", severity: "critical", label: "ALT-0191 Low SpO₂, critical", tag: "Low SpO₂" }],
//     hotspots: [{ zone: "chest", severity: "critical" }],
//     onPinClick: (pin, button) => { … },
//   });
//
// The body is a stylised, purely decorative illustration (aria-hidden): a
// glowing cyan outline, horizontal + vertical mesh lines clipped to the
// silhouette (a simple "3D" wireframe look), a glow filter, a slow scan line
// and a floor ring. It conveys NO health information by itself.
// Pins are real <button>s (≥ 44 px, aria-label, number + text tag) laid over
// the drawing; every pin must also exist as a text list elsewhere on the page.
// Built with document.createElementNS — never innerHTML. Unique SVG ids per
// instance. Animations stop under prefers-reduced-motion and the personal
// "Reduce motion" preference (CSS in css/components.css).

import { el } from "../core/utils/dom.js";

const SVG_NS = "http://www.w3.org/2000/svg";
export const BODY_VIEWBOX = Object.freeze({ width: 300, height: 640 });
const UPPER_HEIGHT = 340;

/** Named zones in body coordinates (front view; "arm" is the figure's left arm, on the viewer's right). */
export const ZONES = Object.freeze({
  head: Object.freeze({ x: 150, y: 62, label: "Head" }),
  chest: Object.freeze({ x: 150, y: 176, label: "Chest" }),
  heart: Object.freeze({ x: 166, y: 184, label: "Heart" }),
  lungs: Object.freeze({ x: 132, y: 172, label: "Lungs" }),
  arm: Object.freeze({ x: 238, y: 300, label: "Arm" }),
  abdomen: Object.freeze({ x: 150, y: 252, label: "Abdomen" }),
  "lower-back": Object.freeze({ x: 150, y: 306, label: "Lower back" }),
  legs: Object.freeze({ x: 150, y: 470, label: "Legs" }),
});

/** {x, y} of a zone in body coordinates (unknown zone → chest). */
export function zonePoint(zone) {
  const z = ZONES[zone] || ZONES.chest;
  return { x: z.x, y: z.y };
}

// Left half of the silhouette, from the neck down around the arm and leg to
// the crotch. The right half is the mirror image. Smoothed with Catmull-Rom.
const LEFT_OUTLINE = [
  [138, 100], [136, 120], [112, 128], [90, 136], [78, 152], [70, 190], [64, 232], [58, 268], [52, 310], [48, 350],
  [46, 372], [42, 392], [44, 410], [52, 420], [60, 414], [62, 396], [64, 376], [70, 330], [76, 290], [80, 262],
  [86, 220], [96, 176], [98, 200], [100, 240], [104, 280], [102, 312], [96, 344], [100, 400], [104, 450], [108, 476],
  [110, 520], [112, 560], [114, 592], [106, 612], [108, 624], [130, 628], [142, 622], [140, 600], [138, 560], [138, 520],
  [138, 476], [142, 430], [146, 392], [150, 374],
];

const r1 = (n) => Math.round(n * 10) / 10;

/** Closed Catmull-Rom → cubic Bézier path through the points. Pure. */
export function smoothClosedPath(points) {
  const n = points.length;
  let d = `M${r1(points[0][0])} ${r1(points[0][1])}`;
  for (let i = 0; i < n; i += 1) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${r1(c1[0])} ${r1(c1[1])} ${r1(c2[0])} ${r1(c2[1])} ${r1(p2[0])} ${r1(p2[1])}`;
  }
  return `${d} Z`;
}

/** The full body outline (without the head). Pure, deterministic. */
export function bodyOutlinePath() {
  const right = LEFT_OUTLINE.slice(0, -1).map(([x, y]) => [BODY_VIEWBOX.width - x, y]).reverse();
  return smoothClosedPath([...LEFT_OUTLINE, ...right]);
}

const OUTLINE = bodyOutlinePath();
let instances = 0;

/** createElementNS helper: attributes only, children appended. */
function svg(name, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  for (const c of children) if (c) node.append(c);
  return node;
}

/**
 * The wireframe body with optional hot spots and pins.
 * @param {{ crop?: "full"|"upper", pins?: Array, hotspots?: Array, onPinClick?: Function, className?: string }} options
 * @returns {HTMLElement} div.scan-body
 */
export function createBodyScan({ crop = "full", pins = [], hotspots = [], onPinClick = null, className = "" } = {}) {
  instances += 1;
  const id = `ahscan${instances}`;
  const height = crop === "upper" ? UPPER_HEIGHT : BODY_VIEWBOX.height;

  const defs = svg("defs", {}, [
    svg("clipPath", { id: `${id}-clip` }, [svg("path", { d: OUTLINE }), svg("ellipse", { cx: 150, cy: 62, rx: 34, ry: 42 })]),
    svg("filter", { id: `${id}-glow`, x: "-30%", y: "-10%", width: "160%", height: "120%" }, [
      svg("feGaussianBlur", { in: "SourceGraphic", stdDeviation: "3", result: "blur" }),
      svg("feMerge", {}, [svg("feMergeNode", { in: "blur" }), svg("feMergeNode", { in: "SourceGraphic" })]),
    ]),
    svg("linearGradient", { id: `${id}-scan`, x1: "0", y1: "0", x2: "0", y2: "1" }, [
      svg("stop", { offset: "0", class: "scan-body__scan-stop scan-body__scan-stop--clear" }),
      svg("stop", { offset: "0.85", class: "scan-body__scan-stop scan-body__scan-stop--soft" }),
      svg("stop", { offset: "1", class: "scan-body__scan-stop scan-body__scan-stop--line" }),
    ]),
    ...["critical", "warning", "info"].map((sev) => svg("radialGradient", { id: `${id}-hot-${sev}` }, [
      svg("stop", { offset: "0", class: `scan-body__hot-stop scan-body__hot-stop--${sev} scan-body__hot-stop--core` }),
      svg("stop", { offset: "1", class: `scan-body__hot-stop scan-body__hot-stop--${sev} scan-body__hot-stop--edge` }),
    ])),
  ]);

  // Background grid (behind the body).
  const grid = svg("g", { class: "scan-body__grid" });
  for (let x = 0; x <= 300; x += 30) grid.append(svg("line", { x1: x, y1: 0, x2: x, y2: height }));
  for (let y = 0; y <= height; y += 30) grid.append(svg("line", { x1: 0, y1: y, x2: 300, y2: y }));

  // Mesh clipped to the silhouette: horizontal rings + curved vertical lines.
  const mesh = svg("g", { class: "scan-body__mesh", "clip-path": `url(#${id}-clip)` });
  for (let y = 26; y <= 630; y += 16) mesh.append(svg("ellipse", { cx: 150, cy: y, rx: 140, ry: 5 }));
  for (let k = -6; k <= 6; k += 1) {
    const x = 150 + k * 20;
    mesh.append(svg("path", { d: `M${x} 0 Q${150 + k * 24} 320 ${x} 640` }));
  }
  const fill = svg("g", { class: "scan-body__fill", "clip-path": `url(#${id}-clip)` }, [svg("rect", { x: 0, y: 0, width: 300, height: 640 })]);

  // Hot spots (soft glows at zones).
  const hot = svg("g", { class: "scan-body__hotspots" });
  for (const h of Array.isArray(hotspots) ? hotspots : []) {
    const p = zonePoint(h.zone);
    const sev = ["critical", "warning", "info"].includes(h.severity) ? h.severity : "info";
    hot.append(svg("circle", { cx: p.x, cy: p.y, r: 30, fill: `url(#${id}-hot-${sev})`, class: `scan-body__hotspot scan-body__hotspot--${sev}` }));
  }

  // Outline with glow, plus a scan line sweeping inside the silhouette.
  const outline = svg("g", { class: "scan-body__outline", filter: `url(#${id}-glow)` }, [
    svg("path", { d: OUTLINE }),
    svg("ellipse", { cx: 150, cy: 62, rx: 34, ry: 42 }),
  ]);
  const scan = svg("g", { "clip-path": `url(#${id}-clip)` }, [
    svg("g", { class: "scan-body__scanline" }, [svg("rect", { x: 0, y: -40, width: 300, height: 40, fill: `url(#${id}-scan)` })]),
  ]);
  const floor = crop === "upper" ? null : svg("g", { class: "scan-body__floor" }, [
    svg("ellipse", { cx: 150, cy: 630, rx: 96, ry: 9 }),
    svg("ellipse", { cx: 150, cy: 630, rx: 64, ry: 5 }),
  ]);

  const drawing = svg("svg", {
    class: "scan-body__svg",
    viewBox: `0 0 ${BODY_VIEWBOX.width} ${height}`,
    preserveAspectRatio: "xMidYMid meet",
    "aria-hidden": "true",
    focusable: "false",
  }, [defs, grid, fill, mesh, hot, outline, scan, floor]);

  const root = el("div", { class: ["scan-body", crop === "upper" ? "scan-body--upper" : "", className], style: { "--scan-aspect": `${BODY_VIEWBOX.width} / ${height}` } }, [drawing]);

  // Pins: real buttons positioned in % of the drawing; several pins on one zone stack downwards.
  const perZone = new Map();
  for (const pin of Array.isArray(pins) ? pins : []) {
    const p = zonePoint(pin.zone);
    const k = perZone.get(pin.zone) || 0;
    perZone.set(pin.zone, k + 1);
    const left = (p.x / BODY_VIEWBOX.width) * 100;
    const top = ((p.y + k * 30) / height) * 100;
    if (top > 100) continue;
    const button = el("button", {
      type: "button",
      class: ["scan-pin", `scan-pin--${["critical", "warning", "info"].includes(pin.severity) ? pin.severity : "info"}`],
      style: { left: `${left.toFixed(2)}%`, top: `${top.toFixed(2)}%` },
      "aria-label": pin.label,
      "data-pin": String(pin.number),
    }, [
      el("span", { class: "scan-pin__pulse", "aria-hidden": "true" }),
      el("span", { class: "scan-pin__num", "aria-hidden": "true" }, String(pin.number)),
      pin.tag ? el("span", { class: "scan-pin__tag", "aria-hidden": "true" }, pin.tag) : null,
    ]);
    if (typeof onPinClick === "function") button.addEventListener("click", () => onPinClick(pin, button));
    root.append(button);
  }
  return root;
}

/**
 * A circular ring gauge for the scan stage. `fraction` (0…1) is a FIXED
 * DISPLAY SCALE only — it carries no health meaning and no status colour.
 * Text (value, unit, baseline, tags) is real text, not SVG text. With
 * `spoken`, the visual value is hidden from screen readers and the spoken
 * sentence is read instead. `extra` is appended to the caption (e.g. a link).
 */
export function createRing({ id, label, value, unit, fraction = null, baseline = "", meta = "", tags = [], spoken = "", extra = null }) {
  const R = 44;
  const C = 2 * Math.PI * R;
  const f = typeof fraction === "number" && Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : null;
  const dial = svg("svg", { class: "scan-ring__dial", viewBox: "0 0 100 100", "aria-hidden": "true", focusable: "false" }, [
    svg("circle", { class: "scan-ring__track", cx: 50, cy: 50, r: R }),
    f === null ? null : svg("circle", { class: "scan-ring__arc", cx: 50, cy: 50, r: R, "stroke-dasharray": `${r1(C * f)} ${r1(C)}`, transform: "rotate(-90 50 50)" }),
  ]);
  return el("figure", { class: "scan-ring", id, "aria-labelledby": `${id}-label` }, [
    el("div", { class: "scan-ring__face" }, [
      dial,
      el("p", { class: "scan-ring__value", "aria-hidden": spoken ? "true" : null }, [el("span", { class: "scan-ring__number" }, value), unit ? el("span", { class: "scan-ring__unit" }, unit) : null]),
    ]),
    el("figcaption", { class: "scan-ring__caption" }, [
      el("span", { class: "scan-ring__label", id: `${id}-label` }, label),
      baseline ? el("span", { class: "scan-ring__baseline" }, baseline) : null,
      meta ? el("span", { class: "scan-ring__meta" }, meta) : null,
      spoken ? el("span", { class: "sr-only" }, spoken) : null,
      tags.length ? el("span", { class: "scan-ring__tags" }, tags) : null,
      extra,
    ]),
  ]);
}

/** The dark stage card. `label` names the region for assistive technology. */
export function scanStage({ id, label, className = "" }, children) {
  return el("section", { class: ["scan-stage", className], "aria-label": label, id }, children);
}
