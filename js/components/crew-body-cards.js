// js/components/crew-body-cards.js — SHARED. "Choose a crew member" as one card
// per crew member: their body scan with open-alert pins, status badge, latest
// heart rate / SpO₂ / sleep, and a button to open that member on this page.
//
//   crewBodyCards(snapshot.crew, "history", { id, title, intro, action: "Open health history" })
//
// `crew` is getCrewSnapshot().crew (js/services/crew-monitor-service.js) —
// public crew IDs, names, open-alert rules and latest readings only. Open alerts
// only are pinned (resolved alerts are never on a body). Presentation only.

import { el } from "../core/utils/dom.js";
import { icon } from "./icon.js";
import { formatNumber } from "../core/utils/format.js";
import { section, stateBadge } from "./crew-view.js";
import { createBodyScan } from "./body-scan.js";
import { zoneForRule, ZONE_LABELS } from "./alert-zones.js";

const SEVERITY_WORD = { critical: "critical", warning: "warning", info: "info" };

/** Open rules for this page. No category means the combined/history view. */
export function cardRules(member, category = "") {
  const rules = member && member.alerts && member.alerts.status === "ok" && Array.isArray(member.alerts.rules) ? member.alerts.rules : [];
  return category ? rules.filter((r) => r.category === category) : rules;
}

/** Pins for a member's open alerts (from snapshot alerts.rules). */
export function cardPins(member, category = "") {
  return cardRules(member, category).map((r, i) => {
    const zone = zoneForRule(r.ruleId);
    const severity = SEVERITY_WORD[r.severity] ? r.severity : "info";
    return { number: i + 1, zone, severity, label: `${member.name}: open ${severity} alert ${i + 1}, ${ZONE_LABELS[zone] || "body"}. Opens this crew member.` };
  });
}

function categoryState(member, rules, category) {
  if (!category) return member.state;
  if (!member.alerts || member.alerts.status !== "ok") return { tone: "neutral", icon: "eye-off", label: "Status unavailable" };
  if (!rules.length) return { tone: "ok", icon: "circle-check", label: "No open alerts" };
  const severity = rules.some((r) => r.severity === "critical") ? "critical" : rules.some((r) => r.severity === "warning") ? "warning" : "info";
  return severity === "critical"
    ? { tone: "critical", icon: "circle-alert", label: "Critical alert" }
    : severity === "warning"
      ? { tone: "warning", icon: "triangle-alert", label: "Watch" }
      : { tone: "info", icon: "info", label: "Info" };
}

function vitalText(v) {
  if (!v || v.state !== "ok" || typeof v.value !== "number") return "—";
  return `${formatNumber(v.value, v.key === "sleepDuration" ? 1 : 0)} ${v.unit || ""}`.trim();
}

/**
 * @param {Array} crew       getCrewSnapshot().crew
 * @param {string} base      route base, e.g. "history" → "#/history/AH-04"
 * @param {{ id: string, title: string, intro: string, action: string, alertCategory?: "physical"|"wellbeing" }} text
 * @param {{ navigate?: (hash: string) => void }} [options]
 */
export function crewBodyCards(crew, base, { id, title, intro, action, alertCategory = "" }, { navigate = (hash) => { globalThis.location.hash = hash; } } = {}) {
  const list = Array.isArray(crew) ? crew : [];
  return section(id, title, [
    el("p", { class: "health__note" }, intro),
    list.length
      ? el("ul", { class: "body-cards", role: "list" }, list.map((m) => {
          const href = `#/${base}/${m.crewId}`;
          const rules = cardRules(m, alertCategory);
          const pins = cardPins(m, alertCategory);
          const state = categoryState(m, rules, alertCategory);
          const vitals = m.vitals && Array.isArray(m.vitals.items) ? m.vitals.items : [];
          return el("li", { class: "body-card", "data-crew-card": m.crewId }, [
            el("div", { class: "body-card__head" }, [
              el("span", { class: "body-card__avatar", "aria-hidden": "true" }, m.initials || m.crewId.slice(-2)),
              el("div", { class: "body-card__who" }, [
                el("h3", { class: "body-card__name" }, `${m.name} · ${m.crewId}`),
                el("p", { class: "body-card__role" }, m.missionRole || "Crew member"),
              ]),
            ]),
            el("p", { class: "body-card__state" }, [stateBadge(state), el("span", { class: "body-card__count" }, m.alerts && m.alerts.status === "ok" ? `${rules.length} open alert${rules.length === 1 ? "" : "s"}` : "Alerts unavailable")]),
            el("div", { class: "body-card__scan" }, createBodyScan({ pins, hotspots: pins, onPinClick: () => navigate(href) })),
            el("dl", { class: "body-card__vitals" }, vitals.flatMap((v) => [el("dt", {}, v.label), el("dd", {}, vitalText(v))])),
            el("a", { class: "btn btn--primary btn--sm body-card__open", href }, [icon("arrow-right"), `${action}`, el("span", { class: "sr-only" }, ` for ${m.name}`)]),
          ]);
        }))
      : el("p", { class: "health__empty" }, "No crew profiles are stored on this device."),
    el("p", { class: "health__note" }, "Bodies are stylised illustrations: pins mark open alerts only (resolved alerts are never shown). Synthetic demonstration data — not a health assessment."),
  ]);
}

/**
 * Show the plain picker first, then swap in the body cards once the crew
 * snapshot is ready. Late or failed loads leave the plain picker in place.
 * @param {{ host: Element, loadCards: Function|null, session: object, isCurrent: () => boolean,
 *           base: string, text: object, navigate?: Function }} options
 */
export async function upgradeToCards({ host, loadCards, session, isCurrent, base, text, navigate }) {
  if (typeof loadCards !== "function") return false;
  let snap;
  try {
    snap = await loadCards(session);
  } catch {
    return false;
  }
  if (!isCurrent() || !snap || snap.status !== "ready" || !Array.isArray(snap.crew)) return false;
  host.replaceChildren(crewBodyCards(snap.crew, base, text, navigate ? { navigate } : undefined));
  return true;
}
