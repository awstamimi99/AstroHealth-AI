// js/pages/crew-monitor.js — #/crew and #/crew/AH-0n for the Medical Officer (Sprint 5)
//
//   #/crew        every crew member as a card (ranked), open alerts across the
//                 crew, and the last SHARED wellbeing check-in date per astronaut
//   #/crew/AH-03  one crew member, read-only: profile + baseline, status, latest
//                 readings, open alerts, up to 7 explicitly shared check-ins,
//                 sleep summary, last cognitive check, recent verified messages
//
// app-shell has already authorized the route (#/crew/… normalizes to #/crew,
// Medical Officer only). This module only reads the detail segment, strictly:
// "#/crew/AH-01" selects AH-01; any other "#/crew/…" is "not found" — never
// a guess. The service re-checks the Medical Officer before reading anything.
// Presentation only; no js/db imports; database text is inserted via el().

import { getCrewSnapshot, getCrewMemberDetail } from "../services/crew-monitor-service.js";
import { icon } from "../components/icon.js";
import { el } from "../core/utils/dom.js";
import { formatDate, formatNumber } from "../core/utils/format.js";
import {
  alertItem,
  dataBadges,
  crewCard,
  loadingView,
  provenanceTag,
  refusalView,
  section,
  sectionError,
  stamp,
  stateBadge,
  syntheticNotice,
  utcTime,
  vitalValueText,
} from "../components/crew-view.js";

const DETAIL_ROUTE = /^#\/crew\/(AH-\d{2})$/;
const SCORE_LABELS = [
  ["mood", "Mood", 5],
  ["stress", "Stress", 10],
  ["sleepQuality", "Sleep quality", 5],
  ["fatigue", "Fatigue", 10],
  ["isolation", "Isolation", 10],
  ["wellbeing", "Wellbeing", 5],
];

/**
 * "#/crew" (or "#/crew?…") → { view: "list" }; "#/crew/AH-01" → { view:
 * "detail", crewId }; any other "#/crew/…" → { view: "invalid" }.
 */
export function parseCrewRoute(hash) {
  const text = String(hash || "");
  const match = DETAIL_ROUTE.exec(text);
  if (match) return { view: "detail", crewId: match[1] };
  if (text === "#/crew" || text.startsWith("#/crew?")) return { view: "list" };
  return { view: "invalid" };
}

// ---- List (#/crew) --------------------------------------------------------------------

function listView(data, onRetry) {
  const crewSection = section("crew-list-title", "Crew", [
    el("p", { class: "crew__note" }, "Ranked: open critical, watch and info alerts first, then status unavailable, then data needing review. Based on stored open alerts only. This is not a health assessment."),
    data.crew.length
      ? el("ul", { class: "crew-grid", role: "list" }, data.crew.map((m) => el("li", {}, crewCard(m, data.generatedAt))))
      : el("p", { class: "crew__empty" }, "No crew profiles are stored on this device."),
  ]);

  const alerts = data.alerts;
  const alertsSection = section("crew-alerts-title", "Open alerts across the crew", [
    alerts.status === "error"
      ? sectionError(onRetry, "the crew's alerts")
      : alerts.items.length
        ? el("ul", { class: "crew__alerts", role: "list" }, alerts.items.map((a) => alertItem(a, { withCrew: true })))
        : el("p", { class: "crew__empty" }, "No open alerts across the crew."),
    alerts.moreCount ? el("p", { class: "crew__meta" }, `and ${alerts.moreCount} more open alerts`) : null,
    el("p", {}, el("a", { class: "btn btn--secondary btn--sm", href: "#/alerts" }, [icon("bell"), "View all alerts"])),
  ]);

  const sharedSection = section("crew-shared-title", "Shared wellbeing check-ins", [
    el("p", { class: "crew__note" }, "Only check-ins an astronaut chose to share are counted. Private check-ins and journals are never shown. Scores appear on each crew member's detail page."),
    el("ul", { class: "crew__plain-list", role: "list" },
      data.crew.map((m) =>
        el("li", {}, [
          el("strong", {}, `${m.name} (${m.crewId}): `),
          m.sharedWellbeing.status === "error"
            ? "couldn't be loaded"
            : m.sharedWellbeing.lastSharedAt
              ? ["last shared ", utcTime(m.sharedWellbeing.lastSharedAt)]
              : "no shared check-in in the last 30 days",
        ]))),
    data.crew.some((m) => m.sharedWellbeing.status === "error") ? sectionError(onRetry, "shared check-ins") : null,
  ]);

  return [
    el("section", { class: "crew__header", "aria-labelledby": "crew-heading" }, [
      el("h2", { class: "crew__welcome", id: "crew-heading" }, "Crew Monitor"),
      el("p", { class: "crew__subtitle" }, `${data.crew.length} crew members · ${data.mission.available ? `Mission ${data.mission.name}` : "Mission context not available"}`),
      syntheticNotice(),
    ]),
    crewSection,
    alertsSection,
    sharedSection,
  ];
}

// ---- Detail (#/crew/AH-0n) ---------------------------------------------------------------

function vitalCard(item, now, onRetry) {
  const id = `crew-vital-${item.key}`;
  const baseline = item.baseline == null
    ? "No baseline recorded"
    : item.key === "bloodPressure"
      ? `Baseline: ${formatNumber(item.baseline.systolic)}/${formatNumber(item.baseline.diastolic)} ${item.unit}`
      : `Baseline: ${formatNumber(item.baseline, item.key === "sleepDuration" ? 1 : 0)} ${item.unit}`;
  return el("article", { class: "card metric crew-detail__vital", "aria-labelledby": id }, [
    el("div", { class: "metric__top" }, [el("h3", { class: "metric__label", id }, item.label), item.state === "ok" ? provenanceTag(item) : null]),
    el("p", { class: "crew-detail__value" }, vitalValueText(item)),
    item.state === "ok" ? el("p", { class: "crew__meta" }, stamp(item.timestamp, now)) : null,
    item.state === "error" ? sectionError(onRetry, "this reading") : el("p", { class: "crew__tags" }, dataBadges(item)),
    el("p", { class: "crew__meta" }, baseline),
  ]);
}

function sharedWellbeingSection(shared, onRetry) {
  let body;
  if (shared.status === "error") body = [sectionError(onRetry, "shared check-ins")];
  else if (!shared.items.length) body = [el("p", { class: "crew__empty" }, "No shared check-ins in the last 30 days.")];
  else {
    body = [
      el("ul", { class: "crew-shared", role: "list" },
        shared.items.map((w) =>
          el("li", { class: "crew-shared__item" }, [
            el("p", { class: "crew-shared__date" }, utcTime(w.timestamp)),
            el("dl", { class: "crew-shared__scores" },
              SCORE_LABELS.flatMap(([key, label, max]) => [
                el("dt", {}, label),
                el("dd", {}, w[key] === null ? "—" : `${w[key]} / ${max}`),
              ])),
          ]))),
    ];
  }
  return section("crew-detail-wellbeing-title", "Shared wellbeing check-ins", [
    el("p", { class: "crew__note" }, "Shared by the astronaut (up to 7, newest first). Private check-ins and the private journal are never shown. Scores are self-reported and are not a diagnosis."),
    ...body,
  ]);
}

const MESSAGE_STATUS = {
  awaiting_acknowledgement: "Awaiting acknowledgement",
  acknowledged: "Acknowledged",
  replied: "Replied",
  sent: "Sent",
};

function messagesSection(messages, data, onRetry) {
  let body;
  if (messages.status === "error") body = [sectionError(onRetry, "messages")];
  else if (!messages.items.length) body = [el("p", { class: "crew__empty" }, "No messages with a verified sender.")];
  else {
    body = [
      el("ul", { class: "crew__plain-list", role: "list" },
        messages.items.map((m) =>
          el("li", { class: "crew-message" }, [
            el("p", { class: "crew__meta" }, [
              m.direction === "from_officer" ? "From the Medical Officer" : `From ${data.profile.name}`,
              " · sent ", ...stamp(m.sentAt, data.generatedAt), ` · ${MESSAGE_STATUS[m.status] || m.status}`,
            ]),
            el("p", { class: "crew-message__body" }, m.body || "(empty message)"),
            m.reply ? el("p", { class: "crew-message__reply" }, [`Reply from ${data.profile.name}: `, m.reply.text, m.reply.at ? [" · ", utcTime(m.reply.at)] : null]) : null,
          ]))),
      messages.moreCount ? el("p", { class: "crew__meta" }, `and ${messages.moreCount} older messages`) : null,
    ];
  }
  return section("crew-detail-messages-title", "Messages", [
    ...body,
    el("p", { class: "crew__note" }, "Read-only message history. Senders are verified against stored accounts; alert actions are handled on the Alerts page."),
  ]);
}

function detailView(data, onRetry) {
  const p = data.profile;
  const heading = el("h2", { class: "crew__welcome", id: "crew-detail-title", tabindex: "-1" }, `${p.name} · ${p.crewId}`);
  const alerts = data.alerts;
  const sleep = data.sleep;
  const sleepText =
    sleep.status === "error"
      ? null
      : !sleep.recorded
        ? "No sleep data in the last seven nights."
        : `${sleep.recorded} of ${sleep.nights.length} nights recorded. Average ${formatNumber(sleep.average, 1)} h.` +
          (sleep.baseline === null ? "" : ` Baseline ${formatNumber(sleep.baseline, 1)} h. ${sleep.belowBaseline} of ${sleep.recorded} recorded nights below baseline.`);

  const view = [
    el("p", {}, el("a", { class: "btn btn--secondary btn--sm", href: "#/crew" }, [icon("users"), "Back to Crew Monitor"])),
    el("section", { class: "crew__header", "aria-labelledby": "crew-detail-title" }, [
      heading,
      el("p", { class: "crew__subtitle" }, `${p.missionRole} · read-only view`),
      syntheticNotice(),
    ]),
    section("crew-detail-status-title", "Status", [
      el("p", { class: "crew__tags" }, stateBadge(data.state, "crew__status-badge")),
      el("p", { class: "crew__text" }, data.state.reason),
      el("p", { class: "crew__note" }, data.state.note),
    ]),
    section("crew-detail-alerts-title", "Open alerts", [
      alerts.status === "error"
        ? sectionError(onRetry, "open alerts")
        : alerts.items.length
          ? el("ul", { class: "crew__alerts", role: "list" }, alerts.items.map((a) => alertItem(a)))
          : el("p", { class: "crew__empty" }, "No open alerts."),
    ]),
    section("crew-detail-vitals-title", "Latest readings", [
      el("p", { class: "crew__note" }, "Most recent usable reading of each measure. Invalid readings are left out. Times are UTC."),
      el("div", { class: "crew-grid crew-grid--4" }, data.vitals.items.map((v) => vitalCard(v, data.generatedAt, onRetry))),
    ]),
    sharedWellbeingSection(data.sharedWellbeing, onRetry),
    section("crew-detail-sleep-title", "Sleep — last 7 nights", [
      sleep.status === "error"
        ? sectionError(onRetry, "the sleep summary")
        : el("p", { class: "crew__text" }, sleepText),
      sleep.status === "error" || !sleep.recorded
        ? null
        : el("ul", { class: "crew__plain-list crew-sleep", role: "list" },
            sleep.nights.map((n) => el("li", {}, `${formatDate(Date.parse(`${n.date}T00:00:00.000Z`), { timeZone: "UTC" })}: ${n.hours === null ? "No data" : `${formatNumber(n.hours, 1)} h`}`))),
    ]),
    section("crew-detail-cognitive-title", "Cognitive check", [
      data.cognitive.status === "error"
        ? sectionError(onRetry, "cognitive checks")
        : el("p", { class: "crew__text" }, data.cognitive.lastAt ? ["Last completed ", ...stamp(data.cognitive.lastAt, data.generatedAt)] : "No cognitive check recorded."),
    ]),
    messagesSection(data.messages, data, onRetry),
  ];
  return { view, heading };
}

// ---- Renderer ---------------------------------------------------------------------------

/** TEST SEAM: tests pass fake loaders returning presentation data. Pages use renderCrewMonitor. */
export function createCrewMonitorRenderer({ loadSnapshot, loadDetail }) {
  return function render(container, session, { signal, hash = "#/crew", focus = false } = {}) {
    const route = parseCrewRoute(hash);
    const root = el("div", { class: "crew", "aria-busy": "false" });
    container.replaceChildren(root);
    let generation = 0;

    async function load() {
      const token = ++generation;
      root.setAttribute("aria-busy", "true");
      for (const b of root.querySelectorAll("[data-retry]")) b.disabled = true;
      if (!root.childNodes.length) root.replaceChildren(...loadingView(route.view === "list" ? "Loading the crew…" : "Loading crew member…"));

      let result;
      try {
        if (route.view === "list") result = await loadSnapshot(session);
        else result = await loadDetail(session, route.view === "detail" ? route.crewId : ""); // "" → service says not found
      } catch {
        result = { status: "unavailable", reason: "unexpected_error" };
      }
      if (token !== generation || (signal && signal.aborted)) return;

      const retry = () => load();
      if (result && result.status === "ready") {
        if (route.view === "list") root.replaceChildren(...listView(result, retry));
        else {
          const { view, heading } = detailView(result, retry);
          root.replaceChildren(...view);
          if (focus && token === 1) heading.focus(); // opening a crew member moves focus to its name
        }
      } else {
        root.replaceChildren(refusalView(result, retry));
      }
      root.setAttribute("aria-busy", "false");
    }
    return load();
  };
}

export const renderCrewMonitor = createCrewMonitorRenderer({
  loadSnapshot: (session) => getCrewSnapshot(session),
  loadDetail: (session, crewId) => getCrewMemberDetail(session, crewId),
});
