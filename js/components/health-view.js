// js/components/health-view.js — shared presentation for #/physical and
// #/wellbeing (Sprint 6): strict route parsing, crew picker, refusal and
// not-found views, baseline sentences, trend tables with CSS bars, sharing
// labels. Presentation only; no js/db imports; text inserted via el().

import { icon } from "./icon.js";
import { el } from "../core/utils/dom.js";
import { formatDate, formatNumber } from "../core/utils/format.js";
import { badge, retryButton, section } from "./crew-view.js";

const UTC = Object.freeze({ timeZone: "UTC" });

/**
 * Strict route parsing for "#/physical" and "#/wellbeing".
 * "#/<base>" (or "#/<base>?…") → { view: "base" };
 * "#/<base>/AH-01" → { view: "detail", crewId: "AH-01" };
 * anything else under the base → { view: "invalid" }.
 */
export function parseHealthRoute(hash, base) {
  const text = String(hash || "");
  const match = /^#\/(physical|wellbeing)\/(AH-\d{2})$/.exec(text);
  if (match && match[1] === base) return { view: "detail", crewId: match[2] };
  if (text === `#/${base}` || text.startsWith(`#/${base}?`)) return { view: "base" };
  return { view: "invalid" };
}

/** Medical Officer crew picker: names and public crew IDs only. */
export function crewPicker(crew, base, { title, intro }) {
  return section("health-picker-title", title, [
    el("p", { class: "health__note" }, intro),
    crew.length
      ? el("ul", { class: "health-picker", role: "list" },
          crew.map((c) => el("li", {}, el("a", { class: "btn btn--secondary health-picker__link", href: `#/${base}/${c.crewId}` }, [icon("user"), `${c.name} · ${c.crewId}`]))))
      : el("p", { class: "health__empty" }, "No crew profiles are stored on this device."),
  ]);
}

const REFUSALS = {
  database_error: ["database", "Data unavailable", "Data couldn't be read from this device's storage, so nothing is shown rather than guessing.", true],
  unexpected_error: ["database", "Data unavailable", "Something went wrong while loading. Nothing is shown rather than guessing.", true],
  profile_missing: ["user", "Astronaut profile not found", "No astronaut profile was found on this device for your account. Clearing the site data and signing in again recreates the demo data.", true],
  account_mismatch: ["lock", "Please sign in again", "Your session doesn't match a stored account on this device. Log out (top right) and sign in again.", false],
  invalid_session: ["lock", "Please sign in again", "Your session is incomplete. Log out (top right) and sign in again.", false],
  no_session: ["lock", "Please sign in again", "You're not signed in. Log out (top right) and sign in again.", false],
  not_astronaut: ["lock", "Astronaut accounts only", "This view is only for astronaut accounts.", false],
  not_medical_officer: ["lock", "Medical Officer only", "This view is only for Medical Officer accounts.", false],
  invalid_crew_id: ["users", "Crew member not found", "That address doesn't name a crew member. Crew IDs look like AH-01.", false],
  unknown_crew_id: ["users", "Crew member not found", "No crew member with that ID exists on this device.", false],
};

/** Whole-view refusal / not-found. No personal data. */
export function refusalView(result, onRetry, base) {
  const [iconName, title, text, retry] = REFUSALS[result && result.reason] || REFUSALS.unexpected_error;
  const notFound = result && result.status === "not_found";
  return el("section", { class: "card", role: "alert", "aria-labelledby": "health-refusal-title" }, [
    el("div", { class: "state" }, [
      el("span", { class: "state__icon" }, icon(iconName)),
      el("h2", { class: "state__title", id: "health-refusal-title", tabindex: "-1" }, title),
      el("p", { class: "state__text" }, text),
      retry && onRetry ? retryButton(onRetry) : null,
      notFound && base ? el("a", { class: "btn btn--secondary btn--sm", href: `#/${base}` }, [icon("arrow-right"), "Back"]) : null,
    ]),
  ]);
}

/** Astronauts using a nested crew URL: a safe not-found, no service call. */
export function astronautNestedNotFound(base) {
  return refusalView({ status: "not_found", reason: "invalid_crew_id" }, null, base);
}

const UNIT_WORDS = { bpm: "bpm", "%": "percentage points", mmHg: "mmHg", h: "h" };
const fmt = (v, decimals) => formatNumber(Math.abs(v), decimals);

/** "4 bpm above the stored personal baseline of 72 bpm." — descriptive only. */
export function baselineSentence(diff, baseline, unit, decimals = 0) {
  if (diff === null || diff === undefined || baseline === null || baseline === undefined) return "No stored personal baseline to compare with.";
  const word = unit === "%" && Math.abs(diff) === 1 ? "percentage point" : UNIT_WORDS[unit] || unit;
  const base = `${formatNumber(baseline, decimals)} ${unit}`;
  if (diff === 0) return `The same as the stored personal baseline of ${base}.`;
  return `${fmt(diff, decimals)} ${word} ${diff > 0 ? "above" : "below"} the stored personal baseline of ${base}.`;
}

/** Sharing label for a check-in: icon + text. */
export function sharingBadge(shared) {
  return shared ? badge("badge--info", "eye", "Shared with the Medical Officer") : badge("badge--neutral", "eye-off", "Private");
}

/** "8 Nov" for a UTC date key. */
export function shortDate(dateKey) {
  const d = new Date(`${dateKey}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? dateKey : d.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
}

export function longDate(dateKey) {
  return formatDate(Date.parse(`${dateKey}T00:00:00.000Z`), UTC);
}

/**
 * One metric's trend for the chosen window: text summary, a table (cards on
 * narrow screens via CSS) and decorative CSS bars (aria-hidden).
 */
export function trendBlock(metric, windowDays) {
  const decimals = metric.key === "sleepDuration" ? 1 : 0;
  const id = `health-trend-${metric.key}`;
  if (metric.status !== "ok") {
    return el("article", { class: "health-trend", "aria-labelledby": id }, [
      el("h3", { class: "health-trend__title", id }, metric.label),
      el("p", { class: "health__empty" }, "Couldn't load this trend."),
    ]);
  }
  const w = metric.windows[windowDays];
  const days = metric.days.slice(-windowDays);
  const present = days.filter((d) => !d.missing);
  const lo = present.length ? Math.min(...present.map((d) => d.min)) : 0;
  const hi = present.length ? Math.max(...present.map((d) => d.max)) : 1;
  const pct = (v) => (hi === lo ? 60 : 15 + ((v - lo) / (hi - lo)) * 85).toFixed(1);
  const summary =
    w.daysWithData === 0
      ? `No data in the last ${windowDays} days.`
      : `${windowDays}-day average ${formatNumber(w.average, decimals + 1)} ${metric.unit} (${w.daysWithData} of ${windowDays} days with data). ` +
        baselineSentence(w.differenceFromBaseline, metric.baseline, metric.unit, decimals + 1);

  return el("article", { class: "health-trend", "aria-labelledby": id }, [
    el("h3", { class: "health-trend__title", id }, metric.label),
    el("p", { class: "health__text" }, summary),
    present.length
      ? el("div", { class: "health-bars", "aria-hidden": "true" },
          days.map((d) => el("span", { class: ["health-bars__bar", d.missing ? "is-missing" : ""], style: d.missing ? {} : { "--h": `${pct(d.avg)}%` } })))
      : null,
    el("table", { class: "table health-table" }, [
      el("caption", { class: "sr-only" }, `${metric.label}, daily values for the last ${windowDays} UTC days, in ${metric.unit}`),
      el("thead", {}, el("tr", {}, ["Date (UTC)", "Average", "Min", "Max", "Readings"].map((h) => el("th", { scope: "col" }, h)))),
      el("tbody", {},
        [...days].reverse().map((d) =>
          d.missing
            ? el("tr", { class: "is-missing" }, [el("th", { scope: "row" }, shortDate(d.date)), el("td", { colspan: "4" }, "No data")])
            : el("tr", {}, [
                el("th", { scope: "row" }, shortDate(d.date)),
                el("td", { "data-label": "Average" }, formatNumber(d.avg, decimals + 1)),
                el("td", { "data-label": "Min" }, formatNumber(d.min, decimals)),
                el("td", { "data-label": "Max" }, formatNumber(d.max, decimals)),
                el("td", { "data-label": "Readings" }, String(d.count)),
              ]))),
    ]),
  ]);
}
