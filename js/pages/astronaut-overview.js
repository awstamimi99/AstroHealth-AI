// js/pages/astronaut-overview.js — the #/overview view (Sprint 4)
//
//   import { renderAstronautOverview } from "./astronaut-overview.js";
//   renderAstronautOverview(container, session, { signal });
//
// • Astronaut: loads their own Overview through the service and renders it.
// • Medical Officer: a neutral placeholder with links to Crew Monitor and
//   Alerts. No astronaut data is loaded (decision D1).
//
// Presentation only: every rule (identity, privacy, status, staleness, UTC
// days) lives in js/services/astronaut-overview-service.js. This file never
// imports the database. Every database string is inserted as text via el().
//
// Async safety: app-shell passes an AbortSignal per navigation. A result
// that arrives after the user navigated away (or after a newer Retry) is
// dropped, so it can never overwrite the current route.
//
// Body-scan redesign: the latest vital signs are shown as 4 rings around a
// decorative wireframe body on a dark scan stage (js/components/body-scan.js),
// joined to their body zone by dashed lines. Open alerts are numbered pins
// (zone from js/components/alert-zones.js) AND a text list; both open an
// accessible pop-up (js/components/dialog.js) with the alert's rule, readings
// and limitation from alerts-service.js. "View action plan" opens a drawer
// with static synthetic review steps (js/components/action-plans.js); ticks
// are kept in this browser per user and alert (js/core/action-plan-progress.js).
// Acknowledge / Message / Escalate / Resolve are shown disabled with the
// reason: astronauts can't perform them in this version.

import { getAstronautOverview } from "../services/astronaut-overview-service.js";
import { getAlertDetail } from "../services/alerts-service.js";
import { icon } from "../components/icon.js";
import { createRing } from "../components/body-scan.js";
import { zoneForRule, ZONE_LABELS } from "../components/alert-zones.js";
import { createVitalsStage, alertPins, pinNumbers, ringFraction, centreStages, severityLegend } from "../components/vitals-stage.js";
import { alertPopupBody, alertTitle, loadAlertDetailSafely } from "../components/alert-popup.js";
import { planForRule, PLAN_NOTICE, VIDEO_PLACEHOLDER } from "../components/action-plans.js";
import { createAlertLifecycle, lifecycleFromDetail } from "../components/alert-lifecycle.js";
import { openDialog } from "../components/dialog.js";
import { planProgress } from "../core/action-plan-progress.js";
import { onHealthChanged, keepFocus } from "../core/live-updates.js";
import { el } from "../core/utils/dom.js";
import { formatDate, formatDateTime, formatNumber, formatRelative, formatTime } from "../core/utils/format.js";

const ASTRONAUT_ROLE = "astronaut";
const UTC = Object.freeze({ timeZone: "UTC" });
/** Fixed sleep-chart scale (hours) so bars are comparable day to day. */
const SLEEP_SCALE_HOURS = 10;

const TONE_BADGE = {
  critical: "badge--critical",
  warning: "badge--warning",
  info: "badge--info",
  ok: "badge--ok",
  neutral: "badge--neutral",
};
const SEVERITY_VIEW = {
  critical: { label: "Critical", icon: "circle-alert", badge: "badge--critical", item: "alert-item--critical" },
  warning: { label: "Warning", icon: "triangle-alert", badge: "badge--warning", item: "alert-item--warning" },
  info: { label: "Info", icon: "info", badge: "badge--info", item: "" },
};
const ALERT_STATUS_LABEL = { new: "New", acknowledged: "Acknowledged", resolved: "Resolved" };
const VITAL_VIEW = {
  heartRate: { icon: "heart", decimals: 0, spokenLabel: "Heart rate", spokenUnit: "beats per minute" },
  spo2: { icon: "droplet", decimals: 0, spokenLabel: "SpO₂, blood oxygen saturation", spokenUnit: "percent" },
  bloodPressure: { icon: "activity", decimals: 0, spokenLabel: "Blood pressure", spokenUnit: "millimetres of mercury" },
  sleepDuration: { icon: "moon", decimals: 1, spokenLabel: "Sleep duration", spokenUnit: "hours" },
};
// ---- Small view helpers ----------------------------------------------------------

const srOnly = (text) => el("span", { class: "sr-only" }, text);
const isoOf = (ts) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
};

/** <time datetime="…">14 Nov 2026, 14:00 UTC</time> */
function utcTime(ts, { dateToo = true } = {}) {
  const text = dateToo ? formatDateTime(ts, UTC) : formatTime(ts, UTC);
  return el("time", { datetime: isoOf(ts) }, `${text} UTC`);
}

/** "8 Nov" for a "YYYY-MM-DD" UTC date key. */
function shortUtcDate(dateKey) {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? dateKey : d.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
}

const badge = (className, iconName, text) => el("span", { class: ["badge", className] }, [icon(iconName), text]);

/** Provenance: seed/simulation → "Simulated"; manual readings are not called simulated. */
function provenanceTag(item) {
  if (item.simulated) {
    const where = item.source === "simulation" ? "Simulation Center" : "demo history";
    return el("span", { class: "sim-tag", title: `Simulated · ${where}` }, [icon("flask-conical", { size: 12 }), "Simulated", srOnly(` (${where})`)]);
  }
  if (item.source === "manual") return badge("badge--neutral", "user", "Manual entry");
  return badge("badge--neutral", "info", "Source unknown");
}

function retryButton(onRetry, label = "Retry") {
  return el("button", { class: "btn btn--secondary btn--sm overview-retry", type: "button", onClick: onRetry, "data-retry": "" }, [icon("rotate-ccw"), label]);
}

/** "Couldn't load this section" + Retry (used inside a section that failed). */
function sectionError(onRetry, what = "this section") {
  return el("div", { class: "overview__error", role: "status" }, [
    el("p", {}, [icon("circle-alert"), ` Couldn't load ${what}.`]),
    retryButton(onRetry),
  ]);
}

/** A card section with a unique h2 id for aria-labelledby. */
function section(id, title, children, className = "") {
  return el("section", { class: ["card", "overview__section", className], "aria-labelledby": id }, [
    el("h2", { class: "overview__title", id }, title),
    ...children,
  ]);
}

// ---- Sections -----------------------------------------------------------------------

function headerSection(data) {
  const { astronaut, mission } = data;
  const missionText = mission.available
    ? `Mission ${mission.name} · ${mission.missionDay ? `Mission Day ${mission.missionDay}` : "Mission Day not available"}`
    : "Mission context not available";
  return el("section", { class: "overview__header", "aria-labelledby": "ov-welcome-title" }, [
    el("h2", { class: "overview__welcome", id: "ov-welcome-title" }, `Welcome, ${astronaut.displayName}`),
    el("p", { class: "overview__subtitle" }, `${astronaut.crewId} · ${astronaut.missionRole} · ${missionText}`),
  ]);
}

function statusSection(overall, onRetry) {
  return section("ov-status-title", "Alert status", [
    el("p", { class: "overview__status" }, [
      el("span", { class: ["badge", "overview__status-badge", TONE_BADGE[overall.tone] || "badge--neutral"] }, [icon(overall.icon), overall.label]),
    ]),
    el("p", { class: "overview__text" }, overall.summary),
    el("p", { class: "overview__note" }, overall.note),
    overall.level === "unavailable" ? retryButton(onRetry) : null,
  ]);
}

function vitalValue(item, view) {
  if (item.key === "bloodPressure") {
    const sys = formatNumber(item.systolic, view.decimals);
    const dia = formatNumber(item.diastolic, view.decimals);
    return {
      visual: `${sys}/${dia}`,
      spoken: `${sys} over ${dia} ${view.spokenUnit}`,
    };
  }
  const value = formatNumber(item.value, view.decimals);
  return { visual: value, spoken: `${value} ${view.spokenUnit}` };
}

function baselineText(item, view) {
  if (item.baseline == null) return "No baseline recorded";
  if (item.key === "bloodPressure") {
    return `Your baseline: ${formatNumber(item.baseline.systolic)}/${formatNumber(item.baseline.diastolic)} ${item.unit}`;
  }
  return `Your baseline: ${formatNumber(item.baseline, view.decimals)} ${item.unit}`;
}

// ---- Scan stage: 4 rings around the body + numbered alert pins (js/components/vitals-stage.js) ----

function vitalRing(item, data, onRetry, alertSeverity = "") {
  const view = VITAL_VIEW[item.key];
  const id = `ov-ring-${item.key}`;
  const history = el("a", { class: "vitals-stage__ring-link", href: "#/physical", "aria-label": `View ${item.label.toLowerCase()} history` }, ["History", icon("arrow-right")]);
  let ring;
  if (item.state === "ok") {
    const value = vitalValue(item, view);
    ring = createRing({
      id,
      label: item.label,
      value: value.visual,
      unit: item.unit,
      fraction: ringFraction(item),
      baseline: baselineText(item, view),
      meta: [utcTime(item.timestamp, { dateToo: false }), ` · ${formatRelative(item.timestamp, data.generatedAt)}`],
      spoken: `${view.spokenLabel}: ${value.spoken}${alertSeverity ? `. Open ${alertSeverity} alert for this measure` : ""}`,
      alertSeverity,
      tags: [
        provenanceTag(item),
        item.quality === "suspect" ? badge("badge--neutral", "eye", "Data quality: suspect") : null,
        item.stale ? badge("badge--neutral", "clock", "No newer reading") : null,
      ].filter(Boolean),
      extra: history,
    });
  } else {
    const message =
      item.state === "error" ? "Couldn't load this reading."
        : item.state === "incomplete" ? "No complete reading (systolic and diastolic from the same measurement)."
          : item.invalidOnly ? "No usable recent reading — recent readings were marked invalid." : "No recent reading.";
    ring = createRing({ id, label: item.label, value: "—", unit: "", fraction: null, baseline: baselineText(item, view), meta: message, extra: item.state === "error" ? retryButton(onRetry) : history });
  }
  return ring;
}

function scanStageSection(data, onRetry, onOpenAlert) {
  const pins = data.alerts && data.alerts.status === "ok" ? alertPins(data.alerts.items) : [];
  const stage = createVitalsStage({
    items: data.vitals.items,
    pins,
    ringFor: (item, severity) => vitalRing(item, data, onRetry, severity),
    onPinClick: (pin, button) => onOpenAlert(pin.alert, button, pin.number),
  });
  return el("section", { class: "scan-stage scan-stage--fill ov-scan", "aria-labelledby": "ov-vitals-title" }, [
    el("div", { class: "scan-stage__head" }, [
      el("div", { class: "scan-stage__heading" }, [
        el("h2", { class: "scan-stage__title", id: "ov-vitals-title" }, "Body scan · latest vital signs"),
        el("span", { class: "sim-tag" }, [icon("flask-conical", { size: 12 }), "SIMULATED"]),
        pins.length
          ? el("span", { class: "ov-scan__mapped", "aria-label": `${pins.length} open alert${pins.length === 1 ? "" : "s"} mapped to the body scan` }, [
              icon("activity", { size: 13 }),
              `${pins.length} mapped to body`,
            ])
          : null,
      ]),
      severityLegend(),
    ]),
    el("p", { class: "scan-stage__note" }, "The most recent usable reading of each measure. Invalid readings are left out. Times are UTC."),
    stage,
    el("div", { class: "scan-stage__foot" }, [
      el("p", { class: "scan-stage__note" },
        "Illustration only: the body is a stylised drawing and the ring fill uses a fixed display scale — neither is a health assessment. " +
          (pins.length ? "Numbered pins mark your open alerts, coloured by severity. A resolved alert is removed from the body; recently resolved alerts are still listed beside the scan. Only an open physical alert colours a vital ring." : "You have no open alerts, so no pins are shown and every ring is blue. Resolved alerts are never marked on the body.")),
    ]),
  ]);
}

function sideAlertsSection(alerts, onRetry, onOpenAlert) {
  let body;
  if (alerts.status === "error") body = [sectionError(onRetry, "your alerts")];
  else if (!alerts.items.length) body = [el("p", { class: "overview__empty" }, "No open alerts.")];
  else {
    body = [
      el("ol", { class: "ov-alerts", role: "list" }, alerts.items.map((a, i, list) => {
        const view = SEVERITY_VIEW[a.severity] || SEVERITY_VIEW.info;
        const pin = pinNumbers(list)[i]; // null = resolved: no longer on the body
        return el("li", { class: ["alert-item", view.item, "ov-alert"], "data-alert-card": String(i + 1) }, [
          pin === null
            ? el("span", { class: "alert-num alert-num--resolved", "aria-hidden": "true" }, icon("check", { size: 14 }))
            : el("span", { class: ["alert-num", `alert-num--${a.severity}`], "aria-hidden": "true" }, String(pin)),
          el("div", { class: "alert-item__body" }, [
            el("button", { type: "button", class: "alert-open", "data-alert-open": String(i + 1), onClick: (e) => onOpenAlert(a, e.target && e.target.closest ? e.target.closest("button") : null, pin || 0) },
              `${[a.number, a.title].filter(Boolean).join(" · ")}`),
            el("p", { class: "overview__tags" }, [
              badge(view.badge, view.icon, view.label),
              badge(a.status === "resolved" ? "badge--ok" : "badge--neutral", a.status === "resolved" ? "circle-check" : "clock", ALERT_STATUS_LABEL[a.status] || a.status),
              el("span", { class: "sim-tag" }, "Synthetic"),
            ]),
            pin === null
              ? el("p", { class: "overview__meta ov-alert__mapping" }, [icon("circle-check", { size: 13 }), "Resolved ", a.resolvedAt ? utcTime(a.resolvedAt) : "", " · no longer marked on the body"])
              : el("p", { class: "overview__meta ov-alert__mapping" }, [
                  icon("activity", { size: 13 }),
                  `${a.ruleId === "WB-01" ? "Mental wellbeing" : "Body"} pin ${pin} · ${ZONE_LABELS[zoneForRule(a.ruleId)] || "Body"} · detected `,
                  utcTime(a.detectedAt),
                ]),
          ]),
        ]);
      })),
      alerts.moreCount ? el("p", { class: "overview__meta" }, `and ${alerts.moreCount} more open alert${alerts.moreCount === 1 ? "" : "s"}`) : null,
    ];
  }
  return section("ov-alerts-title", "Alerts on body", [
    ...body,
    el("p", {}, el("a", { class: "btn btn--secondary btn--sm", href: "#/alerts" }, [icon("bell"), "View all alerts"])),
  ], "ov-side");
}

function messageSection(messages, data, onRetry) {
  let body;
  if (messages.status === "error") {
    body = [sectionError(onRetry, "your messages")];
  } else if (!messages.latest) {
    body = [el("p", { class: "overview__empty" }, "No unacknowledged messages from the Medical Officer.")];
  } else {
    const m = messages.latest;
    body = [
      el("div", { class: "overview__message" }, [
        el("div", { class: "overview__message-head" }, [
          el("span", { class: "overview__message-avatar", "aria-hidden": "true" }, icon("user")),
          el("div", { class: "overview__message-sender" }, [
            el("strong", {}, `From the ${m.from}`),
            el("span", { class: "overview__meta" }, ["Sent ", utcTime(m.sentAt), ` · ${formatRelative(m.sentAt, data.generatedAt)}`]),
          ]),
          el("span", { class: "sim-tag" }, "Synthetic"),
        ]),
        el("div", { class: "overview__message-bubble" }, [
          icon("message-circle", { size: 17 }),
          el("p", { class: "overview__message-body" }, m.body || "(empty message)"),
        ]),
      ]),
      messages.moreCount ? el("p", { class: "overview__meta" }, `and ${messages.moreCount} more unacknowledged message${messages.moreCount === 1 ? "" : "s"} from the Medical Officer`) : null,
      el("p", { class: "overview__note" }, "Read-only here. Medical Officer alert actions are handled on the Alerts page."),
    ];
  }
  return section("ov-message-title", "Message from the Medical Officer", body);
}

function routineRow(iconName, title, content) {
  return el("li", { class: "overview__routine-item" }, [
    el("span", { class: "overview__routine-icon" }, icon(iconName)),
    el("div", { class: "overview__routine-body" }, [el("h3", { class: "overview__routine-title" }, title), ...content]),
  ]);
}

function routineSection(routine, data, onRetry) {
  const { checkin, vitals, cognitive } = routine;
  const failed = (what) => [sectionError(onRetry, what)];

  const checkinContent =
    checkin.status === "error"
      ? failed("your check-in status")
      : checkin.state === "done"
        ? [
            el("p", { class: "overview__tags" }, [
              badge("badge--ok", "circle-check", "Completed today"),
              badge("badge--neutral", checkin.shared ? "eye" : "eye-off", checkin.shared ? "Shared with the Medical Officer" : "Private — not shared"),
            ]),
            el("p", { class: "overview__meta" }, ["At ", utcTime(checkin.completedAt, { dateToo: false })]),
          ]
        : [
            el("p", { class: "overview__tags" }, badge("badge--neutral", "clock", "Not completed today")),
            el("p", { class: "overview__meta" }, checkin.lastAt ? ["Last check-in ", utcTime(checkin.lastAt)] : "No check-in recorded."),
          ];

  let vitalsContent;
  if (vitals.status === "error") {
    vitalsContent = failed("your vital-sign times");
  } else if (vitals.state === "none") {
    vitalsContent = [el("p", { class: "overview__meta" }, "No vital-sign readings stored.")];
  } else {
    vitalsContent = [
      el("p", { class: "overview__tags" },
        vitals.state === "today" ? badge("badge--ok", "circle-check", "Recorded today") : badge("badge--neutral", "clock", "Not recorded today")),
      el("p", { class: "overview__meta" }, ["Latest reading ", utcTime(vitals.lastAt), ` · ${formatRelative(vitals.lastAt, data.generatedAt)}`]),
      vitals.partial ? el("p", { class: "overview__note" }, "Some readings couldn't be loaded, so a newer one may exist.") : null,
    ];
  }

  const cognitiveContent =
    cognitive.status === "error"
      ? failed("your cognitive checks")
      : cognitive.state === "none"
        ? [el("p", { class: "overview__meta" }, "No cognitive check recorded yet.")]
        : [el("p", { class: "overview__meta" }, ["Last completed ", utcTime(cognitive.lastAt), ` · ${formatRelative(cognitive.lastAt, data.generatedAt)}`])];

  return section("ov-routine-title", "Today's routine", [
    el("p", { class: "overview__note" }, `Today (UTC mission day): ${formatDate(Date.parse(`${routine.today}T00:00:00.000Z`), UTC)}.`),
    el("ul", { class: "overview__routine", role: "list" }, [
      routineRow("brain", "Wellbeing check-in", checkinContent),
      routineRow("activity", "Vital signs", vitalsContent),
      routineRow("gauge", "Cognitive check", cognitiveContent),
    ]),
  ]);
}

function sleepSummaryText(sleep) {
  if (!sleep.recorded) return "No sleep data in the last seven nights.";
  const parts = [`${sleep.recorded} of ${sleep.nights.length} nights recorded.`, `Average ${formatNumber(sleep.average, 1)} h.`];
  if (sleep.baseline === null) parts.push("No baseline recorded.");
  else {
    parts.push(`Your baseline: ${formatNumber(sleep.baseline, 1)} h.`);
    parts.push(`${sleep.belowBaseline} of ${sleep.recorded} recorded nights below your baseline.`);
  }
  return parts.join(" ");
}

function sleepSection(sleep, onRetry) {
  if (sleep.status === "error") return section("ov-sleep-title", "Sleep — last 7 nights", [sectionError(onRetry, "your sleep trend")]);
  const percent = (h) => `${Math.max(2, Math.min(100, (h / SLEEP_SCALE_HOURS) * 100)).toFixed(1)}%`;
  const ratio = (h) => Math.max(0, Math.min(1, h / SLEEP_SCALE_HOURS)).toFixed(3);
  const chartStyle = sleep.baseline === null ? {} : { "--baseline-ratio": ratio(sleep.baseline) };
  return section("ov-sleep-title", "Sleep — last 7 nights", [
    el("p", { class: "overview__text" }, sleepSummaryText(sleep)),
    sleep.recorded
      ? el("div", { class: "overview-sleep", style: chartStyle }, [
          el("div", { class: "overview-sleep__scale", "aria-hidden": "true" }, [
            el("span", {}, "10 h"),
            el("span", {}, "5 h"),
            el("span", {}, "0 h"),
          ]),
          sleep.baseline === null ? null : el("span", { class: "overview-sleep__baseline", "aria-hidden": "true" }, "baseline"),
          el("ul", { class: "overview-sleep__nights", role: "list", "aria-label": "Sleep per night (UTC dates)" },
            sleep.nights.map((night) =>
              el("li", { class: ["overview-sleep__night", night.hours === null ? "is-missing" : ""] }, [
                el("span", { class: "overview-sleep__track", "aria-hidden": "true" },
                  night.hours === null ? null : el("span", { class: "overview-sleep__bar", style: { "--h": percent(night.hours) } })),
                el("span", { class: "overview-sleep__value" }, night.hours === null ? "No data" : `${formatNumber(night.hours, 1)} h`),
                el("span", { class: "overview-sleep__date" }, shortUtcDate(night.date)),
              ])
            )),
        ])
      : null,
    el("p", { class: "overview__note" }, "Sleep is recorded on waking and dated by the UTC day. Missing nights are shown as “No data”, never as zero."),
  ]);
}

// ---- Whole-page states ------------------------------------------------------------

function loadingView() {
  return [
    el("p", { class: "sr-only", role: "status" }, "Loading your overview…"),
    el("div", { class: "overview__loading", "aria-hidden": "true" }, [
      el("span", { class: "skeleton skeleton--title" }),
      el("div", { class: "grid grid--4" }, [1, 2, 3, 4].map(() => el("span", { class: "skeleton skeleton--block" }))),
      el("span", { class: "skeleton skeleton--block" }),
    ]),
  ];
}

const REFUSAL_VIEW = {
  database_error: { icon: "database", title: "Overview unavailable", text: "Your data couldn't be read from this device's storage, so nothing is shown rather than guessing.", retry: true },
  unexpected_error: { icon: "database", title: "Overview unavailable", text: "Something went wrong while loading your overview. Nothing is shown rather than guessing.", retry: true },
  profile_missing: { icon: "user", title: "Astronaut profile not found", text: "No astronaut profile was found on this device for your account. The demo data on this device may be from an older version — clearing the site data and signing in again recreates it.", retry: true },
  account_mismatch: { icon: "lock", title: "Please sign in again", text: "Your session doesn't match an astronaut account on this device. Log out (top right) and sign in again.", retry: false },
  invalid_session: { icon: "lock", title: "Please sign in again", text: "Your session is incomplete. Log out (top right) and sign in again.", retry: false },
  no_session: { icon: "lock", title: "Please sign in again", text: "You're not signed in. Log out (top right) and sign in again.", retry: false },
  not_astronaut: { icon: "lock", title: "Astronaut overview", text: "This overview is only for astronaut accounts.", retry: false },
};

function refusalView(result, onRetry) {
  const view = REFUSAL_VIEW[result.reason] || REFUSAL_VIEW.unexpected_error;
  return el("section", { class: "card", role: "alert", "aria-labelledby": "ov-refusal-title" }, [
    el("div", { class: "state" }, [
      el("span", { class: "state__icon" }, icon(view.icon)),
      el("h2", { class: "state__title", id: "ov-refusal-title" }, view.title),
      el("p", { class: "state__text" }, view.text),
      view.retry ? retryButton(onRetry) : null,
    ]),
  ]);
}

/** D1: neutral placeholder for the Medical Officer — no astronaut data. */
export function medicalOfficerPlaceholder() {
  return el("section", { class: "card", "aria-labelledby": "ov-mo-title" }, [
    el("div", { class: "state" }, [
      el("span", { class: "state__icon" }, icon("layout-dashboard")),
      el("h2", { class: "state__title", id: "ov-mo-title" }, "Medical Officer overview"),
      el("p", { class: "state__text" }, "Astronaut personal overviews are available only when signed in with an astronaut account."),
      el("p", { class: "overview__links" }, [
        el("a", { class: "btn btn--secondary btn--sm", href: "#/crew" }, [icon("users"), "Crew Monitor"]),
        el("a", { class: "btn btn--secondary btn--sm", href: "#/alerts" }, [icon("bell"), "Alerts"]),
      ]),
    ]),
  ]);
}

function readyView(data, onRetry, onOpenAlert) {
  return [
    headerSection(data),
    // Stage on the left; status and its matching open-alert list beside it.
    el("div", { class: "ov-scan-layout" }, [
      scanStageSection(data, onRetry, onOpenAlert),
      el("div", { class: "ov-scan-layout__side" }, [
        statusSection(data.overall, onRetry),
        sideAlertsSection(data.alerts, onRetry, onOpenAlert),
      ]),
    ]),
    // The message reads as a conversation card beside the daily routine.
    el("div", { class: "ov-lower" }, [
      messageSection(data.messages, data, onRetry),
      routineSection(data.routine, data, onRetry),
    ]),
    sleepSection(data.sleep, onRetry),
  ];
}

// ---- Renderer ---------------------------------------------------------------------

/**
 * TEST SEAM: tests pass a fake `loadOverview` that returns presentation data.
 * It can't change identity — the real service does that. Pages and app-shell
 * use renderAstronautOverview (bound to getAstronautOverview).
 */
export function createOverviewRenderer({ loadOverview, loadAlertDetail = null, progress = planProgress, host = null, subscribe = onHealthChanged }) {
  return function render(container, session, { signal } = {}) {
    const root = el("div", { class: "overview", "aria-busy": "false" });
    container.replaceChildren(root);

    if (!session || session.role !== ASTRONAUT_ROLE) {
      root.append(medicalOfficerPlaceholder()); // D1: never loads astronaut data
      return Promise.resolve();
    }

    let generation = 0;
    let dialog = null;
    const isCurrent = (token) => token === generation && !(signal && signal.aborted);
    const userKey = typeof session.userId === "string" ? session.userId : "";
    const live = el("p", { class: "sr-only", role: "status", "aria-live": "polite" });
    if (signal) signal.addEventListener("abort", () => { if (dialog) dialog.close(); }, { once: true });

    // ---- Alert pop-up -------------------------------------------------------------
    async function openAlert(alert, trigger, pinNumber) {
      if (dialog) dialog.close();
      const detail = await loadAlertDetailSafely(loadAlertDetail, session, alert.number);
      if (signal && signal.aborted) return;
      const a = detail ? detail.alert : alert;
      const body = [
        ...alertPopupBody({ alert, detail, pinNumber }),
        el("p", { class: "overview__note", id: "ov-ack-note" }, "Acknowledge: only the Medical Officer can acknowledge alerts."),
        el("p", { class: "overview__note", id: "ov-msg-note" }, "Message the Medical Officer: sending messages from this view isn't available in this version."),
      ];
      const footer = [
        el("button", { type: "button", class: "btn btn--primary btn--sm", "data-plan-open": "", onClick: () => { dialog.close(); openPlan(a, detail, trigger); } }, [icon("check"), "View action plan"]),
        el("button", { type: "button", class: "btn btn--secondary btn--sm", disabled: true, "aria-describedby": "ov-ack-note" }, [icon("check"), "Acknowledge"]),
        el("button", { type: "button", class: "btn btn--secondary btn--sm", disabled: true, "aria-describedby": "ov-msg-note" }, [icon("send"), "Message the Medical Officer"]),
        a.number ? el("a", { class: "btn btn--ghost btn--sm", href: `#/alerts/${a.number}` }, [icon("arrow-right"), "Open on Alerts page"]) : null,
      ].filter(Boolean);
      dialog = openDialog({ kind: "modal", title: alertTitle(a), body, footer, returnFocus: trigger, onClose: () => { dialog = null; }, host });
    }

    // ---- Action-plan drawer ---------------------------------------------------------
    function openPlan(a, detail, trigger) {
      const plan = planForRule(a.ruleId);
      const ids = plan.steps.map((st) => st.id);
      const prog = el("progress", { class: "ov-plan__progress", max: String(ids.length), value: "0", "aria-labelledby": "ov-plan-count" });
      const count = el("p", { class: "overview__meta", id: "ov-plan-count" });
      const notice = el("p", { class: "overview__note", role: "note", hidden: true }, "This browser isn't saving your ticks right now, so they apply to this tab only.");
      const complete = el("p", { class: "banner ov-plan__complete", role: "status", hidden: true }, [icon("circle-check"), el("span", { class: "banner__text" }, "Review complete — thank you. The Medical Officer resolves the alert; see “How this alert is closed” below for what happens next.")]);
      const sync = (done, persisted) => {
        prog.setAttribute("value", String(done.length));
        count.textContent = `${done.length} of ${ids.length} review steps ticked`;
        if (done.length === ids.length) complete.removeAttribute("hidden");
        else complete.setAttribute("hidden", "");
        if (persisted === false) notice.removeAttribute("hidden");
      };
      const done0 = progress.get(userKey, a.number, ids);
      const steps = el("ul", { class: "ov-plan__steps", role: "list" }, plan.steps.map((st, i) => el("li", {}, el("label", { class: "ov-plan__step", for: `ov-step-${st.id}` }, [
        el("input", { type: "checkbox", id: `ov-step-${st.id}`, checked: done0.includes(st.id), onChange: (e) => {
          const r = progress.set(userKey, a.number, st.id, e.target.checked === true, ids);
          sync(r.done, r.persisted);
          live.textContent = `${r.done.length} of ${ids.length} review steps ticked.`;
        } }),
        el("span", {}, [el("strong", {}, `Step ${i + 1}. `), st.text]),
      ]))));
      const timeline = detail && detail.timeline.status === "ok" && detail.timeline.items.length
        ? el("ol", { class: "ov-plan__timeline", role: "list" }, detail.timeline.items.map((x) => el("li", {}, [el("strong", {}, x.label), ` · ${x.by} · `, utcTime(x.timestamp)])))
        : el("p", { class: "overview__empty" }, "Activity for this alert isn't available here; see the Alerts page.");
      const body = [
        el("p", { class: "banner" }, [icon("info"), el("span", { class: "banner__text" }, PLAN_NOTICE)]),
        el("h3", { class: "alert-pop__h3" }, plan.title),
        prog, count, notice, steps, complete,
        el("div", { class: "ov-plan__video" }, [
          el("span", { class: "ov-plan__video-icon", "aria-hidden": "true" }, icon("play")),
          el("div", {}, [el("p", {}, [el("strong", {}, VIDEO_PLACEHOLDER.title), " ", el("span", { class: "badge badge--neutral" }, "Placeholder")]), el("p", { class: "overview__note" }, VIDEO_PLACEHOLDER.text)]),
        ]),
        createAlertLifecycle(detail ? lifecycleFromDetail(detail) : lifecycleFromDetail(a), { viewer: "astronaut", id: "ov-life-title" }),
        el("h3", { class: "alert-pop__h3" }, "Alert activity"),
        timeline,
      ];
      const footer = [
        a.number ? el("a", { class: "btn btn--secondary btn--sm", href: `#/alerts/${a.number}` }, [icon("arrow-right"), "Open on Alerts page"]) : null,
      ].filter(Boolean);
      dialog = openDialog({ kind: "drawer", title: `Action plan · ${a.number || a.title}`, body, footer, returnFocus: trigger, onClose: () => { dialog = null; }, host });
      sync(done0);
    }

    // Live updates: a reading or alert for THIS astronaut changed (Live control,
    // a simulation step, an alert action) → reload quietly: the current view
    // stays until the new data is ready, with no loading state.
    let shownCrewId = null;
    subscribe({ signal, crewId: () => shownCrewId, reload: () => keepFocus(root, () => load({ quiet: true })) });

    async function load({ quiet = false } = {}) {
      const token = ++generation;
      if (!quiet) {
        root.setAttribute("aria-busy", "true");
        for (const button of root.querySelectorAll ? root.querySelectorAll("[data-retry]") : []) button.disabled = true;
      }
      if (!root.childNodes.length) root.replaceChildren(...loadingView());

      let result;
      try {
        result = await loadOverview(session);
      } catch {
        result = { status: "unavailable", reason: "unexpected_error" };
      }
      if (!isCurrent(token)) return; // navigated away, or a newer Retry is running

      const retry = () => load();
      if (quiet && !(result && result.status === "ready")) return; // keep what is shown; the next event or Retry tries again
      if (result && result.status === "ready") {
        shownCrewId = result.astronaut && typeof result.astronaut.crewId === "string" ? result.astronaut.crewId : null;
        root.replaceChildren(live, ...readyView(result, retry, openAlert));
        centreStages(root);
      } else root.replaceChildren(refusalView(result || {}, retry));
      root.setAttribute("aria-busy", "false");
    }

    return load();
  };
}

/** Render #/overview for the signed-in session into `container`. */
export const renderAstronautOverview = createOverviewRenderer({
  loadOverview: (session) => getAstronautOverview(session),
  loadAlertDetail: (session, number) => getAlertDetail(session, number),
});
