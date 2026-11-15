// js/components/alert-popup.js — SHARED. The body of the alert pop-up opened
// from a body-scan pin or an alert list (astronaut Overview and the Medical
// Officer's crew member view).
//
//   const detail = await loadAlertDetailSafely(loader, session, number); // null on any failure
//   openDialog({ kind: "modal", title: alertTitle(alert), body: alertPopupBody({ alert, detail, pinNumber }), … });
//
// Shows severity (icon + word), status, body location, detection time, the
// rule and threshold, what was detected, the demonstration limitation and
// the last 3 readings. When the detail can't be loaded it says so and never
// invents readings. Text only (el()) — never innerHTML.

import { icon } from "./icon.js";
import { el } from "../core/utils/dom.js";
import { formatNumber } from "../core/utils/format.js";
import { utcTime, SEVERITY_VIEW } from "./crew-view.js";
import { zoneForRule, ZONE_LABELS } from "./alert-zones.js";

const STATUS_LABEL = Object.freeze({ new: "New", acknowledged: "Acknowledged", resolved: "Resolved" });
const FALLBACK_LIMITATION = "Demonstration threshold — not clinically validated. Not a diagnosis.";
const badge = (className, iconName, text) => el("span", { class: ["badge", className] }, [icon(iconName), text]);

/** "ALT-0190 · Reduced sleep duration" */
export const alertTitle = (a) => [a.number, a.title].filter(Boolean).join(" · ");

/** The alerts-service detail result when ready, otherwise null (errors are swallowed). */
export async function loadAlertDetailSafely(loader, session, number) {
  if (typeof loader !== "function" || !number) return null;
  try {
    const res = await loader(session, number);
    return res && res.status === "ready" ? res : null;
  } catch {
    return null;
  }
}

/** Nodes for the pop-up body. `alert` is the listed alert; `detail` the service detail or null. */
export function alertPopupBody({ alert, detail = null, pinNumber = 0, who = "" }) {
  const a = detail ? detail.alert : alert;
  const view = SEVERITY_VIEW[a.severity] || SEVERITY_VIEW.info;
  const zone = zoneForRule(a.ruleId || alert.ruleId || (detail && a.rule && a.rule.id));
  const rule = detail && a.rule && a.rule.id ? a.rule : null;
  const evidence = detail && Array.isArray(a.evidence) ? a.evidence.slice(-3).reverse() : [];
  const limitation = detail
    ? (a.limitation.startsWith(detail.thresholdLabel) ? a.limitation : `${detail.thresholdLabel} ${a.limitation}`)
    : FALLBACK_LIMITATION;
  return [
    el("p", { class: "alert-pop__tags" }, [
      badge(view.badge, view.icon, view.label),
      badge("badge--neutral", "clock", STATUS_LABEL[a.status] || a.status),
      el("span", { class: "sim-tag" }, "Synthetic"),
    ]),
    el("dl", { class: "alert-pop__facts" }, [
      who ? [el("dt", {}, "Crew member"), el("dd", {}, who)] : null,
      el("dt", {}, "Body location"), el("dd", {}, `${ZONE_LABELS[zone] || "Body"}${pinNumber ? ` (pin ${pinNumber})` : ""}`),
      el("dt", {}, "Detected"), el("dd", {}, utcTime(a.detectedAt)),
      rule ? [el("dt", {}, "Rule"), el("dd", {}, `${rule.id}${rule.version ? ` · version ${rule.version}` : ""}${rule.thresholdUsed ? ` — ${rule.thresholdUsed}` : ""}`)] : null,
    ]),
    el("h3", { class: "alert-pop__h3" }, "What was detected"),
    el("p", {}, a.explanation || "No explanation stored."),
    el("p", { class: "alert-pop__note" }, limitation),
    evidence.length ? el("h3", { class: "alert-pop__h3" }, "Key readings") : null,
    evidence.length
      ? el("ul", { class: "alert-pop__readings", role: "list" }, evidence.map((e) => el("li", {}, [
          el("strong", {}, e.valueHidden || typeof e.value !== "number" ? e.label : `${e.label} ${formatNumber(e.value, Number.isInteger(e.value) ? 0 : 1)} ${e.unit}`),
          " · ", utcTime(e.timestamp), " ",
          e.source === "simulation" || e.source === "seed" ? el("span", { class: "sim-tag" }, "Simulated") : null,
        ])))
      : null,
    detail ? null : el("p", { class: "alert-pop__note" }, "Full details couldn't be loaded; open the alert on the Alerts page."),
  ];
}
