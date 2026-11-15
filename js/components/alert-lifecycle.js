// js/components/alert-lifecycle.js — SHARED. "How this alert is closed": the four
// stages of an alert (opened → acknowledged → condition cleared → resolved) with
// their times, and a plain sentence saying what happens next and who does it.
//
//   createAlertLifecycle(lifecycleFromDetail(detail), { viewer: "astronaut" })
//
// It only explains the stored lifecycle (js/services/alerts-service.js +
// js/services/risk-service.js): the rules open an alert and mark the condition
// cleared; the Medical Officer acknowledges and resolves. A resolved alert is
// no longer marked on any body scan. Presentation only; text via el().

import { el } from "../core/utils/dom.js";
import { icon } from "./icon.js";
import { utcTime } from "./crew-view.js";

const isTime = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Normalise an alert (+ optional audit timeline) from alerts-service into lifecycle input.
 * @param {{ alert?: object, timeline?: { status: string, items: Array<{ label: string, timestamp: number }> } } | object} source
 */
export function lifecycleFromDetail(source) {
  const a = source && source.alert ? source.alert : source || {};
  const items = source && source.timeline && source.timeline.status === "ok" ? source.timeline.items : [];
  const at = (re) => { const x = items.find((i) => re.test(i.label)); return x && isTime(x.timestamp) ? x.timestamp : 0; };
  return {
    status: ["new", "acknowledged", "resolved"].includes(a.status) ? a.status : "new",
    conditionCleared: a.conditionCleared === true || a.conditionCleared === 1,
    opened: isTime(a.detectedAt) ? a.detectedAt : at(/^Created/i),
    acknowledged: isTime(a.acknowledgedAt) ? a.acknowledgedAt : at(/^Acknowledged/i),
    cleared: at(/^Condition cleared/i),
    resolved: isTime(a.resolvedAt) ? a.resolvedAt : at(/^Resolved/i),
  };
}

/** What happens next, in words, for this viewer. */
export function nextStepText(l, viewer = "astronaut") {
  const mo = viewer === "officer";
  if (l.status === "resolved") return "Closed. This alert is resolved and is no longer marked on the body scan. It stays in the history.";
  if (l.status === "new") return mo ? "Next: acknowledge this alert on the Alerts page so the crew member can see it has been seen." : "Next: the Medical Officer acknowledges this alert. Meanwhile, work through the review steps.";
  if (!l.conditionCleared) {
    return mo
      ? "Next: the condition clears automatically when new readings return to the clear range. You can then resolve the alert with a note (or resolve it now, with a confirmation)."
      : "Next: the condition clears automatically when your new readings return to the clear range. The Medical Officer then resolves the alert, and it disappears from your body scan.";
  }
  return mo ? "Next: resolve this alert on the Alerts page with a note that says what was checked." : "Next: the Medical Officer resolves this alert. As soon as it is resolved it disappears from your body scan.";
}

/**
 * @param {ReturnType<typeof lifecycleFromDetail>} l
 * @param {{ viewer?: "astronaut"|"officer", id?: string }} [options]
 */
export function createAlertLifecycle(l, { viewer = "astronaut", id = "alert-lifecycle" } = {}) {
  const stages = [
    { key: "opened", label: "Opened", who: "by the demonstration rules", done: true, time: l.opened },
    { key: "acknowledged", label: "Acknowledged", who: "by the Medical Officer", done: l.status !== "new", time: l.acknowledged },
    { key: "cleared", label: "Condition cleared", who: "automatically, when readings return to the clear range", done: l.conditionCleared || Boolean(l.cleared), time: l.cleared },
    { key: "resolved", label: "Resolved", who: "by the Medical Officer, with a note", done: l.status === "resolved", time: l.resolved },
  ];
  const current = stages.findIndex((s) => !s.done);
  return el("div", { class: "alert-life", "data-alert-life": l.status }, [
    el("p", { class: "alert-life__title", id }, "How this alert is closed"),
    el("ol", { class: "alert-life__stages", role: "list", "aria-labelledby": id }, stages.map((s, i) => el("li", {
      class: ["alert-life__stage", s.done ? "is-done" : "", i === current ? "is-current" : ""],
      "data-stage": s.key,
    }, [
      el("span", { class: "alert-life__dot", "aria-hidden": "true" }, s.done ? icon("check", { size: 14 }) : String(i + 1)),
      el("span", { class: "alert-life__text" }, [
        el("strong", {}, s.label),
        el("span", { class: "sr-only" }, s.done ? " — done" : i === current ? " — next" : " — not yet"),
        el("span", { class: "alert-life__who" }, s.who),
        s.done && isTime(s.time) ? el("span", { class: "alert-life__time" }, utcTime(s.time)) : null,
      ]),
    ]))),
    el("p", { class: "alert-life__next", role: "status" }, [icon(l.status === "resolved" ? "circle-check" : "info", { size: 16 }), " ", nextStepText(l, viewer)]),
    viewer === "officer" ? null : el("p", { class: "alert-life__note" }, "Only the Medical Officer can resolve an alert, so a human always reviews it. Your part is the review steps."),
  ]);
}
