// js/pages/officer-overview.js — #/overview for the Medical Officer (Sprint 5)
//
// Mission + crew summary counts, the crew priority queue (who to review
// first, and why), and a link to the Crew Monitor. Presentation only: rules
// live in js/services/crew-monitor-service.js. No js/db imports.
//
// Body-scan redesign: "Crew body scan" shows one dark scan card per crew
// member — the wireframe body with a numbered pin for their top open alert
// and small rings for heart rate, SpO₂ and sleep (the crew snapshot's three
// readings). The pin and the "Open body scan" link go to #/crew/AH-0n, which
// shows the full stage with all 4 rings and every open alert.
// A late result after navigation (or after a newer Retry) is dropped.

import { getCrewSnapshot } from "../services/crew-monitor-service.js";
import { icon } from "../components/icon.js";
import { el } from "../core/utils/dom.js";
import { onHealthChanged, keepFocus } from "../core/live-updates.js";
import { createBodyScan, createRing } from "../components/body-scan.js";
import { alertPins, ringFraction, severityLegend } from "../components/vitals-stage.js";
import { zoneForRule, ZONE_LABELS, vitalSeverities } from "../components/alert-zones.js";
import { formatNumber } from "../core/utils/format.js";
import { dataBadges, loadingView, refusalView, section, sectionError, stateBadge, syntheticNotice, srOnly } from "../components/crew-view.js";

const MINI_RINGS = ["heartRate", "spo2", "sleepDuration"];
const SPOKEN_UNIT = { heartRate: "beats per minute", spo2: "percent", sleepDuration: "hours" };

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

/** A small ring for one of the snapshot's readings (value + unit as text; fill is a display scale). */
function miniRing(member, item, alertSeverity = "") {
  const ok = item.state === "ok";
  const visual = ok ? formatNumber(item.value, item.key === "sleepDuration" ? 1 : 0) : "—";
  return createRing({
    id: `mo-ring-${member.crewId}-${item.key}`,
    label: item.label,
    value: visual,
    unit: ok ? item.unit : "",
    fraction: ringFraction(item),
    spoken: (ok ? `${item.label}: ${visual} ${SPOKEN_UNIT[item.key] || item.unit}` : `${item.label}: no value`) + (alertSeverity ? `. Open ${alertSeverity} alert for this measure` : ""),
    alertSeverity,
    tags: ok ? dataBadges(item).filter(Boolean) : dataBadges(item),
  });
}

/** One crew member's scan card: name, state, body with the top-alert pin, 3 small rings. */
function scanCard(member, navigate) {
  const titleId = `mo-scan-${member.crewId}`;
  const href = `#/crew/${member.crewId}`;
  const top = member.alerts.status === "ok" ? member.alerts.top : null;
  const pins = top ? alertPins([top], { who: `${member.name}: top ` }).map((p) => ({ ...p, label: p.label.replace(/Open details\.$/, "Open crew member body scan.") })) : [];
  const items = MINI_RINGS.map((key) => member.vitals.items.find((i) => i.key === key)).filter(Boolean);
  const severities = vitalSeverities(member.alerts.status === "ok" ? member.alerts.rules || [] : []);
  return el("article", { class: "scan-stage mo-scan-card", "aria-labelledby": titleId }, [
    el("div", { class: "mo-scan-card__head" }, [
      el("h3", { class: "scan-stage__title mo-scan-card__name", id: titleId }, `${member.name} · ${member.crewId}`),
      el("p", { class: "crew__tags" }, [stateBadge(member.state), el("span", { class: "sim-tag" }, [icon("flask-conical", { size: 12 }), "SIMULATED"])]),
    ]),
    el("div", { class: "mo-scan-card__main" }, [
      el("div", { class: "mo-scan-card__body" }, createBodyScan({ pins, hotspots: pins, onPinClick: () => navigate(href) })),
      el("div", { class: "mo-scan-card__rings" }, items.map((item) => miniRing(member, item, severities[item.key] || ""))),
    ]),
    el("p", { class: "scan-stage__note" },
      member.alerts.status === "error"
        ? "Open alerts couldn't be loaded."
        : top
          ? `${member.alerts.openCount} open alert${member.alerts.openCount === 1 ? "" : "s"} · pin 1: ${[top.number, top.title].filter(Boolean).join(" · ")} (${ZONE_LABELS[zoneForRule(top.ruleId)] || "Body"})`
          : "No open alerts."),
    el("p", {}, el("a", { class: "mo-scan-card__link", href }, [icon("arrow-right"), "Open body scan", srOnly(` for ${member.name}`)])),
  ]);
}

function crewScanSection(data, navigate) {
  return section("mo-scan-title", "Crew body scan", [
    el("div", { class: "mo-scan__intro" }, [
      el("p", { class: "crew__note" }, "Latest heart rate, SpO₂ and sleep for each crew member, in review order. Pin 1 marks the top open alert; a ring takes the colour of an open alert for that measure. The drawing and ring fill are illustrations only — not a health assessment. Open a crew member for all 4 readings and every open alert."),
      el("div", { class: "mo-scan__legend" }, severityLegend()),
    ]),
    data.crew.length
      ? el("ul", { class: "mo-scan-grid", role: "list" }, data.crew.map((m) => el("li", {}, scanCard(m, navigate))))
      : el("p", { class: "crew__empty" }, "No crew profiles are stored on this device."),
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
export function createMedicalOfficerOverviewRenderer({ loadSnapshot, navigate = (hash) => { globalThis.location.hash = hash; }, subscribe = onHealthChanged }) {
  return function render(container, session, { signal } = {}) {
    const root = el("div", { class: "crew crew--overview", "aria-busy": "false" });
    container.replaceChildren(root);
    let generation = 0;

    // Live updates (crew-wide screen: every crew member's changes count).
    subscribe({ signal, crewId: () => "", reload: () => keepFocus(root, () => load({ quiet: true })) });

    async function load({ quiet = false } = {}) {
      const token = ++generation;
      if (!quiet) {
        root.setAttribute("aria-busy", "true");
        for (const b of root.querySelectorAll("[data-retry]")) b.disabled = true;
      }
      if (!root.childNodes.length) root.replaceChildren(...loadingView("Loading the crew overview…"));
      let result;
      try {
        result = await loadSnapshot(session);
      } catch {
        result = { status: "unavailable", reason: "unexpected_error" };
      }
      if (token !== generation || (signal && signal.aborted)) return;
      if (quiet && !(result && result.status === "ready")) return; // keep what is shown
      const retry = () => load();
      if (result && result.status === "ready") root.replaceChildren(
        headerSection(result),
        crewScanSection(result, navigate),
        summarySection(result, retry),
        queueSection(result),
      );
      else root.replaceChildren(refusalView(result, retry));
      root.setAttribute("aria-busy", "false");
    }
    return load();
  };
}

export const renderMedicalOfficerOverview = createMedicalOfficerOverviewRenderer({ loadSnapshot: (session) => getCrewSnapshot(session) });
