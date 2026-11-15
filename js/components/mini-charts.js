// js/components/mini-charts.js — SHARED. Small, interactive, dependency-free
// charts drawn with SVG + el() (no chart library, works offline and in tests):
//
//   severityBar({ counts: { critical, warning, info } })      stacked bar + legend
//   sparkline({ points: [{ date, value|null }], baseline, unit, label, decimals })
//   barList({ items: [{ label, value, href? }], unit, max? })  horizontal bars (links)
//
// Every chart has a text equivalent (legend, visible readout or sr-only text),
// so nothing relies on colour alone. Missing days are gaps, never zero.
// Severity colours follow the design rules: critical raspberry, warning amber,
// info blue — red is never used for a health state.

import { el } from "../core/utils/dom.js";
import { icon } from "./icon.js";
import { formatNumber } from "../core/utils/format.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const svg = (name, attrs = {}, children = []) => {
  const n = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) n.setAttribute(k, String(v));
  for (const c of children) if (c) n.append(c);
  return n;
};
const SEVERITIES = Object.freeze([
  { key: "critical", label: "Critical", icon: "circle-alert" },
  { key: "warning", label: "Warning", icon: "triangle-alert" },
  { key: "info", label: "Info", icon: "info" },
]);
const shortDate = (key) => {
  const d = new Date(`${key}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? key : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
};

/** Stacked bar of open alerts by severity, with an icon + word + number legend. */
export function severityBar({ counts, id = "sev-bar" }) {
  const c = counts || {};
  const total = SEVERITIES.reduce((n, s) => n + (Number(c[s.key]) || 0), 0);
  return el("div", { class: "mc-sev", "data-chart": "severity" }, [
    el("div", { class: "mc-sev__bar", role: "img", "aria-label": total ? SEVERITIES.map((s) => `${c[s.key] || 0} ${s.label.toLowerCase()}`).join(", ") : "No open alerts", id },
      total
        ? SEVERITIES.filter((s) => c[s.key]).map((s) => el("span", { class: `mc-sev__seg mc-sev__seg--${s.key}`, style: { "flex-grow": String(c[s.key]) }, title: `${s.label}: ${c[s.key]}` }))
        : [el("span", { class: "mc-sev__seg mc-sev__seg--none" })]),
    el("ul", { class: "mc-sev__legend", role: "list" }, SEVERITIES.map((s) => el("li", { class: `mc-sev__item mc-sev__item--${s.key}` }, [
      icon(s.icon, { size: 14 }),
      el("span", {}, s.label),
      el("strong", { class: "mc-sev__num" }, String(c[s.key] || 0)),
    ]))),
  ]);
}

/**
 * Sparkline with a dashed baseline. Points are focusable; hovering or focusing
 * one shows "date · value unit" in the readout below the line.
 */
export function sparkline({ points = [], baseline = null, unit = "", label = "", decimals = 0, width = 168, height = 48 }) {
  const values = points.map((p) => p.value).filter((v) => typeof v === "number");
  const readout = el("span", { class: "mc-spark__readout", "aria-live": "polite" });
  if (!values.length) return el("div", { class: "mc-spark mc-spark--empty" }, el("span", { class: "mc-spark__readout" }, "No data in the last 7 days"));
  const all = baseline === null ? values : [...values, baseline];
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = 6;
  const x = (i) => pad + (i * (width - 2 * pad)) / Math.max(1, points.length - 1);
  const y = (v) => height - pad - ((v - lo) / (hi - lo)) * (height - 2 * pad);
  const fmt = (v) => `${formatNumber(v, decimals)}${unit ? ` ${unit}` : ""}`;

  // Line segments break at missing days (a gap, never a zero).
  const segments = [];
  let cur = [];
  points.forEach((p, i) => {
    if (typeof p.value === "number") cur.push(`${x(i).toFixed(1)},${y(p.value).toFixed(1)}`);
    else if (cur.length) { segments.push(cur); cur = []; }
  });
  if (cur.length) segments.push(cur);
  const last = [...points].reverse().find((p) => typeof p.value === "number");
  const resetReadout = () => { readout.textContent = `${shortDate(last.date)} · ${fmt(last.value)}`; };

  const dots = points.map((p, i) => {
    if (typeof p.value !== "number") return null;
    const text = `${label ? `${label}, ` : ""}${shortDate(p.date)}: ${fmt(p.value)}`;
    const show = () => { readout.textContent = `${shortDate(p.date)} · ${fmt(p.value)}`; };
    const dot = svg("circle", { class: "mc-spark__dot", cx: x(i).toFixed(1), cy: y(p.value).toFixed(1), r: 3.5, tabindex: "0", role: "img", "aria-label": text }, [svg("title", {}, [document.createTextNode(text)])]);
    dot.addEventListener("mouseenter", show);
    dot.addEventListener("focus", show);
    dot.addEventListener("mouseleave", resetReadout);
    dot.addEventListener("blur", resetReadout);
    return dot;
  });

  const chart = svg("svg", { class: "mc-spark__svg", viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", focusable: "false" }, [
    baseline !== null ? svg("line", { class: "mc-spark__base", x1: pad, x2: width - pad, y1: y(baseline).toFixed(1), y2: y(baseline).toFixed(1) }) : null,
    ...segments.map((s) => svg("polyline", { class: "mc-spark__line", points: s.join(" ") })),
    ...dots,
  ]);
  resetReadout();
  return el("div", { class: "mc-spark", "data-chart": "sparkline" }, [chart, readout]);
}

/** Horizontal bars, one per item; an item with `href` is a link. */
export function barList({ items = [], unit = "", max = null }) {
  const top = max !== null ? max : Math.max(1, ...items.map((i) => (typeof i.value === "number" ? i.value : 0)));
  return el("ul", { class: "mc-bars", role: "list", "data-chart": "bars" }, items.map((it) => {
    const known = typeof it.value === "number";
    const pct = known ? Math.max(2, Math.round((it.value / top) * 100)) : 0;
    const inner = [
      el("span", { class: "mc-bars__label" }, it.label),
      el("span", { class: "mc-bars__track", "aria-hidden": "true" }, el("span", { class: "mc-bars__fill", style: { width: `${pct}%` } })),
      el("span", { class: "mc-bars__value" }, known ? `${formatNumber(it.value, 0)}${unit ? ` ${unit}` : ""}` : "Couldn't load"),
    ];
    return el("li", {}, it.href ? el("a", { class: "mc-bars__row mc-bars__row--link", href: it.href }, inner) : el("div", { class: "mc-bars__row" }, inner));
  }));
}
