// js/pages/history.js — #/history (Sprint 9), both roles.
//
//   Astronaut        #/history          own history
//                    #/history/<any>    safe "not found" (no service call)
//   Medical Officer  #/history          crew picker (names + crew IDs only)
//                    #/history/AH-03    that crew member's history
//
// Presentation only: every visible line comes from history-service.js (an
// allow-list; stored event text is never shown). The service returns one
// sanitized snapshot; this page reveals PAGE_SIZE entries at a time from it
// ("Show older") and filters categories locally. No js/db imports; text via
// el(); late results are dropped.
//
// Test seam: createHistoryRenderer({ service }).

import { getOwnHistory, getCrewMemberHistory, listCrewForHistorySelection } from "../services/history-service.js";
import { icon } from "../components/icon.js";
import { el } from "../core/utils/dom.js";
import { formatDate } from "../core/utils/format.js";
import { badge, loadingView, section, srOnly, syntheticNotice, utcTime } from "../components/crew-view.js";
import { refusalView } from "../components/health-view.js";

const BASE = "history";
const CATEGORY_VIEW = {
  readings: { icon: "activity", label: "Reading" },
  wellbeing: { icon: "brain", label: "Wellbeing activity" },
  alerts: { icon: "bell", label: "Alert" },
  messages: { icon: "message-circle", label: "Message" },
  simulation: { icon: "flask-conical", label: "Simulation" },
};

/** "#/history" → base; "#/history/AH-03" → detail; anything else → invalid. */
export function parseHistoryRoute(hash) {
  const text = String(hash || "");
  const m = /^#\/history\/(AH-\d{2})$/.exec(text);
  if (m) return { view: "detail", crewId: m[1] };
  if (text === "#/history" || text.startsWith("#/history?")) return { view: "base" };
  return { view: "invalid" };
}

/** Provenance label — exactly the four approved texts (or none). */
export function provenanceLabel(p) {
  if (p === "simulation") return el("span", { class: "sim-tag" }, [icon("flask-conical", { size: 12 }), "Simulated · Simulation Center"]);
  if (p === "seed") return el("span", { class: "sim-tag" }, "Synthetic seed data");
  if (p === "manual") return badge("badge--neutral", "user", "Manual entry");
  if (p === "not_recorded") return badge("badge--neutral", "info", "Source not recorded");
  return null;
}

const dayTitle = (key) => `${formatDate(Date.parse(`${key}T00:00:00Z`), { timeZone: "UTC" })} (UTC)`;

/** TEST SEAM. Production uses renderHistory. */
export function createHistoryRenderer({ service }) {
  return function render(container, session, { signal, hash = "#/history", focus = false } = {}) {
    const route = parseHistoryRoute(hash);
    const live = el("p", { class: "sr-only", role: "status", "aria-live": "polite" });
    const content = el("div", { class: "history__content" });
    const root = el("div", { class: "history", "aria-busy": "false" }, [live, content]);
    container.replaceChildren(root);
    const officer = Boolean(session && session.role === "medical_officer");

    if (!officer && route.view !== "base") {
      content.replaceChildren(refusalView({ status: "not_found", reason: "invalid_crew_id" }, null, BASE)); // no service call
      return Promise.resolve();
    }
    if (route.view === "invalid") {
      content.replaceChildren(refusalView({ status: "not_found", reason: "invalid_crew_id" }, null, BASE));
      return Promise.resolve();
    }

    const st = { generation: 0, data: null, days: 7, visible: 0, hidden: new Set(), focusHeading: focus };
    const aborted = () => Boolean(signal && signal.aborted);

    async function load() {
      const token = ++st.generation;
      root.setAttribute("aria-busy", "true");
      content.replaceChildren(...loadingView("Loading history…"));
      let res;
      try {
        if (officer && route.view === "base") res = await service.listCrewForHistorySelection(session);
        else if (officer) res = await service.getCrewMemberHistory(session, route.crewId, { days: st.days });
        else res = await service.getOwnHistory(session, { days: st.days });
      } catch {
        res = { status: "unavailable", reason: "unexpected_error" };
      }
      if (token !== st.generation || aborted()) return;
      root.setAttribute("aria-busy", "false");
      if (res && res.status === "ready" && officer && route.view === "base") {
        content.replaceChildren(picker(res.crew));
      } else if (res && res.status === "ready") {
        st.data = res;
        st.visible = res.pageSize;
        draw();
        live.textContent = `History loaded: ${res.returnedCount} activit${res.returnedCount === 1 ? "y" : "ies"} in the last ${res.range.days} days.`;
      } else {
        st.data = null;
        content.replaceChildren(refusalView(res, () => load(), BASE));
      }
      if (st.focusHeading) {
        st.focusHeading = false;
        for (const n of content.querySelectorAll("[data-heading]")) n.focus();
      }
    }

    function picker(crew) {
      return section("history-picker-title", "Health history · choose a crew member", [
        el("p", { class: "history__note" }, "Shows recorded activity for one crew member: readings, shared check-in activity, alerts, messages and simulations. Private journal entries and private check-ins are never shown."),
        crew.length
          ? el("ul", { class: "history-picker", role: "list" }, crew.map((c) => el("li", {}, el("a", { class: "btn btn--secondary", href: `#/history/${c.crewId}` }, [icon("history"), `${c.name} · ${c.crewId}`]))))
          : el("p", { class: "history__empty" }, "No crew profiles are stored on this device."),
      ]);
    }

    function draw() {
      const d = st.data;
      const filtered = d.entries.filter((e) => !st.hidden.has(e.category));
      const shown = filtered.slice(0, st.visible);
      const days = [];
      for (const e of shown) {
        const last = days[days.length - 1];
        if (last && last.day === e.day) last.items.push(e);
        else days.push({ day: e.day, items: [e] });
      }
      const header = el("section", { class: "history__header", "aria-labelledby": "history-title" }, [
        el("h2", { class: "history__title", id: "history-title", tabindex: "-1", "data-heading": "" }, d.viewer === "officer" ? `Health history · ${d.profile.name} · ${d.profile.crewId}` : "Your health history"),
        el("p", { class: "history__subtitle" }, `${d.profile.missionRole} · ${d.range.from} to ${d.range.to} (UTC, inclusive) · newest first`),
        d.viewer === "officer" ? el("p", { class: "history__links" }, [el("a", { class: "btn btn--secondary btn--sm", href: "#/history" }, [icon("arrow-right"), "Choose another crew member"]), el("a", { class: "btn btn--secondary btn--sm", href: `#/crew/${d.profile.crewId}` }, [icon("users"), "Crew member detail"])]) : null,
        syntheticNotice(),
      ]);
      const rangeGroup = el("div", { class: "segmented", role: "group", "aria-label": "Date range" },
        d.ranges.map((n) => el("button", { class: "segmented__option", type: "button", id: `history-range-${n}`, "aria-pressed": String(n === d.range.days), onClick: () => { if (n !== st.days) { st.days = n; load(); } } }, `${n} days`)));
      const filters = el("fieldset", { class: "history-filters" }, [
        el("legend", { class: "history-filters__legend" }, "Show"),
        ...d.categories.map((c) => el("label", { class: "history-filter", for: `history-cat-${c.id}` }, [
          el("input", { type: "checkbox", id: `history-cat-${c.id}`, checked: !st.hidden.has(c.id), onChange: (e) => { if (e.target.checked) st.hidden.delete(c.id); else st.hidden.add(c.id); st.visible = d.pageSize; draw(); } }),
          el("span", {}, c.label),
        ])),
      ]);
      const notes = [
        d.truncated ? el("p", { class: "history__notice", role: "note" }, [icon("info"), " Showing the latest 500 activities for this range."]) : null,
        d.partial.alerts ? el("p", { class: "history__notice", role: "note" }, [icon("circle-alert"), " Alert details couldn't be loaded, so alert entries say “an alert” without a link."]) : null,
        d.partial.simulation ? el("p", { class: "history__notice", role: "note" }, [icon("circle-alert"), " Simulation details couldn't be loaded, so some simulation entries are less specific."]) : null,
      ];
      const list = shown.length
        ? days.map((g) => el("section", { class: "history-day", "aria-labelledby": `history-day-${g.day}` }, [
            el("h3", { class: "history-day__title", id: `history-day-${g.day}` }, dayTitle(g.day)),
            el("ol", { class: "history-list", role: "list" }, g.items.map((e) => entry(e))),
          ]))
        : [el("p", { class: "history__empty" }, d.entries.length ? "No activity in the selected categories." : "No activity in this range.")];
      const more = filtered.length > shown.length
        ? el("button", { class: "btn btn--secondary btn--sm", type: "button", id: "history-more", onClick: () => { st.visible += d.pageSize; draw(); live.textContent = `Showing ${Math.min(st.visible, filtered.length)} of ${filtered.length} activities.`; } }, [icon("chevron-down"), `Show older (${filtered.length - shown.length} more)`])
        : null;
      content.replaceChildren(
        header,
        section("history-list-title", "Activity", [
          el("div", { class: "history-controls" }, [rangeGroup, filters]),
          ...notes.filter(Boolean),
          el("p", { class: "history__note", id: "history-count" }, `Showing ${shown.length} of ${filtered.length} activit${filtered.length === 1 ? "y" : "ies"}. Times are UTC.`),
          ...list,
          more,
          el("p", { class: "history__note" }, "Every line is written by the app from a fixed list of safe activity types. Wellbeing scores, message text and notes are never shown here. Readings without a timeline entry appear in Physical Health."),
        ].filter(Boolean)),
      );
    }

    function entry(e) {
      const v = CATEGORY_VIEW[e.category];
      return el("li", { class: "history-entry" }, [
        el("span", { class: "history-entry__time" }, utcTime(e.timestamp)),
        el("span", { class: "history-entry__body" }, [
          badge("badge--neutral", v.icon, v.label),
          " ",
          e.alertNumber ? el("a", { href: `#/alerts/${e.alertNumber}` }, e.text) : el("span", {}, e.text),
          srOnly("."),
        ]),
        provenanceLabel(e.provenance),
      ]);
    }

    return load();
  };
}

export const renderHistory = createHistoryRenderer({
  service: Object.freeze({
    getOwnHistory: (s, f) => getOwnHistory(s, f),
    getCrewMemberHistory: (s, c, f) => getCrewMemberHistory(s, c, f),
    listCrewForHistorySelection: (s) => listCrewForHistorySelection(s),
  }),
});
