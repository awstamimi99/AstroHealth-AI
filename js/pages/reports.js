// js/pages/reports.js — #/reports (Sprint 9), both roles. Dynamic, print-friendly.
//
//   Astronaut        #/reports          own health summary (astronaut_health)
//                    #/reports/<any>    safe "not found" (no service call)
//   Medical Officer  #/reports          crew picker + crew summary (crew_summary)
//                    #/reports/AH-03    that crew member's health summary
//
// Nothing is stored. "Print report" calls window.print() only when pressed
// (css/print.css hides the app chrome and controls). Every value comes from
// reports-service.js; missing data shows "No data". No js/db imports.
//
// Test seam: createReportsRenderer({ service, print }).

import { getOwnHealthReport, getCrewMemberHealthReport, getCrewSummaryReport, listCrewForReportSelection, REPORT_RANGES } from "../services/reports-service.js";
import { icon } from "../components/icon.js";
import { el } from "../core/utils/dom.js";
import { formatNumber } from "../core/utils/format.js";
import { loadingView, utcTime } from "../components/crew-view.js";
import { refusalView } from "../components/health-view.js";

const BASE = "reports";
const NO_DATA = "No data";
const SEVERITY_LABEL = { critical: "Critical", warning: "Warning", info: "Info" };
const STATUS_LABEL = { new: "New", acknowledged: "Acknowledged", resolved: "Resolved", unknown: "Unknown" };

export function parseReportsRoute(hash) {
  const text = String(hash || "");
  const m = /^#\/reports\/(AH-\d{2})$/.exec(text);
  if (m) return { view: "detail", crewId: m[1] };
  if (text === "#/reports" || text.startsWith("#/reports?")) return { view: "base" };
  return { view: "invalid" };
}

const withUnit = (v, unit, d = 0) => (v === null || v === undefined ? NO_DATA : `${formatNumber(v, d)} ${unit}`);
function diffText(m) {
  if (m.differenceFromBaseline === null) return m.baseline === null ? "No stored baseline" : NO_DATA;
  const d = m.differenceFromBaseline;
  const dec = m.key === "sleepDuration" ? 2 : 1;
  return d === 0 ? `Same as baseline (${formatNumber(m.baseline, dec - 1)} ${m.unit})` : `${d > 0 ? "+" : "−"}${formatNumber(Math.abs(d), dec)} ${m.unit} vs baseline ${formatNumber(m.baseline, dec - 1)} ${m.unit}`;
}
function table(id, caption, headings, rows) {
  return el("div", { class: "table-wrap report-table-wrap" }, el("table", { class: "table report-table", id }, [
    el("caption", { class: "report-table__caption" }, caption),
    el("thead", {}, el("tr", {}, headings.map((h) => el("th", { scope: "col" }, h)))),
    el("tbody", {}, rows.map(([first, ...rest]) => el("tr", {}, [el("th", { scope: "row" }, first), ...rest.map((c, i) => el("td", { "data-label": headings[i + 1] }, c))]))),
  ]));
}

/** Report header + disclaimer + exclusions (shared). */
function frame(report, children) {
  return el("article", { class: "card report", "aria-labelledby": "report-title" }, [
    el("header", { class: "report__header" }, [
      el("h2", { class: "report__title", id: "report-title", tabindex: "-1", "data-heading": "" }, report.title),
      el("p", { class: "report__meta" }, [`Period ${report.period.from} to ${report.period.to} (UTC, ${report.period.days} days, inclusive) · generated `, utcTime(report.generatedAt)]),
      el("p", { class: "report__disclaimer" }, report.disclaimer),
    ]),
    ...children,
    el("section", { class: "report__section", "aria-labelledby": "report-excluded-title" }, [
      el("h3", { class: "report__h3", id: "report-excluded-title" }, "Not included in this report"),
      el("ul", { class: "report__list" }, report.excluded.map((x) => el("li", {}, x))),
    ]),
  ]);
}

function healthReport(r) {
  const s = r.subject;
  const metrics = r.metrics.map((m) => (m.status !== "ok"
    ? [m.label, "Couldn't load", "", "", "", "", ""]
    : [m.label, `${m.daysWithData} of ${r.period.days}`, String(m.missingDays), withUnit(m.average, m.unit, m.key === "sleepDuration" ? 2 : 1), withUnit(m.min, m.unit, m.key === "sleepDuration" ? 1 : 0), withUnit(m.max, m.unit, m.key === "sleepDuration" ? 1 : 0), diffText(m)]));
  const a = r.activity;
  const activity = [
    a.checkins.status !== "ok" ? ["Daily check-ins", "Couldn't load"] : r.viewer === "astronaut" ? ["Daily check-ins", `${a.checkins.total} (${a.checkins.shared} shared with the Medical Officer)`] : ["Shared daily check-ins", String(a.checkins.shared)],
    ["Simulation runs started", a.simulationRuns.status === "ok" ? String(a.simulationRuns.count) : "Couldn't load"],
    ["Messages from the Medical Officer", a.messages.status === "ok" ? String(a.messages.count) : "Couldn't load"],
  ];
  const p = r.provenance;
  return frame(r, [
    el("section", { class: "report__section", "aria-labelledby": "report-subject-title" }, [
      el("h3", { class: "report__h3", id: "report-subject-title" }, "Crew member"),
      el("p", {}, `${s.name} · ${s.crewId} · ${s.missionRole}`),
    ]),
    el("section", { class: "report__section", "aria-labelledby": "report-metrics-title" }, [
      el("h3", { class: "report__h3", id: "report-metrics-title" }, "Physical readings (daily summaries)"),
      table("report-metrics", "Daily-summary statistics per measure. Average is the average of daily averages. Missing days are not filled in.", ["Measure", "Days with data", "Missing days", "Average", "Minimum", "Maximum", "Difference from stored baseline"], metrics),
      el("p", { class: "report__note" }, "Numeric comparison with the stored personal baseline only — descriptive, not a clinical assessment."),
    ]),
    el("section", { class: "report__section", "aria-labelledby": "report-alerts-title" }, [
      el("h3", { class: "report__h3", id: "report-alerts-title" }, "Alerts detected in this period"),
      r.alerts.status !== "ok"
        ? el("p", {}, "Alerts couldn't be loaded, so none are listed rather than guessing.")
        : r.alerts.items.length
          ? table("report-alerts", "Alerts by detection time (UTC), status at generation time", ["Alert", "Severity", "Status", "Detected (UTC)", "Rule"], r.alerts.items.map((x) => [`${x.number} · ${x.title}`, SEVERITY_LABEL[x.severity] || x.severity, STATUS_LABEL[x.status] || x.status, utcTime(x.detectedAt), `${x.ruleId}${x.ruleVersion ? ` v${x.ruleVersion}` : ""}`]))
          : el("p", {}, "No alerts were detected in this period."),
      el("p", { class: "report__note" }, "Demonstration threshold — not clinically validated."),
    ]),
    el("section", { class: "report__section", "aria-labelledby": "report-activity-title" }, [
      el("h3", { class: "report__h3", id: "report-activity-title" }, "Activity (counts only)"),
      table("report-activity", "Counts in this period", ["Activity", "Count"], activity),
    ]),
    el("section", { class: "report__section", "aria-labelledby": "report-prov-title" }, [
      el("h3", { class: "report__h3", id: "report-prov-title" }, "Data provenance (raw readings)"),
      p.status !== "ok"
        ? el("p", {}, "Provenance couldn't be loaded.")
        : table("report-provenance", `Raw readings ${p.window.from} to ${p.window.to} (UTC), by recorded source`, ["Recorded source", "Readings"], [
            ["Simulated · Simulation Center", String(p.counts.simulation)],
            ["Synthetic seed data", String(p.counts.seed)],
            ["Manual entry", String(p.counts.manual)],
            ["Source not recorded", String(p.counts.notRecorded)],
            ["Marked suspect / invalid", `${p.suspect} / ${p.invalid}`],
          ]),
      p.olderUnavailable ? el("p", { class: "report__note" }, `${p.olderUnavailable.from} to ${p.olderUnavailable.to}: ${p.olderUnavailable.text}`) : null,
    ]),
  ]);
}

function crewReport(r) {
  return frame(r, [
    el("section", { class: "report__section", "aria-labelledby": "report-crew-title" }, [
      el("h3", { class: "report__h3", id: "report-crew-title" }, "Crew"),
      table("report-crew", "Per crew member: open alerts now, latest vital-sign reading, days with daily-summary data in the period, shared check-ins in the period", ["Crew member", "Open alerts (critical / warning / info)", "Latest vital-sign reading (UTC)", "Days with data", "Shared check-ins"],
        r.members.map((m) => [
          `${m.name} · ${m.crewId}`,
          `${m.openTotal} (${m.openAlerts.critical} / ${m.openAlerts.warning} / ${m.openAlerts.info})`,
          m.latestVitalAt.status !== "ok" ? "Couldn't load" : m.latestVitalAt.at ? utcTime(m.latestVitalAt.at) : NO_DATA,
          m.daysWithData.status !== "ok" ? "Couldn't load" : `${m.daysWithData.count} of ${m.daysWithData.of}`,
          String(m.sharedCheckins),
        ])),
      el("p", { class: "report__note" }, "Open alerts come from stored demonstration rules (Demonstration threshold — not clinically validated)."),
    ]),
  ]);
}

/** TEST SEAM. Production uses renderReports. */
export function createReportsRenderer({ service, print = () => globalThis.print() }) {
  return function render(container, session, { signal, hash = "#/reports", focus = false } = {}) {
    const route = parseReportsRoute(hash);
    const live = el("p", { class: "sr-only", role: "status", "aria-live": "polite" });
    const content = el("div", { class: "reports__content" });
    const root = el("div", { class: "reports", "aria-busy": "false" }, [live, content]);
    container.replaceChildren(root);
    const officer = Boolean(session && session.role === "medical_officer");
    if ((!officer && route.view !== "base") || route.view === "invalid") {
      content.replaceChildren(refusalView({ status: "not_found", reason: "invalid_crew_id" }, null, BASE));
      return Promise.resolve();
    }
    const st = { generation: 0, days: 7, crew: null, report: null, kind: officer && route.view === "base" ? "crew" : "health", focusHeading: focus };
    const aborted = () => Boolean(signal && signal.aborted);

    function controls() {
      return el("div", { class: "reports-controls no-print" }, [
        el("div", { class: "segmented", role: "group", "aria-label": "Report period" },
          REPORT_RANGES.map((n) => el("button", { class: "segmented__option", type: "button", id: `report-range-${n}`, "aria-pressed": String(n === st.days), onClick: () => { st.days = n; generate(); } }, `${n} days`))),
        el("button", { class: "btn btn--secondary btn--sm", type: "button", id: "report-generate", onClick: () => generate() }, [icon("rotate-ccw"), "Regenerate"]),
        st.report ? el("button", { class: "btn btn--primary btn--sm", type: "button", id: "report-print", onClick: () => print() }, [icon("printer"), "Print report"]) : null,
      ]);
    }

    function draw(body) {
      const parts = [
        el("section", { class: "reports__header no-print", "aria-labelledby": "reports-page-title" }, [
          el("h2", { class: "reports__title", id: "reports-page-title" }, officer ? "Reports" : "Your health summary report"),
          el("p", { class: "reports__note" }, "Reports are generated on this device from the stored synthetic data each time you open or regenerate them. Nothing is saved. Use “Print report” to print or save it with your browser."),
          officer ? crewLinks() : null,
        ]),
        controls(),
        body,
      ];
      content.replaceChildren(...parts.filter(Boolean));
    }

    function crewLinks() {
      if (!st.crew) return null;
      return el("nav", { class: "reports-crew", "aria-label": "Crew member reports" }, [
        el("a", { class: ["btn", "btn--sm", st.kind === "crew" ? "btn--primary" : "btn--secondary"], href: "#/reports", "aria-current": st.kind === "crew" ? "page" : null }, [icon("users"), "Crew summary"]),
        ...st.crew.map((c) => el("a", { class: ["btn", "btn--sm", route.crewId === c.crewId ? "btn--primary" : "btn--secondary"], href: `#/reports/${c.crewId}`, "aria-current": route.crewId === c.crewId ? "page" : null }, [icon("file-text"), `${c.name} · ${c.crewId}`])),
      ]);
    }

    async function generate() {
      const token = ++st.generation;
      root.setAttribute("aria-busy", "true");
      draw(el("div", {}, loadingView("Generating report…")));
      let res;
      try {
        if (officer && !st.crew) {
          const list = await service.listCrewForReportSelection(session);
          if (token !== st.generation || aborted()) return;
          if (list && list.status === "ready") st.crew = list.crew;
          else res = list;
        }
        if (!res) {
          if (st.kind === "crew") res = await service.getCrewSummaryReport(session, { days: st.days });
          else if (officer) res = await service.getCrewMemberHealthReport(session, route.crewId, { days: st.days });
          else res = await service.getOwnHealthReport(session, { days: st.days });
        }
      } catch {
        res = { status: "unavailable", reason: "unexpected_error" };
      }
      if (token !== st.generation || aborted()) return;
      root.setAttribute("aria-busy", "false");
      if (res && res.status === "ready") {
        st.report = res.report;
        draw(res.report.type === "crew_summary" ? crewReport(res.report) : healthReport(res.report));
        live.textContent = `Report generated for ${res.report.period.days} days.`;
      } else {
        st.report = null;
        draw(refusalView(res, () => generate(), BASE));
      }
      if (st.focusHeading) {
        st.focusHeading = false;
        for (const n of content.querySelectorAll("[data-heading]")) n.focus();
      }
    }

    return generate();
  };
}

export const renderReports = createReportsRenderer({
  service: Object.freeze({
    getOwnHealthReport: (s, i) => getOwnHealthReport(s, i),
    getCrewMemberHealthReport: (s, c, i) => getCrewMemberHealthReport(s, c, i),
    getCrewSummaryReport: (s, i) => getCrewSummaryReport(s, i),
    listCrewForReportSelection: (s) => listCrewForReportSelection(s),
  }),
});
