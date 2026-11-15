// js/components/live-chart.js — SHARED. Interactive SVG chart for "Live
// control" in the Simulation Center.
//
//   const chart = createLiveChart({
//     id: "live-spo2", label: "SpO₂", unit: "%", min: 70, max: 100, step: 1,
//     series: [{ key: "spo2", label: "SpO₂", readings: [{ value, timestamp }] }],
//     baseline: 98,                                   // dashed line (or null)
//     rule: { id: "PHY-02", compare: "below", warning: 95, critical: 92 },  // from the service
//     handles: [{ key: "spo2", label: "Next SpO₂ value", value: 97 }],
//     onChange: (key, value) => { … },                // while dragging / on key press
//   });
//   chart.node        the <figure>
//   chart.setValue(key, value)     move a handle from outside (number field)
//   chart.setCurve(values | null)  show 6–12 draggable curve points instead of the single handle
//
// What it shows: stored readings as a line (per series), the personal
// baseline as a dashed line, the demonstration rule's stored limits as
// labelled lines with the rule id (values passed in by the caller from the
// risk engine — never defined here), and draggable handles for the NEXT
// value. The vertical scale is the metric's input range, so a position
// always means the same value.
//
// Handles are role="slider" (aria-valuemin / max / now / text), focusable,
// operated by mouse, touch (pointer events) and keyboard: arrows ± 1 step,
// Shift + arrows ± 5 steps, Page Up / Down ± 10 steps, Home / End.
// Built with document.createElementNS — never innerHTML. Decorative lines
// are aria-hidden; every number is also available as text to the caller.

import { el } from "../core/utils/dom.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const W = 520;
const H = 240;
const PLOT = Object.freeze({ left: 46, right: 506, top: 14, bottom: 204 });
const HISTORY_RIGHT_SINGLE = 400; // readings end here; the "next" handle sits to the right
const HISTORY_RIGHT_CURVE = 250; // in curve mode the curve takes the right-hand part
const NEXT_X = 462;
const COMPARE_SYMBOL = { below: "<", above: ">", atOrAbove: "≥" };

function svg(name, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  for (const c of children) if (c) node.append(c);
  return node;
}
const r1 = (n) => Math.round(n * 10) / 10;

/** Round to the step grid and clamp. Pure. */
export function snapValue(value, { min, max, step }) {
  if (typeof value !== "number" || !Number.isFinite(value)) return min;
  const clamped = Math.min(max, Math.max(min, value));
  const snapped = Math.round(clamped / step) * step;
  return Math.min(max, Math.max(min, Math.round(snapped * 10) / 10));
}

/** New value after a key press on a handle, or null when the key isn't handled. Pure. */
export function keyStep(key, shiftKey, value, { min, max, step }) {
  const big = shiftKey ? 5 : 1;
  const delta =
    key === "ArrowUp" || key === "ArrowRight" ? step * big
      : key === "ArrowDown" || key === "ArrowLeft" ? -step * big
        : key === "PageUp" ? step * 10
          : key === "PageDown" ? -step * 10
            : null;
  if (key === "Home") return min;
  if (key === "End") return max;
  if (delta === null) return null;
  return snapValue(value + delta, { min, max, step });
}

export function createLiveChart({ id, label, unit, min, max, step = 1, series = [], baseline = null, rule = null, handles = [], onChange = null, onCurveChange = null, disabled = false }) {
  const range = { min, max, step };
  const yOf = (v) => PLOT.bottom - ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * (PLOT.bottom - PLOT.top);
  const valueAt = (y) => min + ((PLOT.bottom - y) / (PLOT.bottom - PLOT.top)) * (max - min);
  const text = (v) => `${Number.isInteger(v) ? v : r1(v)} ${unit}`;
  let curveValues = null;

  const root = svg("svg", { class: "live-chart__svg", viewBox: `0 0 ${W} ${H}`, role: "group", "aria-label": `${label} chart`, focusable: "false" });

  // ---- static layers -------------------------------------------------------------------
  const grid = svg("g", { class: "live-chart__grid", "aria-hidden": "true" });
  const ticks = 4;
  for (let i = 0; i <= ticks; i += 1) {
    const v = min + ((max - min) * i) / ticks;
    const y = yOf(v);
    grid.append(svg("line", { x1: PLOT.left, y1: r1(y), x2: PLOT.right, y2: r1(y) }));
    const t = svg("text", { class: "live-chart__tick", x: PLOT.left - 6, y: r1(y + 4), "text-anchor": "end" });
    t.textContent = String(Number.isInteger(v) ? v : r1(v));
    grid.append(t);
  }

  // Rule limits (labelled with the rule id) — values come from the caller.
  const limits = svg("g", { class: "live-chart__limits", "aria-hidden": "true" });
  if (rule && typeof rule.warning === "number") {
    const sym = COMPARE_SYMBOL[rule.compare] || "";
    const below = rule.compare === "below";
    const edge = below ? PLOT.bottom : PLOT.top;
    const band = (from, cls) => {
      const y1 = yOf(from);
      limits.append(svg("rect", { class: `live-chart__band ${cls}`, x: PLOT.left, y: r1(Math.min(y1, edge)), width: PLOT.right - PLOT.left, height: r1(Math.abs(edge - y1)) }));
    };
    band(rule.warning, "live-chart__band--warning");
    if (typeof rule.critical === "number") band(rule.critical, "live-chart__band--critical");
    const line = (value, tier) => {
      const y = r1(yOf(value));
      limits.append(svg("line", { class: `live-chart__limit live-chart__limit--${tier}`, x1: PLOT.left, y1: y, x2: PLOT.right, y2: y }));
      const t = svg("text", { class: `live-chart__limit-label live-chart__limit-label--${tier}`, x: PLOT.left + 6, y: r1(below ? y + 12 : y - 5) });
      t.textContent = `${rule.id} ${tier} ${sym} ${text(value)}`;
      limits.append(t);
    };
    line(rule.warning, "warning");
    if (typeof rule.critical === "number") line(rule.critical, "critical");
  }

  const base = svg("g", { class: "live-chart__baseline", "aria-hidden": "true" });
  if (typeof baseline === "number" && Number.isFinite(baseline)) {
    const y = r1(yOf(baseline));
    base.append(svg("line", { x1: PLOT.left, y1: y, x2: PLOT.right, y2: y }));
    const t = svg("text", { class: "live-chart__baseline-label", x: PLOT.right - 4, y: y - 5, "text-anchor": "end" });
    t.textContent = `baseline ${text(baseline)}`;
    base.append(t);
  }

  const history = svg("g", { class: "live-chart__history", "aria-hidden": "true" });
  const joins = svg("g", { class: "live-chart__joins", "aria-hidden": "true" });
  const handleLayer = svg("g", { class: "live-chart__handles" });
  const curveLayer = svg("g", { class: "live-chart__curve" });
  root.append(grid, limits, base, history, joins, curveLayer, handleLayer);

  const lastPoint = new Map(); // series key → {x, y} of its newest reading

  function drawHistory() {
    history.replaceChildren();
    lastPoint.clear();
    const right = curveValues ? HISTORY_RIGHT_CURVE : HISTORY_RIGHT_SINGLE;
    series.forEach((s, si) => {
      const items = Array.isArray(s.readings) ? s.readings : [];
      if (!items.length) return;
      const n = items.length;
      const xOf = (i) => (n === 1 ? right : PLOT.left + ((right - PLOT.left) * i) / (n - 1));
      const d = items.map((r, i) => `${i ? "L" : "M"}${r1(xOf(i))} ${r1(yOf(r.value))}`).join(" ");
      history.append(svg("path", { class: `live-chart__line live-chart__line--${si}`, d }));
      const last = items[n - 1];
      history.append(svg("circle", { class: `live-chart__dot live-chart__dot--${si}`, cx: r1(xOf(n - 1)), cy: r1(yOf(last.value)), r: 3.5 }));
      lastPoint.set(s.key, { x: xOf(n - 1), y: yOf(last.value) });
    });
  }

  // ---- draggable handles ----------------------------------------------------------------
  /** One slider handle at a fixed x. `apply(value)` stores the value; returns { node, set }. */
  function makeHandle({ x, name, value, cls, apply }) {
    let current = snapValue(value, range);
    const dot = svg("circle", { class: "live-chart__handle-dot", cx: r1(x), cy: r1(yOf(current)), r: 9 });
    const hit = svg("circle", { class: "live-chart__handle-hit", cx: r1(x), cy: r1(yOf(current)), r: 22 }); // ≥ 44 px target
    const tag = svg("text", { class: "live-chart__handle-value", x: r1(x), y: r1(yOf(current) - 15), "text-anchor": "middle", "aria-hidden": "true" });
    tag.textContent = text(current);
    const node = svg("g", {
      class: `live-chart__handle ${cls || ""}`.trim(),
      role: "slider",
      tabindex: disabled ? "-1" : "0",
      "aria-label": name,
      "aria-orientation": "vertical",
      "aria-valuemin": min,
      "aria-valuemax": max,
      "aria-valuenow": current,
      "aria-valuetext": text(current),
      "aria-disabled": disabled ? "true" : null,
    }, [hit, dot, tag]);

    function set(next, notify) {
      const v = snapValue(next, range);
      if (v === current && notify) return;
      current = v;
      const y = r1(yOf(v));
      dot.setAttribute("cy", y);
      hit.setAttribute("cy", y);
      tag.setAttribute("y", r1(y - 15));
      tag.textContent = text(v);
      node.setAttribute("aria-valuenow", String(v));
      node.setAttribute("aria-valuetext", text(v));
      if (notify) apply(v);
      redrawJoins();
    }

    if (!disabled) {
      node.addEventListener("keydown", (e) => {
        const next = keyStep(e.key, e.shiftKey === true, current, range);
        if (next === null) return;
        if (typeof e.preventDefault === "function") e.preventDefault();
        set(next, true);
      });
      let dragging = false;
      const fromPointer = (e) => {
        const box = typeof root.getBoundingClientRect === "function" ? root.getBoundingClientRect() : null;
        if (!box || !box.height) return;
        set(valueAt(((e.clientY - box.top) / box.height) * H), true);
      };
      node.addEventListener("pointerdown", (e) => {
        dragging = true;
        if (typeof node.setPointerCapture === "function" && e.pointerId !== undefined) {
          try { node.setPointerCapture(e.pointerId); } catch { /* not capturable: dragging still works over the handle */ }
        }
        if (typeof node.focus === "function") node.focus();
        if (typeof e.preventDefault === "function") e.preventDefault();
        fromPointer(e);
      });
      node.addEventListener("pointermove", (e) => { if (dragging) fromPointer(e); });
      const end = () => { dragging = false; };
      node.addEventListener("pointerup", end);
      node.addEventListener("pointercancel", end);
    }
    return { node, set, get: () => current, x };
  }

  const single = new Map(); // handle key → handle
  let curveHandles = [];

  function redrawJoins() {
    joins.replaceChildren();
    if (curveValues) {
      const first = lastPoint.get(series[0] && series[0].key);
      const pts = curveHandles.map((h) => `${r1(h.x)} ${r1(yOf(h.get()))}`);
      if (pts.length) joins.append(svg("path", { class: "live-chart__join live-chart__join--curve", d: `M${first ? `${r1(first.x)} ${r1(first.y)} L` : ""}${pts.join(" L")}` }));
      return;
    }
    for (const [key, h] of single) {
      const from = lastPoint.get(key);
      if (from) joins.append(svg("line", { class: "live-chart__join", x1: r1(from.x), y1: r1(from.y), x2: r1(h.x), y2: r1(yOf(h.get())) }));
    }
  }

  function drawHandles() {
    handleLayer.replaceChildren();
    curveLayer.replaceChildren();
    single.clear();
    curveHandles = [];
    if (curveValues) {
      const n = curveValues.length;
      const left = HISTORY_RIGHT_CURVE + 28;
      curveValues.forEach((v, i) => {
        const x = n === 1 ? NEXT_X : left + ((PLOT.right - 14 - left) * i) / (n - 1);
        const h = makeHandle({
          x, value: v, cls: "live-chart__handle--curve",
          name: `${label} curve point ${i + 1} of ${n}`,
          apply: (value) => {
            curveValues[i] = value;
            if (typeof onCurveChange === "function") onCurveChange(i, value, [...curveValues]);
          },
        });
        curveHandles.push(h);
        curveLayer.append(h.node);
      });
    } else {
      handles.forEach((hd, i) => {
        const h = makeHandle({
          x: NEXT_X + (handles.length > 1 ? (i === 0 ? -14 : 14) : 0),
          value: hd.value,
          cls: `live-chart__handle--${i}`,
          name: hd.label,
          apply: (value) => { if (typeof onChange === "function") onChange(hd.key, value); },
        });
        single.set(hd.key, h);
        handleLayer.append(h.node);
      });
    }
    redrawJoins();
  }

  drawHistory();
  drawHandles();

  const node = el("figure", { class: ["live-chart", disabled ? "is-disabled" : ""], id, "aria-label": `${label} — recent readings, baseline, rule limits and the next value` }, [root]);

  return {
    node,
    /** Move a single handle (e.g. from the number field). Doesn't call onChange. */
    setValue(key, value) {
      const h = single.get(key);
      if (h) h.set(value, false);
    },
    getValue: (key) => (single.get(key) ? single.get(key).get() : null),
    /** Curve mode on (array of 6–12 values) or off (null). */
    setCurve(values) {
      curveValues = Array.isArray(values) ? values.map((v) => snapValue(v, range)) : null;
      drawHistory();
      drawHandles();
    },
    getCurve: () => (curveValues ? curveHandles.map((h) => h.get()) : null),
    handleNodes: () => (curveValues ? curveHandles.map((h) => h.node) : [...single.values()].map((h) => h.node)),
  };
}
