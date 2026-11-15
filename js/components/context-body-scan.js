// Shared page-aware body scan. Callers pass authorized presentation data;
// this component never reads storage or evaluates health.
import { createBodyScan } from "./body-scan.js";
import { icon } from "./icon.js";
import { el } from "../core/utils/dom.js";

function activate(pin) {
  if (pin.href && globalThis.location) {
    globalThis.location.hash = pin.href.replace(/^#/, "");
    return;
  }
  if (!pin.targetId || !globalThis.document) return;
  const target = document.getElementById(pin.targetId) || document.querySelector(`[data-scan-target="${pin.targetId}"]`);
  target?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  target?.focus?.({ preventScroll: true });
}

export function createContextBodyScan({ id, title, description, pins = [], crop = "full", compact = false, eyebrow = "Interactive body map", note = "Select a numbered point to move to its related information." } = {}) {
  const safePins = Array.isArray(pins) ? pins.filter(Boolean) : [];
  const scan = createBodyScan({ crop, pins: safePins, hotspots: safePins, onPinClick: activate });
  const key = safePins.length
    ? el("ol", { class: "context-scan__key", role: "list" }, safePins.map((pin) => el("li", { class: "context-scan__key-item" },
        el("button", { class: "context-scan__key-button", type: "button", onClick: () => activate(pin), "aria-label": pin.label }, [
          el("span", { class: ["context-scan__key-number", `context-scan__key-number--${pin.severity || "info"}`], "aria-hidden": "true" }, String(pin.number)),
          el("span", {}, pin.tag || pin.label), icon("arrow-right", { size: 15 }),
        ]))))
    : el("p", { class: "context-scan__empty" }, "Nothing is marked on the body for this view.");
  return el("section", { class: ["context-scan", compact ? "context-scan--compact" : ""], "aria-labelledby": id }, [
    el("div", { class: "context-scan__visual" }, [
      el("div", { class: "context-scan__visual-head" }, [el("span", { class: "context-scan__eyebrow" }, [icon("activity", { size: 15 }), eyebrow]), el("span", { class: "sim-tag" }, "Synthetic data")]),
      scan,
    ]),
    el("div", { class: "context-scan__content" }, [
      el("h3", { class: "context-scan__title", id }, title),
      el("p", { class: "context-scan__description" }, description), key,
      note ? el("p", { class: "context-scan__note" }, note) : null,
    ]),
  ]);
}
