// js/pages/physical-health.js — #/physical (Sprint 6)
//
//   Astronaut        #/physical          own Physical Health
//                    #/physical/<any>    safe "not found" (no officer service call)
//   Medical Officer  #/physical          crew picker (names + crew IDs only)
//                    #/physical/AH-04    that astronaut, read-only
//                    other #/physical/…  safe "not found"
//
// Presentation only (rules live in js/services/physical-health-service.js).
// No js/db imports; text inserted via el(); late results are dropped.

import { getOwnPhysicalHealth, getCrewMemberPhysicalHealth, listCrewForPhysicalSelection, BASELINE_NOTE } from "../services/physical-health-service.js";
import { icon } from "../components/icon.js";
import { el } from "../core/utils/dom.js";
import { onHealthChanged, keepFocus } from "../core/live-updates.js";
import { alertItem, dataBadges, loadingView, provenanceTag, section, sectionError, stamp, syntheticNotice, vitalValueText } from "../components/crew-view.js";
import { astronautNestedNotFound, baselineSentence, crewPicker, parseHealthRoute, refusalView, trendBlock } from "../components/health-view.js";
import { createContextBodyScan } from "../components/context-body-scan.js";

const BASE = "physical";

function header(data) {
  const p = data.profile;
  const officer = data.viewer === "officer";
  return el("section", { class: "health__header", "aria-labelledby": "physical-title" }, [
    el("h2", { class: "health__welcome", id: "physical-title", tabindex: "-1" }, officer ? `${p.name} · ${p.crewId}` : "Your physical health"),
    el("p", { class: "health__subtitle" }, officer ? `${p.missionRole} · read-only view` : `${p.name} · ${p.crewId} · ${p.missionRole}`),
    officer
      ? el("p", { class: "health__links" }, [
          el("a", { class: "btn btn--secondary btn--sm", href: `#/crew/${p.crewId}` }, [icon("users"), "Crew member detail"]),
          el("a", { class: "btn btn--secondary btn--sm", href: `#/wellbeing/${p.crewId}` }, [icon("brain"), "Shared wellbeing"]),
          el("a", { class: "btn btn--secondary btn--sm", href: "#/physical" }, [icon("arrow-right"), "Choose another crew member"]),
        ])
      : null,
    syntheticNotice(),
  ]);
}

function readingSentence(item) {
  if (item.state !== "ok") return null;
  if (item.key === "bloodPressure") {
    const d = item.differenceFromBaseline || {};
    if (!item.baseline) return "No stored personal baseline to compare with.";
    return `Systolic: ${baselineSentence(d.systolic, item.baseline.systolic, item.unit)} Diastolic: ${baselineSentence(d.diastolic, item.baseline.diastolic, item.unit)}`;
  }
  return baselineSentence(item.differenceFromBaseline, item.baseline, item.unit, item.key === "sleepDuration" ? 1 : 0);
}

function latestSection(data, onRetry) {
  return section("physical-latest-title", "Latest readings", [
    el("p", { class: "health__note" }, `The most recent usable reading of each measure. Invalid readings are left out. Times are UTC. ${BASELINE_NOTE}`),
    el("div", { class: "health-grid" },
      data.latest.items.map((item) => {
        const id = `physical-card-${item.key}`;
        return el("article", { class: "card metric health-card", id: `physical-${item.key}`, tabindex: "-1", "data-scan-target": item.key, "aria-labelledby": id }, [
          el("div", { class: "metric__top" }, [el("h3", { class: "metric__label", id }, item.label), item.state === "ok" ? provenanceTag(item) : null]),
          el("p", { class: "health-card__value" }, vitalValueText(item)),
          item.state === "ok" ? el("p", { class: "health__meta" }, stamp(item.timestamp, data.generatedAt)) : null,
          item.state === "error" ? sectionError(onRetry, "this reading") : el("p", { class: "health__tags" }, dataBadges(item)),
          item.state === "ok" ? el("p", { class: "health__text" }, readingSentence(item)) : null,
        ]);
      })),
  ]);
}

const PHYSICAL_ZONES = Object.freeze({ heartRate: "heart", spo2: "lungs", bloodPressure: "arm", sleepDuration: "head" });
function physicalScan(data) {
  const pins = data.latest.items.map((item, index) => ({
    number: index + 1,
    zone: PHYSICAL_ZONES[item.key] || "chest",
    severity: "info",
    tag: `${item.label} · ${vitalValueText(item)}`,
    label: `Go to ${item.label}: ${vitalValueText(item)}`,
    targetId: item.key,
  }));
  return createContextBodyScan({
    id: "physical-body-map-title",
    title: "Physical health body map",
    description: "One shared body view connects each stored physical reading to the area it describes. The map is navigation, not a diagnosis.",
    pins,
  });
}

function trendsSection(data, windowDays, onWindow) {
  const toggle = el("div", { class: "segmented health-toggle", role: "group", "aria-label": "Trend period" },
    data.trends.windows.map((n) =>
      el("button", { class: "segmented__option", type: "button", "aria-pressed": String(n === windowDays), onClick: () => onWindow(n) }, `${n} days`)));
  return section("physical-trends-title", "Trends", [
    toggle,
    el("p", { class: "health__note" }, data.trends.note),
    ...data.trends.metrics.map((m) => trendBlock(m, windowDays)),
  ]);
}

const QUALITY_TEXT = { ok: "Latest reading available", empty: "No recent reading", incomplete: "No complete reading", error: "Couldn't load" };

function qualitySection(data) {
  return section("physical-quality-title", "Data quality and freshness", [
    el("ul", { class: "health__list", role: "list" },
      data.quality.items.map((q) =>
        el("li", {}, [
          el("strong", {}, `${q.label}: `),
          QUALITY_TEXT[q.state] || "No recent reading",
          q.suspect ? " · latest reading marked suspect" : "",
          q.stale ? " · no newer reading (stale)" : "",
          q.missingDays30 === null ? "" : ` · ${q.missingDays30} of 30 days without data`,
        ]))),
    el("p", { class: "health__note" }, "Data quality labels describe the readings, not the astronaut's health."),
  ]);
}

function alertsSection(data, onRetry) {
  const a = data.alerts;
  return section("physical-alerts-title", "Open physical alerts", [
    a.status === "error"
      ? sectionError(onRetry, "physical alerts")
      : a.items.length
        ? el("ul", { class: "health__alerts", role: "list" }, a.items.map((x) => alertItem(x)))
        : el("p", { class: "health__empty" }, "No open physical alerts."),
    el("p", { class: "health__note" }, "Stored open alerts only. This is not a health assessment."),
    el("p", {}, el("a", { class: "btn btn--secondary btn--sm", href: "#/alerts" }, [icon("bell"), "View all alerts"])),
  ]);
}

/** TEST SEAM: tests pass fake loaders. Production uses renderPhysicalHealth. */
export function createPhysicalHealthRenderer({ loadOwn, loadCrewMember, listCrew, subscribe = onHealthChanged }) {
  return function render(container, session, { signal, hash = `#/${BASE}`, focus = false } = {}) {
    const route = parseHealthRoute(hash, BASE);
    const root = el("div", { class: "health", "aria-busy": "false" });
    container.replaceChildren(root);
    const officer = session && session.role === "medical_officer";

    if (!officer && route.view !== "base") {
      root.append(astronautNestedNotFound(BASE)); // never another astronaut's data
      return Promise.resolve();
    }
    if (officer && route.view === "invalid") {
      root.append(refusalView({ status: "not_found", reason: "invalid_crew_id" }, null, BASE));
      return Promise.resolve();
    }

    let generation = 0;
    let windowDays = 7;
    let data = null;

    const draw = () => {
      const retry = () => load();
      root.replaceChildren(header(data), physicalScan(data), latestSection(data, retry), trendsSection(data, windowDays, (n) => { windowDays = n; draw(); }), qualitySection(data), alertsSection(data, retry));
    };

    // Live updates for the crew member shown (own data for an astronaut): reload quietly.
    subscribe({
      signal,
      crewId: () => (officer ? (route.view === "base" ? "" : route.crewId) : data && data.profile && typeof data.profile.crewId === "string" ? data.profile.crewId : null),
      reload: () => keepFocus(root, () => load({ quiet: true })),
    });

    async function load({ quiet = false } = {}) {
      const token = ++generation;
      if (!quiet) {
        root.setAttribute("aria-busy", "true");
        for (const b of root.querySelectorAll("[data-retry]")) b.disabled = true;
      }
      if (!root.childNodes.length) root.replaceChildren(...loadingView("Loading physical health…"));
      let result;
      try {
        if (officer && route.view === "base") result = await listCrew(session);
        else if (officer) result = await loadCrewMember(session, route.crewId);
        else result = await loadOwn(session);
      } catch {
        result = { status: "unavailable", reason: "unexpected_error" };
      }
      if (token !== generation || (signal && signal.aborted)) return;
      if (quiet && !(result && result.status === "ready")) return; // keep what is shown
      const retry = () => load();
      if (result && result.status === "ready" && officer && route.view === "base") {
        root.replaceChildren(crewPicker(result.crew, BASE, { title: "Choose a crew member", intro: "Select a crew member to review their physical readings (read-only)." }));
      } else if (result && result.status === "ready") {
        data = result;
        draw();
        if (focus && officer && !quiet) root.querySelectorAll("[tabindex]")[0]?.focus();
      } else {
        root.replaceChildren(refusalView(result, retry, BASE));
      }
      root.setAttribute("aria-busy", "false");
    }
    return load();
  };
}

export const renderPhysicalHealth = createPhysicalHealthRenderer({
  loadOwn: (session) => getOwnPhysicalHealth(session),
  loadCrewMember: (session, crewId) => getCrewMemberPhysicalHealth(session, crewId),
  listCrew: (session) => listCrewForPhysicalSelection(session),
});
