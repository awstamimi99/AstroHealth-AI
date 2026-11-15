// js/components/review-steps.js — SHARED. "How to review this alert": the
// tickable review steps for one alert, with a progress bar and the alert's
// local video / picture guide — or, when none has been added, a clear notice
// that the steps below are the guide.
//
//   const node = createReviewSteps({ number: "ALT-0190", ruleId: "PHY-05", viewer: "officer", userKey, announce });
//
// Steps come from js/components/action-plans.js (synthetic, non-clinical review
// steps — never diagnosis or treatment). Ticks are kept per user and alert in
// this browser (js/core/action-plan-progress.js); they never change the alert.
// All text is inserted with el(); a guide's src must be a local assets/ path.

import { el } from "../core/utils/dom.js";
import { icon } from "./icon.js";
import { planForRule, mediaForRule, PLAN_NOTICE } from "./action-plans.js";
import { planProgress } from "../core/action-plan-progress.js";

export const NO_GUIDE_TEXT = "No video or picture guide has been added for this alert yet. Follow the review steps below.";

/**
 * @param {{ number: string, ruleId: string, viewer?: "astronaut"|"officer", userKey: string,
 *           idPrefix?: string, progress?: object, announce?: (text: string) => void }} options
 */
export function createReviewSteps({ number, ruleId, viewer = "astronaut", userKey, idPrefix = "review", progress = planProgress, announce = () => {} }) {
  const plan = planForRule(ruleId, { viewer });
  const media = mediaForRule(ruleId);
  const ids = plan.steps.map((s) => s.id);
  const countId = `${idPrefix}-count`;
  const bar = el("progress", { class: "review-steps__bar", max: String(ids.length), value: "0", "aria-labelledby": countId });
  const count = el("p", { class: "review-steps__count", id: countId });
  const notice = el("p", { class: "review-steps__note", role: "note", hidden: true }, "This browser isn't saving your ticks right now, so they apply to this tab only.");
  const items = [];
  const complete = el("p", { class: "review-steps__complete", role: "status", hidden: true }, [
    icon("circle-check", { size: 16 }),
    " ",
    viewer === "officer"
      ? "Review complete. Acknowledge and resolve the alert under Actions; once resolved it is removed from every body scan."
      : "Review complete — thank you. The Medical Officer resolves the alert; once resolved it is removed from your body scan.",
  ]);

  const sync = (done, persisted) => {
    bar.setAttribute("value", String(done.length));
    count.textContent = done.length === ids.length ? `All ${ids.length} review steps ticked` : `${done.length} of ${ids.length} review steps ticked`;
    if (done.length === ids.length) complete.removeAttribute("hidden");
    else complete.setAttribute("hidden", "");
    for (const li of items) {
      if (done.includes(li.getAttribute("data-step"))) li.setAttribute("data-done", "");
      else li.removeAttribute("data-done");
    }
    if (persisted === false) notice.removeAttribute("hidden");
  };

  const done0 = progress.get(userKey, number, ids);
  const list = el("ol", { class: "review-steps__list", role: "list" }, plan.steps.map((s, i) => {
    const li = el("li", { class: "review-steps__item", "data-step": s.id }, el("label", { class: "review-steps__step", for: `${idPrefix}-step-${s.id}` }, [
      el("input", {
        type: "checkbox",
        id: `${idPrefix}-step-${s.id}`,
        checked: done0.includes(s.id),
        onChange: (e) => {
          const r = progress.set(userKey, number, s.id, e.target.checked === true, ids);
          sync(r.done, r.persisted);
          announce(`${r.done.length} of ${ids.length} review steps ticked.`);
        },
      }),
      el("span", { class: "review-steps__num", "aria-hidden": "true" }, String(i + 1)),
      el("span", { class: "review-steps__text" }, [el("span", { class: "sr-only" }, `Step ${i + 1}. `), s.text]),
    ]));
    items.push(li);
    return li;
  }));

  const guide = media
    ? el("figure", { class: "review-steps__media" }, [
        media.kind === "video"
          ? el("video", { src: media.src, controls: true, preload: "metadata" })
          : el("img", { src: media.src, alt: media.caption || plan.title, loading: "lazy" }),
        media.caption ? el("figcaption", { class: "review-steps__note" }, media.caption) : null,
      ])
    : el("div", { class: "review-steps__noguide", role: "note" }, [
        el("span", { class: "review-steps__noguide-icon", "aria-hidden": "true" }, icon("circle-check")),
        el("div", {}, [el("p", { class: "review-steps__noguide-title" }, "Step-by-step guide"), el("p", { class: "review-steps__note" }, NO_GUIDE_TEXT)]),
      ]);

  const node = el("div", { class: "review-steps", "data-review-steps": viewer }, [
    el("p", { class: "review-steps__plan" }, plan.title),
    guide,
    el("div", { class: "review-steps__progress" }, [bar, count]),
    notice,
    list,
    complete,
    el("p", { class: "review-steps__note" }, [icon("info", { size: 14 }), " ", PLAN_NOTICE]),
  ]);
  sync(done0);
  return node;
}
