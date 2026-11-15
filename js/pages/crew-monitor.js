// js/pages/crew-monitor.js — #/crew and #/crew/AH-0n for the Medical Officer (Sprint 5)
//
//   #/crew        every crew member as a card (ranked), open alerts across the
//                 crew, and the last SHARED wellbeing check-in date per astronaut
//   #/crew/AH-03  one crew member, read-only: profile + baseline, status, latest
//                 readings, open alerts, up to 7 explicitly shared check-ins,
//                 sleep summary, last cognitive check, recent verified messages
//
// Body-scan redesign: the detail view shows the crew member's latest readings
// as the same body-scan stage as the astronaut Overview (4 rings + dashed
// connectors, js/components/vitals-stage.js) with numbered pins for open
// alerts. A pin or the numbered alert list opens a read-only pop-up
// (js/components/alert-popup.js); acknowledging and resolving stay on the
// Alerts page, where every action is recorded.
//
// app-shell has already authorized the route (#/crew/… normalizes to #/crew,
// Medical Officer only). This module only reads the detail segment, strictly:
// "#/crew/AH-01" selects AH-01; any other "#/crew/…" is "not found" — never
// a guess. The service re-checks the Medical Officer before reading anything.
// Presentation only; no js/db imports; database text is inserted via el().

import { getCrewSnapshot, getCrewMemberDetail } from "../services/crew-monitor-service.js";
import { getAlertDetail } from "../services/alerts-service.js";
import { createRing } from "../components/body-scan.js";
import { createAlertLifecycle, lifecycleFromDetail } from "../components/alert-lifecycle.js";
import { zoneForRule, ZONE_LABELS } from "../components/alert-zones.js";
import { createVitalsStage, alertPins, ringFraction, centreStages, severityLegend } from "../components/vitals-stage.js";
import { alertPopupBody, alertTitle, loadAlertDetailSafely } from "../components/alert-popup.js";
import { openDialog } from "../components/dialog.js";
import { severityBar, sparkline, barList } from "../components/mini-charts.js";
import { icon } from "../components/icon.js";
import { el } from "../core/utils/dom.js";
import { onHealthChanged, keepFocus } from "../core/live-updates.js";
import { formatDate, formatNumber } from "../core/utils/format.js";
import {
  alertItem,
  badge,
  dataBadges,
  crewCard,
  loadingView,
  provenanceTag,
  refusalView,
  section,
  sectionError,
  SEVERITY_VIEW,
  srOnly,
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

const TREND_METRICS = Object.freeze([
  { key: "heartRate", label: "Heart rate", unit: "bpm", decimals: 0 },
  { key: "spo2", label: "SpO₂", unit: "%", decimals: 0 },
  { key: "sleepDuration", label: "Sleep", unit: "h", decimals: 1 },
]);

/** "Crew at a glance": open alerts by severity, 7-day trends, shared check-ins. */
function glanceSection(data, onRetry) {
  const sev = data.summary.alertsBySeverity;
  const baselineOf = (m, key) => {
    const v = m.vitals && m.vitals.items ? m.vitals.items.find((x) => x.key === key) : null;
    return v && typeof v.baseline === "number" ? v.baseline : null;
  };
  const trendRows = data.crew.map((m) => el("tr", {}, [
    el("th", { scope: "row" }, el("a", { class: "crew-glance__member", href: `#/crew/${m.crewId}` }, [
      el("span", { class: "crew-glance__avatar", "aria-hidden": "true" }, m.initials || m.crewId.slice(-2)),
      el("span", {}, [el("strong", {}, m.name), el("span", { class: "crew__meta" }, ` · ${m.crewId}`)]),
    ])),
    ...TREND_METRICS.map((t) => {
      const trend = m.trends && m.trends[t.key];
      return el("td", { "data-label": t.label }, !trend || trend.status === "error"
        ? el("span", { class: "crew__meta" }, "Couldn't load")
        : sparkline({ points: trend.points, baseline: baselineOf(m, t.key), unit: t.unit, label: `${m.name} ${t.label}`, decimals: t.decimals }));
    }),
  ]));
  return el("section", { class: "crew-glance", "aria-labelledby": "crew-glance-title" }, [
    el("h2", { class: "crew-glance__title", id: "crew-glance-title" }, "Crew at a glance"),
    el("div", { class: "crew-glance__grid" }, [
      section("crew-glance-alerts-title", "Open alerts by severity", [
        sev === null || sev === undefined ? sectionError(onRetry, "the crew's alerts") : severityBar({ counts: sev, id: "crew-sev-bar" }),
        el("p", { class: "crew__meta" }, data.summary.withOpenAlerts === null ? "" : `${data.summary.withOpenAlerts} of ${data.summary.crewCount} crew members have an open alert.`),
        el("p", {}, el("a", { class: "btn btn--secondary btn--sm", href: "#/alerts" }, [icon("bell"), "Review alerts"])),
      ]),
      section("crew-glance-shared-title", "Shared check-ins · last 30 days", [
        barList({ items: data.crew.map((m) => ({ label: m.name, value: m.sharedWellbeing.status === "ok" ? m.sharedWellbeing.count30d : null, href: `#/wellbeing/${m.crewId}` })) }),
        el("p", { class: "crew__note" }, "Counts only check-ins the astronaut chose to share. Private check-ins are never counted."),
      ]),
    ]),
    section("crew-glance-trends-title", "7-day trends · daily averages", [
      el("p", { class: "crew__note" }, "Daily averages from stored synthetic readings (UTC days). Dashed line: the crew member's personal baseline. Hover or focus a point to read its value; select a name to open that crew member."),
      el("div", { class: "table-wrap crew-glance__table-wrap" }, el("table", { class: "table crew-glance__table" }, [
        el("caption", { class: "sr-only" }, "Seven-day daily averages per crew member"),
        el("thead", {}, el("tr", {}, [el("th", { scope: "col" }, "Crew member"), ...TREND_METRICS.map((t) => el("th", { scope: "col" }, `${t.label} (${t.unit})`))])),
        el("tbody", {}, trendRows),
      ])),
    ]),
  ]);
}

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
    glanceSection(data, onRetry),
    crewSection,
    alertsSection,
    sharedSection,
  ];
}

// ---- Detail (#/crew/AH-0n) ---------------------------------------------------------------

const SPOKEN_UNIT = { heartRate: "beats per minute", spo2: "percent", bloodPressure: "millimetres of mercury", sleepDuration: "hours" };
const STATUS_LABEL = { new: "New", acknowledged: "Acknowledged" };

function baselineText(item) {
  if (item.baseline == null) return "No baseline recorded";
  if (item.key === "bloodPressure") return `Baseline: ${formatNumber(item.baseline.systolic)}/${formatNumber(item.baseline.diastolic)} ${item.unit}`;
  return `Baseline: ${formatNumber(item.baseline, item.key === "sleepDuration" ? 1 : 0)} ${item.unit}`;
}

/** One vital ring on the stage: value, unit, baseline, time, provenance and data-quality labels as text. */
function vitalRing(item, now, onRetry, alertSeverity = "") {
  const id = `crew-ring-${item.key}`;
  if (item.state === "ok") {
    const bp = item.key === "bloodPressure";
    const visual = bp ? `${formatNumber(item.systolic)}/${formatNumber(item.diastolic)}` : formatNumber(item.value, item.key === "sleepDuration" ? 1 : 0);
    return createRing({
      id,
      label: item.label,
      value: visual,
      unit: item.unit,
      fraction: ringFraction(item),
      baseline: baselineText(item),
      meta: stamp(item.timestamp, now),
      spoken: `${item.label}: ${bp ? visual.replace("/", " over ") : visual} ${SPOKEN_UNIT[item.key] || item.unit}${alertSeverity ? `. Open ${alertSeverity} alert for this measure` : ""}`,
      alertSeverity,
      tags: [provenanceTag(item), ...dataBadges(item)].filter(Boolean),
    });
  }
  return createRing({
    id,
    label: item.label,
    value: "—",
    unit: "",
    fraction: null,
    baseline: baselineText(item),
    tags: dataBadges(item),
    extra: item.state === "error" ? sectionError(onRetry, "this reading") : null,
  });
}

/** Open alerts as a numbered list matching the pins; each title opens the pop-up. */
function numberedAlerts(alerts, onOpenAlert) {
  return el("ol", { class: "crew__alerts crew-scan__alerts", role: "list" }, alerts.items.map((a, i) => {
    const view = SEVERITY_VIEW[a.severity] || SEVERITY_VIEW.info;
    return el("li", { class: ["alert-item", view.item, "crew-scan__alert"] }, [
      el("span", { class: ["alert-num", `alert-num--${a.severity}`], "aria-hidden": "true" }, String(i + 1)),
      el("div", { class: "alert-item__body" }, [
        el("button", { type: "button", class: "alert-open", "data-alert-open": String(i + 1), onClick: (e) => onOpenAlert(a, e.target && e.target.closest ? e.target.closest("button") : null, i + 1) }, alertTitle(a)),
        // The explanation is in the pop-up ("What was detected"); the list stays compact beside the stage.
        el("p", { class: "crew__tags" }, [
          badge(view.badge, view.icon, view.label),
          badge("badge--neutral", "clock", STATUS_LABEL[a.status] || a.status),
          el("span", { class: "sim-tag" }, "Synthetic"),
        ]),
        el("p", { class: "crew__meta" }, [`Pin ${i + 1} · ${ZONE_LABELS[zoneForRule(a.ruleId)] || "Body"} · detected `, utcTime(a.detectedAt)]),
      ]),
    ]);
  }));
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

function detailView(data, onRetry, onOpenAlert) {
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
    el("div", { class: "crew-scan-layout" }, [
      el("section", { class: "scan-stage scan-stage--fill crew-scan", "aria-labelledby": "crew-detail-vitals-title" }, [
        el("div", { class: "scan-stage__head" }, [
          el("div", { class: "scan-stage__heading" }, [
            el("h2", { class: "scan-stage__title", id: "crew-detail-vitals-title" }, "Body scan · latest readings"),
            el("span", { class: "sim-tag" }, [icon("flask-conical", { size: 12 }), "SIMULATED"]),
          ]),
          severityLegend(),
        ]),
        el("p", { class: "scan-stage__note" }, "Most recent usable reading of each measure. Invalid readings are left out. Times are UTC."),
        createVitalsStage({
          items: data.vitals.items,
          pins: alerts.status === "ok" ? alertPins(alerts.items, { who: `${p.name}: ` }) : [],
          ringFor: (item, severity) => vitalRing(item, data.generatedAt, onRetry, severity),
          onPinClick: (pin, button) => onOpenAlert(pin.alert, button, pin.number),
        }),
        el("div", { class: "scan-stage__foot" }, [
          el("p", { class: "scan-stage__note" },
            "Illustration only: the body is a stylised drawing and the ring fill uses a fixed display scale — neither is a health assessment. " +
              (alerts.status === "ok" && alerts.items.length ? "Numbered pins mark open alerts, coloured by severity; a ring takes the colour of an open alert for that measure. The same alerts are listed under Open alerts." : "No pins: no open alerts are shown.")),
        ]),
      ]),
      // Status, open alerts and the cognitive check beside the stage (no half-empty rows).
      el("div", { class: "crew-scan-layout__side" }, [
        section("crew-detail-status-title", "Status", [
          el("p", { class: "crew__tags" }, stateBadge(data.state, "crew__status-badge")),
          el("p", { class: "crew__text" }, data.state.reason),
          el("p", { class: "crew__note" }, data.state.note),
        ]),
        section("crew-detail-alerts-title", "Open alerts", [
          alerts.status === "error"
            ? sectionError(onRetry, "open alerts")
            : alerts.items.length
              ? numberedAlerts(alerts, onOpenAlert)
              : el("p", { class: "crew__empty" }, "No open alerts."),
          el("p", { class: "crew__note" }, "Acknowledge and resolve on the Alerts page, where every action is recorded."),
          el("p", {}, el("a", { class: "btn btn--secondary btn--sm", href: "#/alerts" }, [icon("bell"), "Open Alerts page"])),
        ]),
        section("crew-detail-cognitive-title", "Cognitive check", [
          data.cognitive.status === "error"
            ? sectionError(onRetry, "cognitive checks")
            : el("p", { class: "crew__text" }, data.cognitive.lastAt ? ["Last completed ", ...stamp(data.cognitive.lastAt, data.generatedAt)] : "No cognitive check recorded."),
        ]),
      ]),
    ]),
    sharedWellbeingSection(data.sharedWellbeing, onRetry),
    section("crew-detail-sleep-title", "Sleep — last 7 nights", [
      sleep.status === "error"
        ? sectionError(onRetry, "the sleep summary")
        : el("p", { class: "crew__text" }, sleepText),
      sleep.status === "error" || !sleep.recorded
        ? null
        : el("ul", { class: "crew-sleep", role: "list" },
            sleep.nights.map((n) => el("li", { class: ["crew-sleep__night", n.hours === null ? "is-missing" : ""] }, [
              el("span", { class: "crew-sleep__date" }, formatDate(Date.parse(`${n.date}T00:00:00.000Z`), { timeZone: "UTC" })),
              srOnly(": "),
              el("span", { class: "crew-sleep__value" }, n.hours === null ? "No data" : `${formatNumber(n.hours, 1)} h`),
            ]))),
    ]),
    messagesSection(data.messages, data, onRetry),
  ];
  return { view, heading };
}

// ---- Renderer ---------------------------------------------------------------------------

/** TEST SEAM: tests pass fake loaders returning presentation data. Pages use renderCrewMonitor. */
export function createCrewMonitorRenderer({ loadSnapshot, loadDetail, loadAlertDetail = null, host = null, subscribe = onHealthChanged }) {
  return function render(container, session, { signal, hash = "#/crew", focus = false } = {}) {
    const route = parseCrewRoute(hash);
    const root = el("div", { class: "crew", "aria-busy": "false" });
    container.replaceChildren(root);
    let generation = 0;
    let dialog = null;
    if (signal) signal.addEventListener("abort", () => { if (dialog) dialog.close(); }, { once: true });

    /** Read-only alert pop-up for the Medical Officer; actions stay on the Alerts page. */
    async function openAlert(profile, alert, trigger, pinNumber) {
      if (dialog) dialog.close();
      const detail = await loadAlertDetailSafely(loadAlertDetail, session, alert.number);
      if (signal && signal.aborted) return;
      const a = detail ? detail.alert : alert;
      const body = [
        ...alertPopupBody({ alert, detail, pinNumber, who: `${profile.name} (${profile.crewId})` }),
        createAlertLifecycle(detail ? lifecycleFromDetail(detail) : lifecycleFromDetail(alert), { viewer: "officer", id: "crew-life-title" }),
        el("p", { class: "alert-pop__note" }, "This view is read-only. Acknowledge and resolve this alert on the Alerts page, where every action is recorded with its note."),
      ];
      const footer = a.number
        ? [el("a", { class: "btn btn--primary btn--sm", href: `#/alerts/${a.number}` }, [icon("arrow-right"), "Review on Alerts page", srOnly(` (${a.number})`)])]
        : [];
      dialog = openDialog({ kind: "modal", title: alertTitle(a), body, footer, returnFocus: trigger, onClose: () => { dialog = null; }, host });
    }

    // Live updates: the crew list follows every crew member; a detail view only its own.
    subscribe({ signal, crewId: () => (route.view === "detail" ? route.crewId : ""), reload: () => keepFocus(root, () => load({ quiet: true })) });

    async function load({ quiet = false } = {}) {
      const token = ++generation;
      if (!quiet) {
        root.setAttribute("aria-busy", "true");
        for (const b of root.querySelectorAll("[data-retry]")) b.disabled = true;
      }
      if (!root.childNodes.length) root.replaceChildren(...loadingView(route.view === "list" ? "Loading the crew…" : "Loading crew member…"));

      let result;
      try {
        if (route.view === "list") result = await loadSnapshot(session);
        else result = await loadDetail(session, route.view === "detail" ? route.crewId : ""); // "" → service says not found
      } catch {
        result = { status: "unavailable", reason: "unexpected_error" };
      }
      if (token !== generation || (signal && signal.aborted)) return;
      if (quiet && !(result && result.status === "ready")) return; // keep what is shown

      const retry = () => load();
      if (result && result.status === "ready") {
        if (route.view === "list") root.replaceChildren(...listView(result, retry));
        else {
          const { view, heading } = detailView(result, retry, (alert, trigger, n) => openAlert(result.profile, alert, trigger, n));
          root.replaceChildren(...view);
          centreStages(root);
          if (focus && token === 1 && !quiet) heading.focus(); // opening a crew member moves focus to its name
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
  loadAlertDetail: (session, number) => getAlertDetail(session, number),
});
