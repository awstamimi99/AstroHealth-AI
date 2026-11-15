// js/pages/environment.js — #/environment, the Cabin Environment (both roles).
//
// Crew-wide cabin CO₂, pressure and humidity from the crew's personal
// monitors, the demonstration limits, the crew-wide AIR CHECK and open
// environment alerts. Medical Officer: also each crew member's monitor.
// Presentation only (js/services/environment-service.js); el() only.
//
// Test seam: createEnvironmentRenderer({ load, subscribe }).

import { getCabinEnvironment } from "../services/environment-service.js";
import { icon } from "../components/icon.js";
import { el } from "../core/utils/dom.js";
import { formatDateTime, formatNumber } from "../core/utils/format.js";
import { badge, loadingView, section } from "../components/crew-view.js";
import { refusalView } from "../components/health-view.js";
import { onHealthChanged, keepFocus } from "../core/live-updates.js";

const BASE = "environment";
const LEVEL = Object.freeze({
  ok: ["badge--ok", "circle-check", "Within limit"],
  warning: ["badge--warning", "triangle-alert", "Warning"],
  critical: ["badge--critical", "circle-alert", "Critical"],
  unknown: ["badge--neutral", "clock", "No recent reading"],
});
const CHECK = Object.freeze({
  crew_pattern: ["badge--critical", "circle-alert", "Crew-wide pattern"],
  crew_spo2: ["badge--warning", "triangle-alert", "Several crew members"],
  individual: ["badge--info", "info", "One crew member"],
  clear: ["badge--ok", "circle-check", "No crew-wide pattern"],
  unknown: ["badge--neutral", "clock", "Not enough data"],
});
const SEV = Object.freeze({ critical: ["badge--critical", "circle-alert", "Critical"], warning: ["badge--warning", "triangle-alert", "Warning"], info: ["badge--info", "info", "Info"] });
const b = (x) => badge(x[0], x[1], x[2]);
const num = (v, unit, d = 1) => (v === null || v === undefined ? "—" : `${formatNumber(v, d)} ${unit}`);

function limitsText(m) {
  if (!m.limits) return "No stored limit.";
  const sym = m.direction === "high" ? (m.key === "cabinHumidity" ? ">" : "≥") : "<";
  return `${m.rule}: warning ${sym} ${m.limits.warning} ${m.unit}, critical ${sym} ${m.limits.critical} ${m.unit} · 2 readings in a row`;
}

export function createEnvironmentRenderer({ load: loadData, subscribe = onHealthChanged }) {
  return function render(container, session, { signal, focus = false } = {}) {
    const content = el("div", { class: "health__content" });
    const root = el("div", { class: "health env", "aria-busy": "false" }, [content]);
    container.replaceChildren(root);
    const officer = Boolean(session && session.role === "medical_officer");
    let generation = 0;
    subscribe({ signal, crewId: () => "", reload: () => keepFocus(root, () => load({ quiet: true })) });

    async function load({ quiet = false } = {}) {
      const token = ++generation;
      if (!quiet) { root.setAttribute("aria-busy", "true"); content.replaceChildren(...loadingView("Loading the cabin environment…")); }
      let d;
      try {
        d = await loadData(session);
      } catch {
        d = { status: "unavailable", reason: "unexpected_error" };
      }
      if (token !== generation || (signal && signal.aborted)) return;
      root.setAttribute("aria-busy", "false");
      if (!d || d.status !== "ready") {
        if (!quiet) content.replaceChildren(refusalView(d, () => load(), BASE));
        return;
      }
      content.replaceChildren(...[
        el("section", { class: "health__header", "aria-labelledby": "env-title" }, [
          el("h2", { class: "health__title", id: "env-title", tabindex: "-1" }, "Cabin Environment"),
          el("p", { class: "health__note" }, `Closed-environment hazard: the air the crew breathes. ${d.note}`),
        ]),
        el("section", { class: "card env-check", "aria-labelledby": "env-check-title", "data-air-check": d.airCheck.status }, [
          el("h3", { class: "ex-notice__title", id: "env-check-title" }, "Air check (SpO₂ across the crew)"),
          el("p", { class: "health__text" }, [b(CHECK[d.airCheck.status] || CHECK.unknown), " ", d.airCheck.text]),
          el("p", { class: "health__note" }, "If SpO₂ drops for one person it is reviewed as their health reading; if it drops for several crew members at once, the cabin air is checked first. Deterministic demonstration rule — not a diagnosis."),
        ]),
        el("div", { class: "env-grid" }, d.crewWide.map((m) => el("article", { class: ["card", "env-card", `env-card--${m.level}`], "aria-labelledby": `env-${m.key}`, "data-env-metric": m.key }, [
          el("h3", { class: "ex-notice__title", id: `env-${m.key}` }, m.label),
          el("p", { class: "env-card__value" }, num(m.latestAverage, m.unit, m.key === "cabinHumidity" ? 0 : 1)),
          el("p", { class: "health__note" }, `Crew average of the latest readings (${m.monitors} monitor${m.monitors === 1 ? "" : "s"}) · ${m.direction === "high" ? "highest" : "lowest"} ${num(m.worstLatest, m.unit, m.key === "cabinHumidity" ? 0 : 1)}`),
          b(LEVEL[m.level] || LEVEL.unknown),
          el("p", { class: "health__note" }, `Last 24 h: average ${num(m.average24h, m.unit, m.key === "cabinHumidity" ? 0 : 1)} · range ${num(m.min24h, m.unit, m.key === "cabinHumidity" ? 0 : 1)} – ${num(m.max24h, m.unit, m.key === "cabinHumidity" ? 0 : 1)}`),
          el("p", { class: "health__note" }, limitsText(m)),
        ]))),
        officer && d.members.length
          ? section("env-members-title", "Each crew member's monitor", [
              el("div", { class: "table-wrap" }, el("table", { class: "table" }, [
                el("thead", {}, el("tr", {}, ["Crew member", "CO₂", "Pressure", "Humidity", "Latest reading"].map((h) => el("th", { scope: "col" }, h)))),
                el("tbody", {}, d.members.map((p) => el("tr", {}, [
                  el("td", { "data-label": "Crew member" }, `${p.name} · ${p.crewId}`),
                  ...["cabinCo2", "cabinPressure", "cabinHumidity"].map((k) => {
                    const v = p.metrics[k];
                    if (!v || v.status !== "ok") return el("td", {}, "Couldn't be loaded");
                    return el("td", { "data-label": k }, [`${num(v.latest, { cabinCo2: "mmHg", cabinPressure: "kPa", cabinHumidity: "%RH" }[k], k === "cabinHumidity" ? 0 : 1)} `, b(LEVEL[v.level] || LEVEL.unknown)]);
                  }),
                  el("td", { "data-label": "Latest reading" }, p.metrics.cabinCo2?.at ? `${formatDateTime(p.metrics.cabinCo2.at, { timeZone: "UTC" })} UTC` : "—"),
                ]))),
              ])),
            ])
          : null,
        section("env-alerts-title", officer ? "Open cabin alerts" : "My open cabin alerts", [
          d.alerts.status !== "ok" ? el("p", { class: "health__empty" }, "Cabin alerts couldn't be loaded.")
            : d.alerts.items.length
              ? el("ul", { class: "ex-sessions", role: "list" }, d.alerts.items.map((a) => el("li", { class: "ex-sessions__item" }, [
                  b(SEV[a.severity] || SEV.info), " ", el("a", { href: `#/alerts/${a.number}` }, `${a.number} ${a.title}`), a.name ? ` · ${a.name} (${a.crewId})` : "", ` · ${a.ruleId}`,
                ])))
              : el("p", { class: "health__empty" }, "No open cabin alerts."),
          el("p", { class: "health__note" }, [icon("info"), " Cabin readings can be changed for the demo in Simulation Center → Live control."]),
        ]),
      ].filter(Boolean));
      if (focus && !quiet) root.querySelectorAll("[tabindex]")[0]?.focus?.();
    }
    return load();
  };
}

export const renderEnvironment = createEnvironmentRenderer({ load: (s) => getCabinEnvironment(s) });
