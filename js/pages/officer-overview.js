// js/pages/officer-overview.js — #/overview for the Medical Officer (Sprint 5)
//
// Mission + crew summary counts, the crew priority queue (who to review
// first, and why), and a link to the Crew Monitor. Presentation only: rules
// live in js/services/crew-monitor-service.js. No js/db imports.
// A late result after navigation (or after a newer Retry) is dropped.

import { getCrewSnapshot } from "../services/crew-monitor-service.js";
import { icon } from "../components/icon.js";
import { el } from "../core/utils/dom.js";
import { loadingView, refusalView, section, sectionError, stateBadge, syntheticNotice, srOnly } from "../components/crew-view.js";

const COUNTS = [
  ["critical", "Critical alert", "circle-alert", "badge--critical", "#/alerts"],
  ["watch", "Watch", "triangle-alert", "badge--warning", "#/alerts"],
  ["info", "Info", "info", "badge--info", "#/alerts"],
  ["unavailable", "Status unavailable", "eye-off", "badge--neutral", "#/crew"],
  ["dataNeedsReview", "Data needs review", "clock", "badge--neutral", "#/crew"],
  ["noOpenAlerts", "No open alerts", "circle-check", "badge--ok", "#/crew"],
];

function headerSection(data) {
  const { mission } = data;
  const missionText = mission.available
    ? `Mission ${mission.name} · ${mission.missionDay ? `Mission Day ${mission.missionDay}` : "Mission Day not available"}`
    : "Mission context not available";
  return el("section", { class: "crew__header", "aria-labelledby": "mo-welcome-title" }, [
    el("h2", { class: "crew__welcome", id: "mo-welcome-title" }, `Welcome, ${data.officer.displayName}`),
    el("p", { class: "crew__subtitle" }, `Medical Officer · ${missionText}`),
    syntheticNotice(),
  ]);
}

function summarySection(data, onRetry) {
  const s = data.summary;
  return section("mo-summary-title", "Crew summary", [
    el("p", { class: "crew__text" },
      s.withOpenAlerts === null
        ? `${s.crewCount} crew members. Open alerts couldn't be loaded.`
        : `${s.crewCount} crew members · ${s.withOpenAlerts} with open alerts.`),
    el("ul", { class: "crew-counts", role: "list" },
      COUNTS.map(([key, label, iconName, cls, href]) =>
        el("li", { class: "crew-counts__item" }, [
          el("span", { class: ["badge", cls] }, [icon(iconName), label]),
          el("span", { class: "crew-counts__value" }, String(s[key])),
          el("a", { class: "crew-counts__link", href, "aria-label": `View ${label.toLowerCase()} details` }, icon("arrow-right")),
        ]))),
    el("p", { class: "crew__note" }, "Crew status is based on stored open alerts only. This is not a health assessment."),
    s.unavailable ? sectionError(onRetry, "the crew's alerts") : null,
  ]);
}

function queueSection(data) {
  const queue = data.crew.filter((m) => m.state.level !== "clear");
  return section("mo-queue-title", "Review first", [
    el("p", { class: "crew__note" }, "Ordered by open-alert severity (critical, watch, info), then status unavailable, then data needing review. Ties: unacknowledged alerts first, then newest."),
    queue.length
      ? el("ol", { class: "crew-queue" },
          queue.map((m) =>
            el("li", { class: "crew-queue__item" }, [
              el("div", { class: "crew-queue__body" }, [
                el("p", { class: "crew-queue__name" }, [`${m.name} · ${m.crewId}`, srOnly(`, ${m.state.label}`)]),
                el("p", { class: "crew__tags" }, stateBadge(m.state)),
                el("p", { class: "crew__text" }, m.state.reason),
              ]),
              el("a", { class: "btn btn--secondary btn--sm", href: `#/crew/${m.crewId}` }, [icon("arrow-right"), "Review", srOnly(` ${m.name}`)]),
            ])))
      : el("p", { class: "crew__empty" }, "No crew member has open alerts or data needing review."),
    el("p", {}, el("a", { class: "btn btn--secondary btn--sm", href: "#/crew" }, [icon("users"), "Open Crew Monitor"])),
  ]);
}

/** TEST SEAM: tests pass a fake loader returning presentation data. Pages use renderMedicalOfficerOverview. */
export function createMedicalOfficerOverviewRenderer({ loadSnapshot }) {
  return function render(container, session, { signal } = {}) {
    const root = el("div", { class: "crew crew--overview", "aria-busy": "false" });
    container.replaceChildren(root);
    let generation = 0;

    async function load() {
      const token = ++generation;
      root.setAttribute("aria-busy", "true");
      for (const b of root.querySelectorAll("[data-retry]")) b.disabled = true;
      if (!root.childNodes.length) root.replaceChildren(...loadingView("Loading the crew overview…"));
      let result;
      try {
        result = await loadSnapshot(session);
      } catch {
        result = { status: "unavailable", reason: "unexpected_error" };
      }
      if (token !== generation || (signal && signal.aborted)) return;
      const retry = () => load();
      if (result && result.status === "ready") root.replaceChildren(headerSection(result), summarySection(result, retry), queueSection(result));
      else root.replaceChildren(refusalView(result, retry));
      root.setAttribute("aria-busy", "false");
    }
    return load();
  };
}

export const renderMedicalOfficerOverview = createMedicalOfficerOverviewRenderer({ loadSnapshot: (session) => getCrewSnapshot(session) });
