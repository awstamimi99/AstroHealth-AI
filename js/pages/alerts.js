// js/pages/alerts.js — #/alerts (Sprint 8), both roles.
//
//   #/alerts            list (astronaut: own open + resolved in 30 days;
//                       Medical Officer: crew-wide, filters, "Evaluate crew now")
//   #/alerts/ALT-0191   detail by PUBLIC alert number (evidence, rule,
//                       limitation, audit trail; Medical Officer actions)
//   anything else       safe "not found"
//
// Presentation only: scoping, rules and every write live in
// js/services/alerts-service.js and js/services/risk-service.js. No js/db
// imports; text inserted via el(); late results are dropped; no evaluation on
// page load. Astronauts never get acknowledge / resolve / evaluate controls.
//
// Test seam: createAlertsRenderer({ service, channel }).

import { listAlerts, getAlertDetail, acknowledgeAlert, resolveAlert, NOTE_MAX, DEMO_THRESHOLD_LABEL } from "../services/alerts-service.js";
import { evaluateCrew } from "../services/risk-service.js";
import { bus } from "../core/event-bus.js";
import { icon } from "../components/icon.js";
import { el } from "../core/utils/dom.js";
import { formatNumber } from "../core/utils/format.js";
import { SEVERITY_VIEW, badge, loadingView, retryButton, section, sectionError, srOnly, syntheticNotice, utcTime } from "../components/crew-view.js";

const STATUS_VIEW = {
  new: { icon: "bell", label: "New", badge: "badge--neutral" },
  acknowledged: { icon: "eye", label: "Acknowledged", badge: "badge--neutral" },
  resolved: { icon: "circle-check", label: "Resolved", badge: "badge--ok" },
};
const STATUS_OPTIONS = [["open", "Open (new + acknowledged)"], ["new", "New"], ["acknowledged", "Acknowledged"], ["resolved", "Resolved"], ["all", "All"]];
const SEVERITY_OPTIONS = [["all", "All severities"], ["critical", "Critical"], ["warning", "Warning"], ["info", "Info"]];
const QUALITY_LABEL = { ok: "OK", suspect: "Suspect", invalid: "Invalid", unknown: "Unknown", not_recorded: "Not recorded" };
const CHANGE_TEXT = { opened: "opened", escalated: "escalated", updated: "updated with new evidence", condition_cleared: "condition cleared" };

const REFUSALS = {
  unknown_alert: ["bell", "Alert not found", "No alert with that number is available to you. Alert numbers look like ALT-0191.", false, true],
  invalid_crew_id: ["users", "Crew member not found", "Choose a crew member from the list.", false, true],
  unknown_crew_id: ["users", "Crew member not found", "No crew member with that ID exists on this device.", false, true],
  invalid_filter: ["filter", "Filter not available", "That filter isn't available.", false, true],
  database_error: ["database", "Alerts unavailable", "Alerts couldn't be read from this device's storage, so nothing is shown rather than guessing.", true, false],
  unexpected_error: ["database", "Alerts unavailable", "Something went wrong while loading alerts. Nothing is shown rather than guessing.", true, false],
  profile_missing: ["user", "Astronaut profile not found", "No astronaut profile was found on this device for your account.", true, false],
  account_mismatch: ["lock", "Please sign in again", "Your session doesn't match a stored account on this device. Log out (top right) and sign in again.", false, false],
  invalid_session: ["lock", "Please sign in again", "Your session is incomplete. Log out (top right) and sign in again.", false, false],
  no_session: ["lock", "Please sign in again", "You're not signed in. Log out (top right) and sign in again.", false, false],
  not_medical_officer: ["lock", "Please sign in again", "This view needs a verified account. Log out (top right) and sign in again.", false, false],
};
const ACTION_MESSAGES = {
  acknowledged: "Alert acknowledged.",
  resolved: "Alert resolved.",
  unchanged: "Nothing changed — the alert was already in that state. The latest state is shown.",
  invalid_transition: "That action isn't possible for the alert's current status. The latest state is shown.",
  not_acknowledged: "Acknowledge the alert before resolving it.",
  condition_present: "The condition has not cleared. Confirm that you want to resolve it anyway.",
  note_required: "Write a resolution note before resolving.",
  note_too_long: `The note can be at most ${NOTE_MAX} characters.`,
  operation_in_progress: "Another action on this alert is still in progress. Try again in a moment.",
  unknown_alert: "The alert was not found.",
  database_error: "The database couldn't be updated. Nothing was saved.",
  unexpected_error: "Something went wrong. Nothing was saved.",
};

/** "#/alerts" → list; "#/alerts/ALT-0191" → detail; anything else → invalid. */
export function parseAlertsRoute(hash) {
  const text = String(hash || "");
  const m = /^#\/alerts\/(ALT-\d{4,6})$/.exec(text);
  if (m) return { view: "detail", number: m[1] };
  if (text === "#/alerts" || text.startsWith("#/alerts?")) return { view: "list" };
  return { view: "invalid" };
}

const severityBadge = (sev) => {
  const v = SEVERITY_VIEW[sev] || SEVERITY_VIEW.info;
  return badge(v.badge, v.icon, v.label);
};
const statusBadge = (status) => {
  const v = STATUS_VIEW[status] || STATUS_VIEW.new;
  return badge(v.badge, v.icon, v.label);
};
const clearedBadge = (cleared, status) =>
  status === "resolved" ? null : cleared ? badge("badge--neutral", "circle-check", "Condition cleared") : badge("badge--neutral", "clock", "Condition still present");
const demoLabel = (text) => el("p", { class: "alerts__demo" }, [icon("info"), el("span", {}, text)]);

function refusal(res, onRetry) {
  const [iconName, title, text, retry, back] = REFUSALS[res && res.reason] || REFUSALS.unexpected_error;
  return el("section", { class: "card", role: "alert", "aria-labelledby": "alerts-refusal-title" }, [
    el("div", { class: "state" }, [
      el("span", { class: "state__icon" }, icon(iconName)),
      el("h2", { class: "state__title", id: "alerts-refusal-title", tabindex: "-1" }, title),
      el("p", { class: "state__text" }, text),
      retry && onRetry ? retryButton(onRetry) : null,
      back ? el("a", { class: "btn btn--secondary btn--sm", href: "#/alerts" }, [icon("arrow-right"), "Back to alerts"]) : null,
    ]),
  ]);
}

const defaultChannel = Object.freeze({
  subscribe: (fn) => bus.on("alert:changed", (_d, meta) => { if (meta && meta.remote) fn(); }),
  notify: () => bus.emit("alert:changed", {}),
});

/** TEST SEAM. Production uses renderAlerts. */
export function createAlertsRenderer({ service, channel = defaultChannel }) {
  return function render(container, session, { signal, hash = "#/alerts", focus = false } = {}) {
    const route = parseAlertsRoute(hash);
    const live = el("p", { class: "sr-only", role: "status", "aria-live": "polite" });
    const content = el("div", { class: "alerts__content" });
    const root = el("div", { class: "alerts", "aria-busy": "false" }, [live, content]);
    container.replaceChildren(root);
    const officer = Boolean(session && session.role === "medical_officer");
    const st = { generation: 0, busy: false, data: null, filters: { status: "open", severity: "all", crewId: "" }, message: null, evaluation: null, note: "", confirm: false, focusHeading: focus };
    const aborted = () => Boolean(signal && signal.aborted);
    const announce = (text) => { live.textContent = text; };
    const unsubscribe = channel.subscribe(() => { if (!aborted() && !st.busy) load(); });
    if (signal) signal.addEventListener("abort", () => { if (typeof unsubscribe === "function") unsubscribe(); }, { once: true });

    if (route.view === "invalid") {
      content.replaceChildren(refusal({ status: "not_found", reason: "unknown_alert" }, null));
      return Promise.resolve();
    }

    async function act(call) {
      st.busy = true;
      for (const b of content.querySelectorAll("[data-action]")) b.disabled = true;
      root.setAttribute("aria-busy", "true");
      let res;
      try {
        res = await call();
      } catch {
        res = { status: "unavailable", reason: "unexpected_error" };
      }
      st.busy = false;
      root.setAttribute("aria-busy", "false");
      return aborted() ? null : res;
    }

    async function load() {
      const token = ++st.generation;
      root.setAttribute("aria-busy", "true");
      if (!st.data) content.replaceChildren(...loadingView("Loading alerts…"));
      let res;
      try {
        res = route.view === "detail" ? await service.getAlertDetail(session, route.number) : await service.listAlerts(session, officer ? { ...st.filters } : {});
      } catch {
        res = { status: "unavailable", reason: "unexpected_error" };
      }
      if (token !== st.generation || aborted()) return;
      root.setAttribute("aria-busy", "false");
      if (!res || res.status !== "ready") {
        st.data = null;
        content.replaceChildren(refusal(res, () => load()));
        return;
      }
      st.data = res;
      draw();
      if (st.focusHeading) {
        st.focusHeading = false;
        for (const n of content.querySelectorAll("[data-heading]")) n.focus();
      }
    }

    function draw() {
      const activeId = globalThis.document && document.activeElement && typeof document.activeElement.getAttribute === "function" ? document.activeElement.getAttribute("id") : null;
      content.replaceChildren(...(route.view === "detail" ? detailView(st.data) : listView(st.data)));
      if (activeId) for (const n of content.querySelectorAll("[id]")) if (n.getAttribute("id") === activeId && typeof n.focus === "function") n.focus();
    }

    function messageBox() {
      if (!st.message) return null;
      const error = st.message.tone === "error";
      return el("div", { class: ["banner", "alerts__message", error ? "banner--critical" : ""] }, [icon(error ? "circle-alert" : "info"), el("p", { class: "banner__text" }, st.message.text)]);
    }

    // ---- list ----------------------------------------------------------------------------

    function header(d) {
      return el("section", { class: "alerts__header", "aria-labelledby": "alerts-title" }, [
        el("h2", { class: "alerts__title", id: "alerts-title", tabindex: "-1", "data-heading": "" }, "Alerts"),
        el("p", { class: "alerts__subtitle" }, d.viewer === "officer" ? "Crew-wide alerts from the demonstration risk rules and the stored history." : "Your open alerts and alerts resolved in the last 30 days. Read-only."),
        syntheticNotice(),
        demoLabel(`${d.thresholdLabel} Alerts describe synthetic readings against stored demonstration rules. They are not a diagnosis.`),
      ]);
    }

    function select(id, label, options, value, onChange) {
      return el("div", { class: "field" }, [
        el("label", { class: "field__label", for: id }, label),
        el("div", { class: "field__control" }, el("select", { id, onChange: (e) => onChange(e.target.value) }, options.map(([v, t]) => el("option", { value: v, selected: v === value }, t)))),
      ]);
    }

    function toolbar(d) {
      const setFilter = (key, value) => {
        st.filters = { ...st.filters, [key]: value };
        st.message = null;
        load();
      };
      return section("alerts-tools-title", "Filters and evaluation", [
        el("div", { class: "alerts-filters" }, [
          select("alerts-status", "Status", STATUS_OPTIONS, st.filters.status, (v) => setFilter("status", v)),
          select("alerts-severity", "Severity", SEVERITY_OPTIONS, st.filters.severity, (v) => setFilter("severity", v)),
          select("alerts-crew", "Crew member", [["", "All crew members"], ...d.crew.map((c) => [c.crewId, `${c.name} · ${c.crewId}`])], st.filters.crewId, (v) => setFilter("crewId", v)),
        ]),
        el("div", { class: "alerts-actions" }, [
          el("button", { class: "btn btn--primary btn--sm", type: "button", id: "alerts-evaluate", "data-action": "evaluate", "aria-describedby": "alerts-evaluate-help", onClick: () => evaluate() }, [icon("rotate-ccw"), "Evaluate crew now"]),
          el("p", { class: "alerts__note", id: "alerts-evaluate-help" }, "Runs the demonstration rules once for every crew member on the stored readings. Nothing runs in the background."),
        ]),
        st.evaluation ? evaluationSummary(st.evaluation) : null,
      ]);
    }

    function evaluationSummary(res) {
      if (res.status !== "evaluated" && res.status !== "partial") {
        return el("p", { class: "alerts__note", role: "status" }, [icon("circle-alert"), " Risk evaluation unavailable. Nothing was changed."]);
      }
      const lines = [];
      for (const m of res.members) {
        if (m.status !== "evaluated") lines.push(`${m.name} · ${m.crewId}: risk evaluation unavailable`);
        else for (const r of m.rules) if (r.change !== "none") lines.push(`${m.crewId} · ${r.alertNumber} ${r.title} (${r.alertSeverity}) ${CHANGE_TEXT[r.change] || r.change}`);
      }
      return el("div", { class: "alerts-evaluation" }, [
        el("p", { class: "alerts__text" }, lines.length ? `Evaluated ${res.members.length} crew members. Changes:` : `Evaluated ${res.members.length} crew members. No alert changed.`),
        lines.length ? el("ul", { class: "alerts-evaluation__list", role: "list" }, lines.map((l) => el("li", {}, l))) : null,
        res.thresholdsAvailable ? null : el("p", { class: "alerts__note" }, "No stored demonstration thresholds were found, so no rule could be evaluated."),
      ]);
    }

    async function evaluate() {
      if (st.busy) return;
      const res = await act(() => service.evaluateCrew(session));
      if (!res) return;
      st.evaluation = res;
      const changed = res.members ? res.members.some((m) => m.rules && m.rules.some((r) => r.change !== "none")) : false;
      announce(res.status === "evaluated" || res.status === "partial" ? (changed ? "Evaluation finished. Some alerts changed." : "Evaluation finished. No alert changed.") : "Risk evaluation unavailable.");
      if (changed) channel.notify();
      await load();
    }

    function row(a, withCrew) {
      const view = SEVERITY_VIEW[a.severity] || SEVERITY_VIEW.info;
      return el("li", { class: ["alert-item", view.item, "alerts-row"] }, [
        el("span", { class: "alert-item__icon" }, icon(view.icon)),
        el("div", { class: "alert-item__body" }, [
          el("p", { class: "alert-item__title" }, el("a", { href: `#/alerts/${a.number}`, class: "alerts-row__link" }, `${a.number} · ${a.title}`)),
          withCrew && a.crewId ? el("p", { class: "alerts__meta" }, `${a.name} · ${a.crewId}`) : null,
          a.explanation ? el("p", { class: "alert-item__text" }, a.explanation) : null,
          el("p", { class: "alerts__tags" }, [severityBadge(a.severity), statusBadge(a.status), clearedBadge(a.conditionCleared, a.status), el("span", { class: "sim-tag" }, a.fromSimulation ? "Simulated" : "Synthetic")]),
          el("p", { class: "alerts__meta" }, ["Detected ", utcTime(a.detectedAt), a.ruleId ? ` · rule ${a.ruleId}` : ""]),
        ]),
      ]);
    }

    function listView(d) {
      const parts = [header(d), messageBox()];
      if (d.viewer === "officer") parts.push(toolbar(d));
      parts.push(section("alerts-list-title", d.viewer === "officer" ? "Crew alerts" : "Your alerts", [
        d.items.length
          ? el("ul", { class: "alerts-list", role: "list" }, d.items.map((a) => row(a, d.viewer === "officer")))
          : el("p", { class: "alerts__empty" }, d.viewer === "officer" ? "No alerts match these filters." : "You have no open alerts and none resolved in the last 30 days."),
        el("p", { class: "alerts__note" }, "Sorted by severity, then new before acknowledged, then newest first. Times are UTC."),
      ]));
      return parts.filter(Boolean);
    }

    // ---- detail --------------------------------------------------------------------------

    function detailView(d) {
      const a = d.alert;
      const facts = [
        a.crewId ? ["Crew member", `${a.name} · ${a.crewId}`] : null,
        ["Rule", `${a.rule.id}${a.rule.version ? ` · version ${a.rule.version}` : ""}`],
        ["Detected", utcTime(a.detectedAt)],
        ["Last triggered", a.lastTriggeredAt ? utcTime(a.lastTriggeredAt) : "—"],
        ["Occurrences", String(a.occurrenceCount)],
        a.acknowledgedAt ? ["Acknowledged", [utcTime(a.acknowledgedAt), ` · ${a.acknowledgedBy}`]] : null,
        a.resolvedAt ? ["Resolved", [utcTime(a.resolvedAt), ` · ${a.resolvedBy}`]] : null,
        a.resolutionNote ? ["Resolution note", a.resolutionNote] : null,
      ].filter(Boolean);
      const ev = a.evaluation;
      return [
        el("p", {}, el("a", { class: "btn btn--secondary btn--sm", href: "#/alerts" }, [icon("arrow-right"), "Back to alerts"])),
        el("section", { class: "alerts__header", "aria-labelledby": "alert-title" }, [
          el("h2", { class: "alerts__title", id: "alert-title", tabindex: "-1", "data-heading": "" }, `${a.number} · ${a.title}`),
          el("p", { class: "alerts__tags" }, [severityBadge(a.severity), statusBadge(a.status), clearedBadge(a.conditionCleared, a.status), el("span", { class: "sim-tag" }, a.fromSimulation ? "Simulated" : "Synthetic")]),
          syntheticNotice(),
        ]),
        messageBox(),
        section("alert-facts-title", "Summary", [el("dl", { class: "alerts-facts" }, facts.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]))]),
        section("alert-why-title", "Why this alert", [
          el("p", { class: "alerts__text" }, a.explanation || "No explanation stored."),
          a.rule.description ? el("p", { class: "alerts__text" }, ["Rule: ", a.rule.description, "."]) : null,
          a.rule.thresholdUsed ? el("p", { class: "alerts__text" }, ["Threshold used: ", a.rule.thresholdUsed]) : null,
          demoLabel(d.thresholdLabel),
          el("p", { class: "alerts__note" }, a.limitation),
          a.severity === "critical" || a.severity === "warning" ? el("p", { class: "alerts__note" }, `Severity “${a.severity}” comes from which demonstration threshold tier the readings met (see the explanation).`) : null,
        ]),
        evidenceSection(a),
        ev ? section("alert-eval-title", "Last evaluation", [
          el("p", { class: "alerts__text" }, ["Evaluated ", utcTime(ev.evaluatedAt), ev.considered !== null ? ` · ${ev.considered} recent reading${ev.considered === 1 ? "" : "s"} examined` : ""]),
          el("p", { class: "alerts__text" }, `Not used as evidence: ${ev.excluded.suspect} suspect, ${ev.excluded.invalid} invalid, ${ev.excluded.stale} stale.`),
        ]) : null,
        section("alert-suggested-title", "Suggested review", [el("p", { class: "alerts__text" }, a.suggestedAction || "Medical officer review recommended.")]),
        timelineSection(d.timeline),
        d.viewer === "officer" ? actionsSection(d) : el("p", { class: "alerts__note" }, "Alerts are reviewed by the Medical Officer. This view is read-only."),
      ].filter(Boolean);
    }

    function evidenceSection(a) {
      const rows = a.evidence;
      return section("alert-evidence-title", "Evidence", [
        rows.length
          ? el("div", { class: "table-wrap alerts-table-wrap", role: "region", tabindex: "0", "aria-labelledby": "alert-evidence-caption" }, [
              el("table", { class: "table alerts-table" }, [
                el("caption", { class: "sr-only", id: "alert-evidence-caption" }, "Readings that contributed to this alert, oldest first, times in UTC"),
                el("thead", {}, el("tr", {}, ["Reading", "Value", "Time (UTC)", "Source", "Quality"].map((h) => el("th", { scope: "col" }, h)))),
                el("tbody", {}, rows.map((e) => el("tr", {}, [
                  el("th", { scope: "row" }, e.label),
                  el("td", { "data-label": "Value" }, e.valueHidden ? "Not shown (wellbeing score)" : e.value === null ? "—" : `${formatNumber(e.value, Number.isInteger(e.value) ? 0 : 1)} ${e.unit}`),
                  el("td", { "data-label": "Time (UTC)" }, utcTime(e.timestamp)),
                  el("td", { "data-label": "Source" }, e.source === "simulation" ? el("span", { class: "sim-tag" }, ["Simulated", srOnly(" (Simulation Center)")]) : e.source === "seed" ? el("span", { class: "sim-tag" }, ["Simulated", srOnly(" (demo history)")]) : e.source === "manual" ? "Manual entry" : e.source === "not_recorded" ? "Not recorded (older alert)" : "Unknown"),
                  el("td", { "data-label": "Quality" }, QUALITY_LABEL[e.quality] || "Unknown"),
                ]))),
              ]),
            ])
          : el("p", { class: "alerts__empty" }, "No evidence stored for this alert."),
      ]);
    }

    function timelineSection(t) {
      if (t.status === "error") return section("alert-audit-title", "Audit trail", [sectionError(() => load(), "the audit trail")]);
      return section("alert-audit-title", "Audit trail", [
        t.items.length
          ? el("ol", { class: "alerts-audit", role: "list" }, t.items.map((x) => el("li", { class: "alerts-audit__item" }, [el("strong", {}, x.label), el("span", { class: "alerts__text" }, ` · ${x.by}`), x.note ? el("span", { class: "alerts__text" }, ` — ${x.note}`) : null, el("span", { class: "alerts__meta" }, [" · ", utcTime(x.timestamp)])])))
          : el("p", { class: "alerts__empty" }, "No audit records stored."),
        el("p", { class: "alerts__note" }, "Oldest first. Audit records are never edited or deleted."),
      ]);
    }

    function actionsSection(d) {
      const ac = d.actions;
      const a = d.alert;
      if (!ac.canAcknowledge && !ac.canResolve) {
        return section("alert-actions-title", "Actions", [el("p", { class: "alerts__note" }, a.status === "resolved" ? "This alert is resolved. Resolved alerts are kept as history and can't be reopened." : "No action is available.")]);
      }
      const children = [];
      if (ac.canAcknowledge) {
        children.push(el("p", { class: "alerts__text" }, "Acknowledge to show that the alert has been seen. Resolving is possible after acknowledgement."));
        children.push(el("button", { class: "btn btn--primary btn--sm", type: "button", id: "alert-ack", "data-action": "acknowledge", onClick: () => acknowledge() }, [icon("check"), "Acknowledge"]));
      }
      if (ac.canResolve) {
        const ready = st.note.trim().length > 0 && st.note.trim().length <= NOTE_MAX && (!ac.needsConfirmation || st.confirm);
        children.push(el("div", { class: "field" }, [
          el("label", { class: "field__label", for: "alert-note" }, `Resolution note (required, up to ${NOTE_MAX} characters)`),
          el("div", { class: "field__control" }, el("textarea", { id: "alert-note", maxlength: String(NOTE_MAX), rows: "3", "aria-describedby": "alert-resolve-help", onInput: (e) => { st.note = String(e.target.value || ""); syncResolve(); } }, st.note)),
        ]));
        if (ac.needsConfirmation) {
          children.push(el("label", { class: "alerts-check", for: "alert-confirm" }, [
            el("input", { type: "checkbox", id: "alert-confirm", checked: st.confirm, onChange: (e) => { st.confirm = e.target.checked === true; syncResolve(); } }),
            el("span", {}, "The condition has not cleared. I confirm I want to resolve this alert anyway."),
          ]));
        }
        children.push(el("button", { class: "btn btn--primary btn--sm", type: "button", id: "alert-resolve", "data-action": "resolve", disabled: !ready, "aria-describedby": "alert-resolve-help", onClick: () => resolve() }, [icon("circle-check"), "Resolve"]));
        children.push(el("p", { class: "alerts__note", id: "alert-resolve-help" }, ac.needsConfirmation ? "A note and the confirmation are required because the condition is still present." : "A note is required."));
      }
      return section("alert-actions-title", "Actions", children);
    }

    function syncResolve() {
      const ac = st.data && st.data.actions;
      for (const b of content.querySelectorAll("[data-action]")) {
        if (b.getAttribute("data-action") !== "resolve") continue;
        const ready = st.note.trim().length > 0 && st.note.trim().length <= NOTE_MAX && (!ac || !ac.needsConfirmation || st.confirm);
        b.disabled = !ready;
        if (ready) b.removeAttribute("disabled");
        else b.setAttribute("disabled", "");
      }
    }

    async function acknowledge() {
      if (st.busy) return;
      const res = await act(() => service.acknowledgeAlert(session, route.number, {}));
      if (!res) return;
      finishAction(res);
      await load();
    }

    async function resolve() {
      if (st.busy) return;
      const ac = st.data.actions;
      const res = await act(() => service.resolveAlert(session, route.number, { note: st.note, confirmConditionPresent: ac.needsConfirmation ? st.confirm === true : false }));
      if (!res) return;
      if (res.status === "resolved") { st.note = ""; st.confirm = false; }
      finishAction(res);
      await load();
    }

    function finishAction(res) {
      const ok = res.status === "acknowledged" || res.status === "resolved";
      const text = ACTION_MESSAGES[ok || res.status === "unchanged" ? res.status : res.reason] || ACTION_MESSAGES.unexpected_error;
      st.message = { tone: ok || res.status === "unchanged" ? "info" : "error", text };
      announce(text);
      if (ok) channel.notify();
    }

    return load();
  };
}

export const renderAlerts = createAlertsRenderer({
  service: Object.freeze({
    listAlerts: (session, filters) => listAlerts(session, filters),
    getAlertDetail: (session, number) => getAlertDetail(session, number),
    acknowledgeAlert: (session, number, input) => acknowledgeAlert(session, number, input),
    resolveAlert: (session, number, input) => resolveAlert(session, number, input),
    evaluateCrew: (session) => evaluateCrew(session),
  }),
});

export { DEMO_THRESHOLD_LABEL };
