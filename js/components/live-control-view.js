// js/components/live-control-view.js — the "Live control" tab of #/simulation.
//
// The Medical Officer picks ONE crew member, sets synthetic values on charts
// (drag, keyboard or number field) and commits them. Presentation only:
//   • reads come from js/services/live-control-service.js (getLiveControl);
//   • every write is done by js/services/simulation-service.js
//     (recordManualReading, startCustomCurve, pause / resume / stop) — this
//     module sends only the public crew ID, the metric name and numbers;
//   • rule limits shown on the charts are the ones the service read from the
//     risk engine and the stored settings — none are defined here;
//   • a custom curve is advanced by the Simulation Center's existing step
//     timer (js/pages/simulation-center.js), so there is one code path for
//     timing, pause, stop and "another tab advanced it".
//
// Nothing is editable until a crew member is chosen (no default selection).
// Dragged values are kept in memory only; choosing another crew member
// discards them with a notice — they are never carried over.
// No js/db imports; all text is inserted with el().
//
// It lives in components/ because it imports no service: the Simulation
// Center page passes the service functions in.
//
// Test seam: createLiveControl({ session, service, live, reset, host, … }).

import { icon } from "./icon.js";
import { el } from "../core/utils/dom.js";
import { formatNumber, formatRelative } from "../core/utils/format.js";
import { badge, sectionError, utcTime } from "./crew-view.js";
import { createBodyScan } from "./body-scan.js";
import { alertPins } from "./vitals-stage.js";
import { createLiveChart, snapValue } from "./live-chart.js";

export const RESET_PHRASE = "RESET DEMO";
const SEVERITY_BADGE = Object.freeze({
  critical: ["badge--critical", "circle-alert", "Critical alert"],
  warning: ["badge--warning", "triangle-alert", "Watch"],
  info: ["badge--info", "info", "Info"],
});
const CHANGE_WORD = { opened: "opened", escalated: "escalated", updated: "updated", condition_cleared: "condition cleared" };
const OUTCOME_VIEW = Object.freeze({
  triggered: ["badge--warning", "triangle-alert", "Rule met"],
  clear: ["badge--ok", "circle-check", "In the clear range"],
  insufficient: ["badge--neutral", "clock", "No change"],
});
const MESSAGES = Object.freeze({
  invalid_metric: "That measure can't be set here.",
  invalid_value: "Enter a number inside the allowed input range.",
  pair_required: "Blood pressure needs both a systolic and a diastolic value.",
  invalid_pair: "The diastolic value must be lower than the systolic value.",
  invalid_curve: "A curve needs 6 to 12 points inside the allowed input range.",
  invalid_speed: "Choose a speed from the list.",
  confirmation_required: "Please confirm before continuing.",
  clock_not_monotonic: "This device's clock is not later than this crew member's latest reading, so nothing was written. Wait a moment and apply again.",
  run_active_for_member: "A simulation run is active for this crew member. Stop it before applying single values.",
  below_todays_total: "Activity is a running total for the UTC day, so it can't be lower than today's latest value.",
  another_run_active: "Another run is already active. Only one run can be active at a time.",
  unknown_crew_id: "That crew member was not found on this device.",
  invalid_crew_id: "Choose a crew member from the list.",
  astronaut_missing: "That crew member is no longer stored on this device. Nothing was written.",
  operation_in_progress: "Another action is still in progress. Try again in a moment.",
  database_error: "The database couldn't be updated. Nothing was saved.",
  unexpected_error: "Something went wrong. Nothing was saved.",
});
const messageFor = (res) => MESSAGES[res && res.reason] || MESSAGES.unexpected_error;

/** Chart groups: blood pressure is ONE chart with two handles (stored as a pair). */
const GROUPS = Object.freeze([
  { id: "heartRate", title: "Heart rate", keys: ["heartRate"] },
  { id: "spo2", title: "SpO₂", keys: ["spo2"] },
  { id: "bloodPressure", title: "Blood pressure", keys: ["bpSystolic", "bpDiastolic"] },
  { id: "sleepDuration", title: "Sleep duration", keys: ["sleepDuration"] },
  { id: "activity", title: "Activity", keys: ["activity"] },
  { id: "fatigue", title: "Fatigue", keys: ["fatigue"] },
  { id: "bodyTemperature", title: "Body temperature", keys: ["bodyTemperature"] },
  { id: "cabinCo2", title: "Cabin CO₂ (ppCO₂)", keys: ["cabinCo2"] },
  { id: "cabinPressure", title: "Cabin pressure", keys: ["cabinPressure"] },
  { id: "cabinHumidity", title: "Cabin humidity", keys: ["cabinHumidity"] },
]);
const GROUP_NOTES = Object.freeze({
  sleepDuration: "One value per UTC night: a value applied now counts as tonight's reading. The sleep rule needs 3 consecutive UTC nights, and readings are never backdated.",
  activity: "Running total of steps for the current UTC day. It can only stay the same or go up during the day.",
  bodyTemperature: "Two rules read this measure: PHY-06 (high) and PHY-07 (low). Right after exercise a higher value can be from overheating.",
  cabinCo2: "Reading from this crew member's personal cabin-environment monitor (ENV-01). Raise it for several crew members together to see the crew-wide air check on Cabin Environment.",
  cabinPressure: "Reading from this crew member's personal cabin-environment monitor (ENV-02).",
  cabinHumidity: "Reading from this crew member's personal cabin-environment monitor (ENV-03).",
});

const initialsOf = (name) => String(name || "").split(/\s+/).filter(Boolean).map((w) => w[0]).filter((c) => /[A-Za-z]/.test(c)).slice(-2).join("").toUpperCase() || "?";
const num = (v, unit) => `${formatNumber(v, Number.isInteger(v) ? 0 : 1)} ${unit}`;

function alertBadge(alerts) {
  if (!alerts || alerts.status !== "ok") return badge("badge--neutral", "eye-off", "Alerts unavailable");
  if (!alerts.openCount) return badge("badge--ok", "circle-check", "No open alerts");
  const [cls, ic, word] = SEVERITY_BADGE[alerts.topSeverity] || SEVERITY_BADGE.info;
  return badge(cls, ic, `${word} · ${alerts.openCount} open`);
}

/**
 * @param {object} deps
 * @param {object} deps.session
 * @param {{ recordManualReading: Function, startCustomCurve: Function }} deps.service  simulation-service
 * @param {{ getLiveControl: Function }} deps.live      live-control-service
 * @param {{ resetDemoData: Function }} deps.reset      demo-reset-service
 * @param {Function} deps.notifyReset                   tells the app shell a reset succeeded
 * @param {object} deps.host                            Simulation Center glue: getRun(), isBusy(), control(kind), adoptRun(runRef), lastRisk(), announce(text)
 * @param {Function} [deps.navigate]
 * @param {AbortSignal} [deps.signal]
 */
export function createLiveControl({ session, service, live, reset, notifyReset, host, navigate = (hash) => { globalThis.location.hash = hash; }, signal = null, speeds = [1, 2, 4, 8], defaultSpeed = 1 }) {
  const node = el("div", { class: "live", "aria-busy": "false" });
  const st = {
    data: null,
    generation: 0,
    crewId: "", // "" = nobody selected (the default)
    draft: {}, // metric → value (memory only)
    dirty: new Set(),
    curve: null, // { group, metric, values[], speed, confirm }
    result: null, // last committed write: { group, crew, readings, risk }
    message: null, // { tone, text }
    notice: null, // e.g. discarded drafts
    busy: false,
    resetText: "",
    resetBusy: false,
    confirmStop: false,
    lastRunStep: null,
  };
  const charts = new Map(); // group id → chart
  const aborted = () => Boolean(signal && signal.aborted);
  const say = (text) => { if (host && typeof host.announce === "function") host.announce(text); };
  const selected = () => (st.data && st.data.selected && st.data.selected.crewId === st.crewId ? st.data.selected : null);
  const metricOf = (key) => { const s = selected(); return s ? s.metrics.find((m) => m.key === key) || null : null; };
  const startValue = (m) => snapValue(m.latest ? m.latest.value : m.baseline !== null ? m.baseline : m.min, m);

  // ---- data ---------------------------------------------------------------------------------

  async function load({ keepDrafts = true } = {}) {
    const token = ++st.generation;
    node.setAttribute("aria-busy", "true");
    let res;
    try {
      res = await live.getLiveControl(session, { crewId: st.crewId || undefined });
    } catch {
      res = { status: "unavailable", reason: "unexpected_error" };
    }
    if (token !== st.generation || aborted()) return;
    node.setAttribute("aria-busy", "false");
    st.data = res;
    if (res && res.status === "ready") {
      if (st.crewId && res.selection !== "ok") {
        st.message = { tone: "error", text: messageFor({ reason: res.selection }) };
        st.crewId = "";
      }
      const s = selected();
      if (s) {
        for (const m of s.metrics) if (!keepDrafts || !st.dirty.has(m.key) || st.draft[m.key] === undefined) st.draft[m.key] = startValue(m);
      }
    }
    draw();
  }

  function select(crewId) {
    if (st.busy || crewId === st.crewId) return;
    const before = selected();
    if (before && (st.dirty.size || st.curve)) {
      st.notice = `Unsaved values for ${before.name} (${before.crewId}) were discarded. Nothing was written for them.`;
      say(st.notice);
    } else st.notice = null;
    st.crewId = crewId || "";
    st.draft = {};
    st.dirty = new Set();
    st.curve = null;
    st.result = null;
    st.message = null;
    st.confirmStop = false;
    load({ keepDrafts: false });
  }

  // ---- actions --------------------------------------------------------------------------------

  async function act(call) {
    st.busy = true;
    for (const b of node.querySelectorAll("[data-live-action]")) b.disabled = true;
    node.setAttribute("aria-busy", "true");
    let res;
    try {
      res = await call();
    } catch {
      res = { status: "unavailable", reason: "unexpected_error" };
    }
    st.busy = false;
    node.setAttribute("aria-busy", "false");
    return aborted() ? null : res;
  }

  async function apply(group) {
    const s = selected();
    if (!s || st.busy) return;
    const pair = group.keys.length === 2;
    const input = pair
      ? { crewId: s.crewId, metric: "bpSystolic", value: st.draft.bpSystolic, diastolic: st.draft.bpDiastolic }
      : { crewId: s.crewId, metric: group.keys[0], value: st.draft[group.keys[0]] };
    const res = await act(() => service.recordManualReading(session, input));
    if (!res) return;
    if (res.status === "recorded") {
      for (const k of group.keys) st.dirty.delete(k);
      st.result = { group: group.id, crew: res.crew, readings: res.readings, risk: res.risk, at: res.generatedAt };
      st.message = null;
      const written = res.readings.map((r) => `${r.label} ${num(r.value, r.unit)}`).join(" and ");
      const changes = res.risk && res.risk.status === "evaluated" ? res.risk.changes : [];
      say(`Saved for ${res.crew.name} (${res.crew.crewId}): ${written}.` + (changes.length ? ` ${changes.map((c) => `${c.alertNumber} ${c.title} ${CHANGE_WORD[c.change] || c.change}${c.severity ? ` (${c.severity})` : ""}.`).join(" ")}` : ""));
    } else {
      st.message = { tone: "error", text: messageFor(res) };
      say(st.message.text);
    }
    await load();
  }

  async function playCurve() {
    const s = selected();
    const c = st.curve;
    if (!s || !c || st.busy || c.confirm !== true) return;
    const chart = charts.get(c.group);
    const values = chart && chart.getCurve() ? chart.getCurve() : c.values;
    const input = { crewId: s.crewId, metric: c.metric, values, speed: c.speed, confirm: true };
    if (c.metric === "bpSystolic") input.diastolic = st.draft.bpDiastolic;
    const res = await act(() => service.startCustomCurve(session, input));
    if (!res) return;
    if (res.status === "started") {
      st.curve = null;
      st.message = null;
      st.result = null;
      say(`Curve started for ${res.run.name} (${res.run.crewId}): ${res.run.totalSteps} steps at ${res.run.speed}×.`);
      await host.adoptRun(res.runRef); // the Simulation Center timer advances it
    } else if (res.status === "conflict" && res.activeRun) {
      const a = res.activeRun;
      st.message = { tone: "error", text: `${messageFor(res)} Active: ${a.name || "a crew member"}${a.crewId ? ` (${a.crewId})` : ""}, ${a.scenarioName}.` };
      say(st.message.text);
    } else {
      st.message = { tone: "error", text: messageFor(res) };
      say(st.message.text);
    }
    await load();
  }

  async function runControl(kind) {
    st.confirmStop = false;
    await host.control(kind);
    await load();
  }

  async function resetDemo() {
    if (st.resetBusy || st.resetText !== RESET_PHRASE) return;
    st.resetBusy = true;
    draw();
    let res;
    try {
      res = await reset.resetDemoData(session, { confirmation: st.resetText });
    } catch {
      res = { status: "unavailable", reason: "unexpected_error" };
    }
    if (aborted()) return;
    st.resetBusy = false;
    if (res && res.status === "reset") {
      say("Demo data was reset. Signing out.");
      notifyReset(); // the app shell signs out every tab and opens the login page
      return;
    }
    st.message = { tone: "error", text: res && res.reason === "confirmation_required" ? `Type ${RESET_PHRASE} exactly to confirm.` : "The demo data couldn't be reset. Nothing was changed." };
    say(st.message.text);
    draw();
  }

  // ---- drawing ----------------------------------------------------------------------------------

  function crewPicker(d) {
    return el("div", { class: "field live__picker" }, [
      el("label", { class: "field__label", for: "live-crew" }, "Crew member to edit"),
      el("div", { class: "field__control" }, el("select", { id: "live-crew", name: "live-crew", "data-live-action": "", onChange: (e) => select(e.target.value) }, [
        el("option", { value: "", selected: st.crewId === "" }, "Choose a crew member…"),
        ...d.crew.map((c) => el("option", { value: c.crewId, selected: c.crewId === st.crewId },
          `${c.name} · ${c.crewId} · ${c.missionRole || "Crew"} · ${c.alerts.status !== "ok" ? "alerts unavailable" : c.alerts.openCount ? `${c.alerts.openCount} open alert${c.alerts.openCount === 1 ? "" : "s"} (${c.alerts.topSeverity})` : "no open alerts"}`)),
      ])),
      el("p", { class: "field__hint" }, "Nothing can be changed until one crew member is chosen. Every value you apply is saved for that crew member only."),
    ]);
  }

  function crewStrip(d) {
    const short = { heartRate: "HR", spo2: "SpO₂", bpSystolic: "Sys", bpDiastolic: "Dia", sleepDuration: "Sleep" };
    return el("div", { class: "live__strip-wrap" }, [
      el("h3", { class: "live__h3", id: "live-strip-title" }, "Crew overview"),
      el("ul", { class: "live__strip", role: "list", "aria-labelledby": "live-strip-title" }, d.crew.map((c) => {
        const bp = c.latest.find((x) => x.metric === "bpSystolic");
        const dia = c.latest.find((x) => x.metric === "bpDiastolic");
        const values = [
          ...c.latest.filter((x) => ["heartRate", "spo2", "sleepDuration"].includes(x.metric)).map((x) => `${short[x.metric]} ${num(x.value, x.unit)}`),
          bp && dia ? `BP ${formatNumber(bp.value)}/${formatNumber(dia.value)} ${bp.unit}` : null,
        ].filter(Boolean);
        const on = c.crewId === st.crewId;
        return el("li", {}, el("button", {
          type: "button", class: ["live-chip", on ? "is-selected" : ""], "aria-pressed": on ? "true" : "false", "data-live-chip": c.crewId, "data-live-action": "",
          onClick: () => select(c.crewId),
        }, [
          el("span", { class: "live-chip__avatar", "aria-hidden": "true" }, initialsOf(c.name)),
          el("span", { class: "live-chip__body" }, [
            el("span", { class: "live-chip__name" }, `${c.name} · ${c.crewId}`),
            el("span", { class: "live-chip__values" }, values.length ? values.join(" · ") : "No stored readings"),
            el("span", { class: "live-chip__badge" }, alertBadge(c.alerts)),
          ]),
        ]));
      })),
    ]);
  }

  function editingHeader(s) {
    const pins = s.alerts.status === "ok" ? alertPins(s.alerts.items, { who: `${s.name}: ` }).map((p) => ({ ...p, label: p.label.replace(/Open details\.$/, "Open this alert on the Alerts page.") })) : [];
    return el("section", { class: "scan-stage live__editing", "aria-labelledby": "live-editing-title", "data-live-editing": s.crewId }, [
      el("span", { class: "live__avatar", "aria-hidden": "true" }, initialsOf(s.name)),
      el("div", { class: "live__editing-text" }, [
        el("h3", { class: "scan-stage__title", id: "live-editing-title", tabindex: "-1" }, `Editing: ${s.name} · ${s.crewId}`),
        el("p", { class: "scan-stage__note" }, `${s.missionRole || "Crew member"} · every value below is saved for ${s.name} only.`),
        el("p", { class: "live__editing-tags" }, [
          el("span", { class: "sim-tag" }, [icon("flask-conical", { size: 12 }), "Synthetic demonstration data"]),
          s.alerts.status === "ok"
            ? el("span", { class: "scan-stage__note" }, s.alerts.items.length ? `${s.alerts.items.length} open alert${s.alerts.items.length === 1 ? "" : "s"}: ${s.alerts.items.map((a) => `${a.number} ${a.title} (${a.severity})`).join("; ")}` : "No open alerts.")
            : el("span", { class: "scan-stage__note" }, "Open alerts couldn't be loaded."),
        ]),
      ]),
      el("div", { class: "live__editing-scan" }, createBodyScan({ crop: "upper", pins, hotspots: pins, onPinClick: (pin) => navigate(`#/alerts/${pin.alert.number}`) })),
    ]);
  }

  function runNotice(run) {
    if (!run || !run.active) return null;
    const mine = run.crewId && run.crewId === st.crewId;
    const who = `${run.name || "a crew member"}${run.crewId ? ` (${run.crewId})` : ""}`;
    const paused = run.status === "paused";
    return el("section", { class: "card live__run", "aria-labelledby": "live-run-title", "data-live-run": run.crewId || "" }, [
      el("h3", { class: "live__h3", id: "live-run-title" }, mine ? `Run in progress for ${who}` : `A run is active for ${who}`),
      el("p", { class: "sim__text" }, `${run.scenarioName} · step ${run.step} of ${run.totalSteps} · ${run.speed}× · ${paused ? "paused" : "running"}. Only one run can be active at a time.`),
      el("progress", { class: "live__progress", max: String(run.totalSteps), value: String(run.step), "aria-label": `Step ${run.step} of ${run.totalSteps}` }),
      st.confirmStop
        ? el("div", { class: "live__actions" }, [
            el("span", { class: "sim__note" }, `Stop the run for ${who}? Readings already generated stay stored.`),
            el("button", { type: "button", class: "btn btn--danger btn--sm", id: "live-stop-confirm", "data-live-action": "", onClick: () => runControl("stop") }, [icon("square"), `Stop run for ${run.name || "this crew member"}`]),
            el("button", { type: "button", class: "btn btn--secondary btn--sm", id: "live-stop-cancel", "data-live-action": "", onClick: () => { st.confirmStop = false; draw(); } }, [icon("x"), "Keep the run"]),
          ])
        : el("div", { class: "live__actions" }, [
            paused
              ? el("button", { type: "button", class: "btn btn--primary btn--sm", id: "live-run-resume", "data-live-action": "", onClick: () => runControl("resume") }, [icon("play"), "Play"])
              : el("button", { type: "button", class: "btn btn--secondary btn--sm", id: "live-run-pause", "data-live-action": "", onClick: () => runControl("pause") }, [icon("pause"), "Pause"]),
            el("button", { type: "button", class: "btn btn--secondary btn--sm", id: "live-run-stop", "data-live-action": "", onClick: () => { st.confirmStop = true; draw(); } }, [icon("square"), "Stop"]),
            !mine && run.crewId
              ? el("button", { type: "button", class: "btn btn--secondary btn--sm", id: "live-run-goto", "data-live-action": "", onClick: () => select(run.crewId) }, [icon("arrow-right"), `Go to ${run.name || run.crewId}`])
              : null,
          ]),
    ]);
  }

  function ruleText(m) {
    if (m.rule && m.extraRule && m.rule.available && m.extraRule.available) {
      return el("p", { class: "sim__note", "data-live-rule": m.rule.id }, [el("strong", {}, `Rules ${m.rule.id} · ${m.rule.title} and ${m.extraRule.id} · ${m.extraRule.title}: `), `${m.rule.limitsText}; ${m.extraRule.limitsText}. Demonstration threshold — not clinically validated.`]);
    }
    if (!m.rule) return el("p", { class: "sim__note" }, `No demonstration rule reads ${m.label.toLowerCase()}, so no limit is drawn.`);
    if (!m.rule.available) return el("p", { class: "sim__note" }, `Rule ${m.rule.id} (${m.rule.title}): its stored limits are not available, so no limit is drawn.`);
    return el("p", { class: "sim__note", "data-live-rule": m.rule.id }, [el("strong", {}, `Rule ${m.rule.id} · ${m.rule.title}: `), `${m.rule.limitsText}. Demonstration threshold — not clinically validated.`]);
  }

  function resultPanel(group) {
    const r = st.result;
    if (!r || r.group !== group.id) return null;
    const risk = r.risk || { status: "unavailable", rules: [] };
    const own = (risk.rules || []).filter((x) => group.keys.includes(x.metric));
    const others = (risk.changes || []).filter((c) => !own.some((x) => x.ruleId === c.ruleId));
    return el("div", { class: "live-result", role: "status", "data-live-result": group.id }, [
      el("p", { class: "live-result__saved" }, [icon("circle-check"), ` Saved for ${r.crew.name} (${r.crew.crewId}): ${r.readings.map((x) => `${x.label} ${num(x.value, x.unit)}`).join(" and ")} · `, utcTime(r.at)]),
      risk.status !== "evaluated"
        ? el("p", { class: "sim__note" }, risk.status === "not_configured" ? "Risk evaluation is not configured." : "Risk evaluation unavailable for this reading. The reading was saved.")
        : null,
      ...own.map((x) => {
        const [cls, ic, word] = OUTCOME_VIEW[x.outcome] || OUTCOME_VIEW.insufficient;
        const sev = x.outcome === "triggered" && x.severity === "critical" ? ["badge--critical", "circle-alert", "Rule met · critical"] : [cls, ic, x.outcome === "triggered" ? `${word} · ${x.severity}` : word];
        return el("div", { class: "live-result__rule", "data-live-result-rule": x.ruleId }, [
          el("p", { class: "live-result__head" }, [el("strong", {}, `${x.ruleId} · ${x.title}`), " ", badge(sev[0], sev[1], sev[2])]),
          el("p", { class: "sim__text" }, x.explanation || "No explanation returned."),
          x.limitsText ? el("p", { class: "sim__note" }, `Limits used: ${x.limitsText}.`) : null,
          x.change && x.change !== "none"
            ? el("p", { class: "sim__text" }, [`Alert ${x.alertNumber} ${CHANGE_WORD[x.change] || x.change}${x.alertSeverity ? ` (${x.alertSeverity})` : ""}. `, x.alertNumber ? el("a", { href: `#/alerts/${x.alertNumber}` }, "Open the alert") : null])
            : el("p", { class: "sim__note" }, x.outcome === "insufficient" && (x.reason === "mixed" || x.reason === "too_few_usable")
              ? "No alert change yet. The rule needs consecutive readings — apply the value again to add another reading."
              : "No alert was opened or changed."),
        ]);
      }),
      risk.status === "evaluated" && !own.length ? el("p", { class: "sim__note" }, "No demonstration rule reads this measure, so no alert can change.") : null,
      others.length ? el("p", { class: "sim__note" }, `Other alert changes for ${r.crew.name}: ${others.map((c) => `${c.alertNumber} ${c.title} ${CHANGE_WORD[c.change] || c.change}`).join("; ")}.`) : null,
    ]);
  }

  function chartCard(group, s, run) {
    const metrics = group.keys.map((k) => s.metrics.find((m) => m.key === k)).filter(Boolean);
    if (!metrics.length) return null;
    const main = metrics[0];
    const titleId = `live-${group.id}-title`;
    const locked = Boolean(run && run.active && run.crewId === s.crewId); // single values are refused while this member has a run
    const curve = st.curve && st.curve.group === group.id ? st.curve : null;
    const error = metrics.some((m) => m.readings.status === "error");

    const chart = createLiveChart({
      id: `live-chart-${group.id}`,
      label: group.title,
      unit: main.unit,
      min: Math.min(...metrics.map((m) => m.min)),
      max: Math.max(...metrics.map((m) => m.max)),
      step: main.step,
      series: metrics.map((m) => ({ key: m.key, label: m.label, readings: m.readings.items })),
      baseline: main.baseline,
      rules: [main.rule, main.extraRule].filter((r) => r && r.available),
      handles: metrics.map((m) => ({ key: m.key, label: `Next ${m.label.toLowerCase()} for ${s.name}`, value: st.draft[m.key] })),
      disabled: locked,
      onChange: (key, raw) => {
        const own = metrics.find((m) => m.key === key);
        const value = own ? snapValue(raw, own) : raw; // each handle keeps to its own metric's input range
        if (value !== raw) chart.setValue(key, value);
        st.draft[key] = value;
        st.dirty.add(key);
        for (const n of node.querySelectorAll("[data-live-input]")) if (n.getAttribute("data-live-input") === key) n.value = String(value);
      },
      onCurveChange: (_i, _v, values) => { if (st.curve) st.curve.values = values; },
    });
    if (curve) chart.setCurve(curve.values);
    charts.set(group.id, chart);

    const inputs = metrics.map((m) => el("div", { class: "field live-card__field" }, [
      el("label", { class: "field__label", for: `live-input-${m.key}` }, `${metrics.length > 1 ? m.label : "Next value"} (${m.unit}, ${formatNumber(m.min)}–${formatNumber(m.max)})`),
      el("div", { class: "field__control" }, el("input", {
        type: "number", id: `live-input-${m.key}`, "data-live-input": m.key, "data-live-action": "", inputmode: "decimal",
        min: String(m.min), max: String(m.max), step: String(m.step), value: String(st.draft[m.key]), disabled: locked,
        onChange: (e) => {
          const v = snapValue(Number(e.target.value), m); // clamped to the input range
          st.draft[m.key] = v;
          st.dirty.add(m.key);
          e.target.value = String(v);
          chart.setValue(m.key, v);
        },
      })),
    ]));

    const latest = metrics.every((m) => m.latest)
      ? el("p", { class: "sim__note" }, [`Latest stored: ${metrics.length > 1 ? `${formatNumber(metrics[0].latest.value)}/${formatNumber(metrics[1].latest.value)} ${main.unit}` : num(main.latest.value, main.unit)} · `, utcTime(main.latest.timestamp), ` · ${formatRelative(main.latest.timestamp, st.data.generatedAt)}`, main.baseline !== null ? ` · baseline ${num(main.baseline, main.unit)}` : " · no baseline stored"])
      : el("p", { class: "sim__note" }, "No stored reading yet.");

    const curveBox = !main.curve ? null : curve
      ? el("div", { class: "live-card__curve", "data-live-curve": group.id }, [
          el("p", { class: "sim__note" }, `Drag the ${curve.values.length} points (or focus one and use the arrow keys). Play writes one reading per step for ${s.name}${group.keys.length > 1 ? `, each with the diastolic value ${formatNumber(st.draft.bpDiastolic)} ${main.unit}` : ""}.`),
          el("div", { class: "live-card__row" }, [
            el("div", { class: "field" }, [
              el("label", { class: "field__label", for: `live-points-${group.id}` }, "Points"),
              el("div", { class: "field__control" }, el("select", { id: `live-points-${group.id}`, "data-live-action": "", onChange: (e) => { resizeCurve(Number(e.target.value)); } },
                Array.from({ length: st.data.curve.maxPoints - st.data.curve.minPoints + 1 }, (_x, i) => st.data.curve.minPoints + i).map((n) => el("option", { value: String(n), selected: n === curve.values.length }, String(n))))),
            ]),
            el("div", { class: "field" }, [
              el("label", { class: "field__label", for: `live-speed-${group.id}` }, "Speed"),
              el("div", { class: "field__control" }, el("select", { id: `live-speed-${group.id}`, "data-live-action": "", onChange: (e) => { st.curve.speed = Number(e.target.value); } },
                speeds.map((sp) => el("option", { value: String(sp), selected: sp === curve.speed }, `${sp}×`)))),
            ]),
          ]),
          el("label", { class: "sim-check", for: `live-curve-confirm-${group.id}` }, [
            el("input", { type: "checkbox", id: `live-curve-confirm-${group.id}`, checked: curve.confirm, "data-live-action": "", onChange: (e) => { st.curve.confirm = e.target.checked === true; draw(); } }),
            el("span", {}, `I understand this writes ${curve.values.length} synthetic readings for ${s.name} (${s.crewId}).`),
          ]),
          el("div", { class: "live__actions" }, [
            el("button", { type: "button", class: "btn btn--primary btn--sm", id: `live-play-${group.id}`, "data-live-action": "", disabled: !curve.confirm || Boolean(run && run.active), onClick: () => playCurve() }, [icon("play"), `Play curve for ${s.name}`]),
            el("button", { type: "button", class: "btn btn--secondary btn--sm", id: `live-curve-cancel-${group.id}`, "data-live-action": "", onClick: () => { st.curve = null; draw(); } }, [icon("x"), "Discard curve"]),
          ]),
          run && run.active ? el("p", { class: "sim__note" }, "A run is already active, so a new curve can't start until it is stopped or finished.") : null,
        ])
      : el("button", { type: "button", class: "btn btn--secondary btn--sm", id: `live-curve-${group.id}`, "data-live-action": "", disabled: locked, onClick: () => openCurve(group, main) }, [icon("activity"), "Draw a curve"]);

    return el("article", { class: "card live-card", "aria-labelledby": titleId, "data-live-card": group.id }, [
      el("div", { class: "live-card__head" }, [
        el("h4", { class: "live-card__title", id: titleId }, `${group.title} · ${s.name}`),
        el("span", { class: "sim-tag" }, "Synthetic demonstration data"),
      ]),
      latest,
      error ? sectionError(() => load(), "these readings") : null,
      el("div", { class: "scan-stage live-card__chart" }, chart.node),
      ruleText(main),
      GROUP_NOTES[group.id] ? el("p", { class: "sim__note" }, GROUP_NOTES[group.id]) : null,
      locked ? el("p", { class: "sim__note" }, `A run is active for ${s.name}, so single values can't be applied until it is stopped or finished.`) : null,
      curve ? null : el("div", { class: "live-card__row" }, inputs),
      curve ? null : el("div", { class: "live__actions" }, [
        el("button", { type: "button", class: "btn btn--primary btn--sm", id: `live-apply-${group.id}`, "data-live-apply": group.id, "data-live-action": "", disabled: locked, onClick: () => apply(group) }, [icon("check"), `Apply to ${s.name}`]),
      ]),
      curveBox,
      resultPanel(group),
    ]);
  }

  function openCurve(group, m) {
    const n = 8;
    const from = st.draft[m.key];
    st.curve = { group: group.id, metric: m.key, values: Array.from({ length: n }, () => from), speed: defaultSpeed, confirm: false };
    draw();
    say(`Curve mode for ${group.title}: ${n} points. Drag them or use the arrow keys, then press Play.`);
  }

  function resizeCurve(n) {
    const c = st.curve;
    if (!c || !Number.isInteger(n)) return;
    const chart = charts.get(c.group);
    const cur = chart && chart.getCurve() ? chart.getCurve() : c.values;
    c.values = Array.from({ length: n }, (_x, i) => cur[Math.min(i, cur.length - 1)]);
    c.confirm = false;
    draw();
  }

  function resetSection() {
    const ok = st.resetText === RESET_PHRASE && !st.resetBusy;
    return el("section", { class: "card live__reset", "aria-labelledby": "live-reset-title" }, [
      el("h3", { class: "live__h3", id: "live-reset-title" }, "Reset demo data"),
      el("p", { class: "sim__text" }, "Restores this browser's synthetic demo data to its starting state, so the demonstration can be repeated. This can't be undone, and every open tab is signed out afterwards."),
      el("div", { class: "field" }, [
        el("label", { class: "field__label", for: "live-reset-phrase" }, `Type ${RESET_PHRASE} to confirm`),
        el("div", { class: "field__control" }, el("input", { type: "text", id: "live-reset-phrase", autocomplete: "off", spellcheck: "false", value: st.resetText, "aria-describedby": "live-reset-help", onInput: (e) => { st.resetText = e.target.value; for (const b of node.querySelectorAll("[data-live-reset]")) b.disabled = !(st.resetText === RESET_PHRASE && !st.resetBusy); } })),
        el("p", { class: "field__hint", id: "live-reset-help" }, `The button is enabled only when the text is exactly ${RESET_PHRASE} (capital letters).`),
      ]),
      el("button", { type: "button", class: "btn btn--danger btn--sm", id: "live-reset", "data-live-reset": "", disabled: !ok, onClick: () => resetDemo() }, [icon("rotate-ccw"), st.resetBusy ? "Resetting…" : "Reset demo data"]),
    ]);
  }

  function draw() {
    const activeId = globalThis.document && document.activeElement && typeof document.activeElement.getAttribute === "function" ? document.activeElement.getAttribute("id") : null;
    charts.clear();
    const d = st.data;
    if (!d) {
      node.replaceChildren(el("p", { class: "sim__note", role: "status" }, "Loading Live control…"));
      return;
    }
    if (d.status !== "ready") {
      node.replaceChildren(el("div", { class: "card", role: "alert" }, [
        el("p", { class: "sim__text" }, d.status === "forbidden" ? "Live control is for the Medical Officer role only." : "Live control couldn't be loaded. Nothing was changed."),
        el("button", { type: "button", class: "btn btn--secondary btn--sm", "data-retry": "", onClick: () => load() }, [icon("rotate-ccw"), "Retry"]),
      ]));
      return;
    }
    const s = selected();
    const run = host.getRun();
    st.lastRunStep = run && run.active ? `${run.runRef}:${run.step}:${run.status}` : null;
    node.replaceChildren(...[
      el("section", { class: "live__intro", "aria-labelledby": "live-title" }, [
        el("h3", { class: "live__h3", id: "live-title" }, "Live control"),
        el("p", { class: "sim__text" }, "Choose one crew member, set a value on a chart and apply it. The value is saved as a synthetic reading at the current time, the demonstration risk rules are evaluated, and every open screen for that crew member updates."),
        el("p", { class: "sim__note" }, ["To watch an astronaut's screens update, ", el("a", { href: "login.html?tab=1", target: "_blank", rel: "noopener" }, "open a second window and sign in for that tab only"), " (for example as reyes), and keep it beside this one."]),
      ]),
      st.message ? el("p", { class: ["banner", st.message.tone === "error" ? "banner--critical" : ""], role: st.message.tone === "error" ? "alert" : "status" }, [icon(st.message.tone === "error" ? "circle-alert" : "info"), el("span", { class: "banner__text" }, st.message.text)]) : null,
      st.notice ? el("p", { class: "banner", role: "status", "data-live-notice": "" }, [icon("info"), el("span", { class: "banner__text" }, st.notice)]) : null,
      runNotice(run),
      crewPicker(d),
      crewStrip(d),
      s ? editingHeader(s) : el("p", { class: "sim__note", "data-live-empty": "" }, "No crew member is selected. Choose one above to see their charts."),
      s ? el("div", { class: "live__charts" }, GROUPS.map((g) => chartCard(g, s, run))) : null,
      resetSection(),
    ].filter(Boolean));
    if (activeId) for (const n of node.querySelectorAll("[id]")) if (n.getAttribute("id") === activeId && typeof n.focus === "function") n.focus();
  }

  return {
    node,
    load: () => load(),
    /** Called by the Simulation Center after it reloaded its own state (e.g. a curve step landed). */
    sync() {
      if (!st.data || aborted()) return;
      const run = host.getRun();
      const key = run && run.active ? `${run.runRef}:${run.step}:${run.status}` : null;
      if (key === st.lastRunStep) return;
      if (run && st.crewId && run.crewId === st.crewId) {
        const risk = host.lastRisk();
        if (risk && run.metric) {
          const group = GROUPS.find((g) => g.keys.includes(run.metric));
          const last = run.readings && run.readings.status === "ok" && run.readings.items.length ? run.readings.items[run.readings.items.length - 1] : null;
          const m = metricOf(run.metric);
          if (group && last && m) st.result = { group: group.id, crew: { crewId: run.crewId, name: run.name }, readings: [{ label: m.label, value: last.value, unit: last.unit }], risk, at: last.timestamp };
        }
      }
      load();
    },
    selectedCrewId: () => st.crewId,
    hasUnsaved: () => st.dirty.size > 0 || Boolean(st.curve),
  };
}
