// js/components/crew-view.js — shared presentation pieces for the Medical
// Officer views (#/overview for the Medical Officer, #/crew, #/crew/AH-0n).
//
// Presentation only: every rule lives in js/services/crew-monitor-service.js.
// Database strings are always inserted as text via el(). No imports from
// js/db or from page modules.

import { icon } from "./icon.js";
import { el } from "../core/utils/dom.js";
import { formatDateTime, formatNumber, formatRelative } from "../core/utils/format.js";

const UTC = Object.freeze({ timeZone: "UTC" });

export const TONE_BADGE = Object.freeze({
  critical: "badge--critical",
  warning: "badge--warning",
  info: "badge--info",
  ok: "badge--ok",
  neutral: "badge--neutral",
});
export const SEVERITY_VIEW = Object.freeze({
  critical: { label: "Critical", icon: "circle-alert", badge: "badge--critical", item: "alert-item--critical" },
  warning: { label: "Warning", icon: "triangle-alert", badge: "badge--warning", item: "alert-item--warning" },
  info: { label: "Info", icon: "info", badge: "badge--info", item: "" },
});
const ALERT_STATUS_LABEL = { new: "New", acknowledged: "Acknowledged" };

export const srOnly = (text) => el("span", { class: "sr-only" }, text);
export const badge = (className, iconName, text) => el("span", { class: ["badge", className] }, [icon(iconName), text]);

const isoOf = (ts) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
};

/** <time datetime="…">14 Nov 2026, 14:00 UTC</time> */
export function utcTime(ts) {
  return el("time", { datetime: isoOf(ts) }, `${formatDateTime(ts, UTC)} UTC`);
}

/** "14 Nov 2026, 14:00 UTC · 2 h ago" */
export function stamp(ts, now) {
  return [utcTime(ts), ` · ${formatRelative(ts, now)}`];
}

/** Crew state badge: icon + text + tone colour (never orange). */
export function stateBadge(state, extraClass = "") {
  return el("span", { class: ["badge", TONE_BADGE[state.tone] || "badge--neutral", extraClass] }, [icon(state.icon), state.label]);
}

export function retryButton(onRetry, label = "Retry") {
  return el("button", { class: "btn btn--secondary btn--sm", type: "button", onClick: onRetry, "data-retry": "" }, [icon("rotate-ccw"), label]);
}

/** "Couldn't load …" + Retry, inside a section that failed. */
export function sectionError(onRetry, what = "this section") {
  return el("div", { class: "crew__error", role: "status" }, [el("p", {}, [icon("circle-alert"), ` Couldn't load ${what}.`]), retryButton(onRetry)]);
}

/** A card section with a unique h2 id for aria-labelledby. */
export function section(id, title, children, className = "") {
  return el("section", { class: ["card", "crew__section", className], "aria-labelledby": id }, [
    el("h2", { class: "crew__title", id }, title),
    ...children,
  ]);
}

export function syntheticNotice() {
  return el("div", { class: "banner crew__notice" }, [
    icon("info"),
    el("p", { class: "banner__text" },
      "All astronaut health, medical, mission and simulation records shown here are synthetic demo data. " +
        "Research & educational prototype — not a medical device and not clinically validated."),
  ]);
}

export function loadingView(label) {
  return [
    el("p", { class: "sr-only", role: "status" }, label),
    el("div", { class: "crew__loading", "aria-hidden": "true" }, [
      el("span", { class: "skeleton skeleton--title" }),
      el("div", { class: "crew-grid" }, [1, 2, 3].map(() => el("span", { class: "skeleton skeleton--block" }))),
    ]),
  ];
}

const REFUSAL_VIEW = {
  database_error: { icon: "database", title: "Crew data unavailable", text: "Crew data couldn't be read from this device's storage, so nothing is shown rather than guessing.", retry: true },
  unexpected_error: { icon: "database", title: "Crew data unavailable", text: "Something went wrong while loading crew data. Nothing is shown rather than guessing.", retry: true },
  account_mismatch: { icon: "lock", title: "Please sign in again", text: "Your session doesn't match a Medical Officer account on this device. Log out (top right) and sign in again.", retry: false },
  invalid_session: { icon: "lock", title: "Please sign in again", text: "Your session is incomplete. Log out (top right) and sign in again.", retry: false },
  no_session: { icon: "lock", title: "Please sign in again", text: "You're not signed in. Log out (top right) and sign in again.", retry: false },
  not_medical_officer: { icon: "lock", title: "Medical Officer only", text: "Crew-wide monitoring is only for Medical Officer accounts.", retry: false },
  invalid_crew_id: { icon: "users", title: "Crew member not found", text: "That address doesn't name a crew member. Crew IDs look like AH-01.", retry: false, back: true },
  unknown_crew_id: { icon: "users", title: "Crew member not found", text: "No crew member with that ID exists on this device.", retry: false, back: true },
};

/** Whole-view refusal (forbidden / unavailable / not found). No personal data. */
export function refusalView(result, onRetry) {
  const view = REFUSAL_VIEW[result && result.reason] || REFUSAL_VIEW.unexpected_error;
  return el("section", { class: "card", role: "alert", "aria-labelledby": "crew-refusal-title" }, [
    el("div", { class: "state" }, [
      el("span", { class: "state__icon" }, icon(view.icon)),
      el("h2", { class: "state__title", id: "crew-refusal-title", tabindex: "-1" }, view.title),
      el("p", { class: "state__text" }, view.text),
      view.retry ? retryButton(onRetry) : null,
      view.back ? el("a", { class: "btn btn--secondary btn--sm", href: "#/crew" }, [icon("users"), "Back to Crew Monitor"]) : null,
    ]),
  ]);
}

/** Provenance: seed/simulation → "Simulated"; manual is not called simulated. */
export function provenanceTag(item) {
  if (item.simulated) {
    const where = item.source === "simulation" ? "Simulation Center" : "demo history";
    return el("span", { class: "sim-tag", title: `Simulated · ${where}` }, [icon("flask-conical", { size: 12 }), "Simulated", srOnly(` (${where})`)]);
  }
  if (item.source === "manual") return badge("badge--neutral", "user", "Manual entry");
  return badge("badge--neutral", "info", "Source unknown");
}

const DECIMALS = { heartRate: 0, spo2: 0, bloodPressure: 0, sleepDuration: 1 };

/** "73 bpm", "118/76 mmHg", "—" */
export function vitalValueText(item) {
  if (item.state !== "ok") return "—";
  if (item.key === "bloodPressure") return `${formatNumber(item.systolic)}/${formatNumber(item.diastolic)} ${item.unit}`;
  return `${formatNumber(item.value, DECIMALS[item.key] ?? 0)} ${item.unit}`;
}

/** Data-quality badges for one reading (neutral — never a medical warning). */
export function dataBadges(item) {
  if (item.state === "error") return [badge("badge--neutral", "circle-alert", "Couldn't load")];
  if (item.state === "incomplete") return [badge("badge--neutral", "clock", "Incomplete reading")];
  if (item.state !== "ok") return [badge("badge--neutral", "clock", item.invalidOnly ? "No usable reading" : "No recent reading")];
  return [
    item.quality === "suspect" ? badge("badge--neutral", "eye", "Data quality: suspect") : null,
    item.stale ? badge("badge--neutral", "clock", "No newer reading") : null,
  ];
}

/** One compact reading row for a crew card: label, value, time, badges. */
export function vitalRow(item, now) {
  return el("li", { class: "crew-vital" }, [
    el("span", { class: "crew-vital__label" }, item.label),
    el("span", { class: "crew-vital__value" }, vitalValueText(item)),
    item.state === "ok" ? el("span", { class: "crew-vital__time" }, stamp(item.timestamp, now)) : null,
    el("span", { class: "crew-vital__tags" }, [item.state === "ok" && item.simulated ? el("span", { class: "sim-tag" }, "Simulated") : null, ...dataBadges(item)]),
  ]);
}

/** One open alert as an alert-item (no actions). */
export function alertItem(alert, { withCrew = false } = {}) {
  const view = SEVERITY_VIEW[alert.severity] || SEVERITY_VIEW.info;
  const who = withCrew && alert.crewId ? `${alert.name} (${alert.crewId}) · ` : "";
  return el("li", { class: ["alert-item", view.item] }, [
    el("span", { class: "alert-item__icon" }, icon(view.icon)),
    el("div", { class: "alert-item__body" }, [
      el("p", { class: "alert-item__title" }, `${who}${[alert.number, alert.title].filter(Boolean).join(" · ")}`),
      alert.explanation ? el("p", { class: "alert-item__text" }, alert.explanation) : null,
      el("p", { class: "crew__tags" }, [
        badge(view.badge, view.icon, view.label),
        badge("badge--neutral", "clock", ALERT_STATUS_LABEL[alert.status] || alert.status),
        el("span", { class: "sim-tag" }, "Synthetic"),
      ]),
      alert.detectedAt ? el("p", { class: "crew__meta" }, ["Detected ", utcTime(alert.detectedAt)]) : null,
    ]),
  ]);
}

/** "1 awaiting acknowledgement · 1 replied" / "No pending messages". */
export function messageSummary(messages) {
  if (messages.status === "error") return "Messages couldn't be loaded";
  const parts = [];
  if (messages.awaitingAcknowledgement) parts.push(`${messages.awaitingAcknowledgement} awaiting acknowledgement`);
  if (messages.replied) parts.push(`${messages.replied} replied`);
  return parts.length ? parts.join(" · ") : "No messages awaiting acknowledgement";
}

/** One crew card (used by #/crew). */
export function crewCard(member, now) {
  const titleId = `crew-card-${member.crewId}`;
  const shared = member.sharedWellbeing;
  return el("article", { class: "card crew-card", "aria-labelledby": titleId }, [
    el("div", { class: "crew-card__head" }, [
      el("h3", { class: "crew-card__name", id: titleId }, `${member.name} · ${member.crewId}`),
      el("p", { class: "crew__meta" }, member.missionRole),
    ]),
    el("p", { class: "crew__tags" }, stateBadge(member.state)),
    el("p", { class: "crew__text" }, member.state.reason),
    el("p", { class: "crew__meta" },
      member.alerts.status === "error" ? "Open alerts couldn't be loaded." : `${member.alerts.openCount} open alert${member.alerts.openCount === 1 ? "" : "s"}`),
    el("ul", { class: "crew-card__vitals", role: "list", "aria-label": `Latest readings for ${member.name}` }, member.vitals.items.map((v) => vitalRow(v, now))),
    el("p", { class: "crew__meta" },
      shared.status === "error"
        ? "Shared check-ins couldn't be loaded."
        : shared.lastSharedAt
          ? ["Last shared check-in ", utcTime(shared.lastSharedAt)]
          : "No shared check-in in the last 30 days."),
    el("p", { class: "crew__meta" }, messageSummary(member.messages)),
    el("p", {}, el("a", { class: "btn btn--secondary btn--sm", href: `#/crew/${member.crewId}` }, [icon("arrow-right"), "View details", srOnly(` for ${member.name}`)])),
  ]);
}
