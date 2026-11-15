// js/pages/simulation-center.js — #/simulation, the Simulation Center (Sprint 7;
// Sprint 8 shows each step's risk-evaluation result from the service).
//
// Medical Officer only (the route guard denies astronauts before this module
// runs; the service refuses them again). Presentation and the step timer
// live here; every rule and every write lives in
// js/services/simulation-service.js. No js/db imports; text inserted via el().
//
// TIMER: this page owns one setTimeout chain (never setInterval), only for a
// run this tab started, resumed or chose to "Continue". After each step the
// page reloads the state and schedules only the next step. The timer is
// cleared on pause, stop, completion, errors, abort/navigation and when the
// view is replaced. Leaving the page writes nothing: no auto-pause, no
// backfill. A run left "running" with no recent step is shown as
// "Not advancing" and waits for a deliberate Continue, Pause or Stop.
//
// The opaque run reference returned by the service is kept in memory only —
// never rendered, never put in a URL.
//
// TABS: "Scenarios" (the catalog runs, as before) and "Live control"
// (js/components/live-control-view.js): the Medical Officer sets synthetic values on
// charts for one crew member. A custom curve started there is advanced by
// THIS page's timer, like any other run. This module also connects the
// simulation service's "data changed" notices to the event bus, so open
// screens (this tab and others) refresh after every committed reading.
//
// Test seam: createSimulationCenterRenderer({ service, timers, channel, live, reset, notifyReset }).

import {
  getSimulationCenter,
  previewSimulation,
  startSimulation,
  advanceSimulation,
  pauseSimulation,
  resumeSimulation,
  stopSimulation,
  recordManualReading,
  startCustomCurve,
  connectSimulationEvents,
  DEFAULT_SPEED,
} from "../services/simulation-service.js";
import { getLiveControl } from "../services/live-control-service.js";
import { resetDemoData } from "../services/demo-reset-service.js";
import { createLiveControl } from "../components/live-control-view.js";
import { bus } from "../core/event-bus.js";
import { icon } from "../components/icon.js";
import { el } from "../core/utils/dom.js";
import { formatNumber, formatRelative } from "../core/utils/format.js";
import { badge, loadingView, section, sectionError, srOnly, syntheticNotice, utcTime } from "../components/crew-view.js";
import { refusalView } from "../components/health-view.js";
import { createContextBodyScan } from "../components/context-body-scan.js";

const BASE = "simulation";

// Committed readings and alert changes → event bus (same tab + other tabs).
connectSimulationEvents((name, data) => bus.emit(name, data));

const STATUS_VIEW = Object.freeze({
  running: { icon: "play", label: "Running", badge: "badge--info" },
  stale: { icon: "clock", label: "Not advancing", badge: "badge--neutral" },
  paused: { icon: "pause", label: "Paused", badge: "badge--neutral" },
  completed: { icon: "circle-check", label: "Completed", badge: "badge--ok" },
  stopped: { icon: "square", label: "Stopped", badge: "badge--neutral" },
});

const MESSAGES = {
  another_run_active: "Another simulation is already active. Only one run can be active at a time — stop it first.",
  step_mismatch: "The run was advanced elsewhere (for example in another tab). The latest state is shown.",
  not_running: "The run is not running any more. The latest state is shown.",
  clock_not_monotonic: "This device's clock is not later than the last generated step, so no reading was written. Check the device clock, then continue.",
  scenario_unavailable: "This run's scenario is not available in this version of the app. It can only be stopped.",
  run_changed: "The run changed while the step was prepared. Nothing was written. The latest state is shown.",
  invalid_transition: "That action isn't possible for the run's current status. The latest state is shown.",
  astronaut_missing: "The crew member for this run is no longer stored on this device. Nothing was written. The run can only be stopped.",
  unknown_run: "The run was not found. The latest state is shown.",
  unknown_scenario: "Choose a scenario from the list.",
  invalid_speed: "Choose a speed from the list.",
  confirmation_required: "Please confirm before continuing.",
  unknown_crew_id: "That crew member was not found on this device.",
  invalid_crew_id: "Choose a crew member from the list.",
  operation_in_progress: "Another action is still in progress. Try again in a moment.",
  database_error: "The database couldn't be updated. Nothing was saved.",
  unexpected_error: "Something went wrong. Nothing was saved.",
};
const messageFor = (res) => MESSAGES[res && res.reason] || MESSAGES.unexpected_error;

const defaultTimers = Object.freeze({ set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) });
/** Cross-tab refresh ping: no payload, so nothing sensitive leaves this tab. */
const defaultChannel = Object.freeze({
  subscribe: (fn) => bus.on("simulation:changed", (_data, meta) => { if (meta && meta.remote) fn(); }),
  notify: () => bus.emit("simulation:changed", {}),
  notifyAlerts: () => bus.emit("alert:changed", {}),
});

/** "1 min 36 s", "12 s" */
export function durationText(ms) {
  const total = Math.round(ms / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min ? `${min} min${sec ? ` ${sec} s` : ""}` : `${sec} s`;
}

const unitText = (value, unit) => `${formatNumber(value)} ${unit}`;

function statusKey(run, driving) {
  if (run.status === "running" && run.stale && driving !== run.runRef) return "stale";
  return STATUS_VIEW[run.status] ? run.status : "stopped";
}

function statusBadge(key) {
  const v = STATUS_VIEW[key];
  return badge(v.badge, v.icon, v.label);
}

/** TEST SEAM. Production uses renderSimulationCenter. */
export function createSimulationCenterRenderer({ service, timers = defaultTimers, channel = defaultChannel, live: liveService = null, reset: resetService = null, notifyReset = () => bus.emit("demo:reset", {}) }) {
  return function render(container, session, { signal, focus = false } = {}) {
    const live = el("p", { class: "sr-only", role: "status", "aria-live": "polite" });
    const content = el("div", { class: "sim__content", id: "sim-panel-scenarios", role: "tabpanel", "aria-labelledby": "sim-tab-scenarios" });
    const livePanel = el("div", { class: "sim__content", id: "sim-panel-live", role: "tabpanel", "aria-labelledby": "sim-tab-live", hidden: true });
    const tabs = el("div", { class: "sim-tabs", role: "tablist", "aria-label": "Simulation Center sections" });
    const root = el("div", { class: "sim", "aria-busy": "false" }, liveService ? [live, tabs, content, livePanel] : [live, content]);
    container.replaceChildren(root);
    let tab = "scenarios";
    let liveView = null;

    const st = {
      data: null,
      generation: 0,
      timer: null,
      driving: null, // runRef this tab advances (memory only)
      busy: false,
      confirmStop: false,
      message: null, // { tone: "error" | "info", text }
      risk: null, // the last step's risk-evaluation result (public alert numbers only)
      form: { crewId: "", scenarioId: "", speed: DEFAULT_SPEED, confirm: false },
      preview: null,
      previewGen: 0,
      focusHeading: focus,
    };
    const aborted = () => Boolean(signal && signal.aborted);
    const clearTimer = () => {
      if (st.timer !== null) {
        timers.clear(st.timer);
        st.timer = null;
      }
    };
    const announce = (text) => { live.textContent = text; };

    const unsubscribe = channel.subscribe(() => { if (!aborted() && !st.busy) load(); });
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimer();
        st.driving = null;
        if (typeof unsubscribe === "function") unsubscribe();
      }, { once: true });
    }

    // ---- tabs ("Scenarios" | "Live control") ------------------------------------------------

    function drawTabs() {
      if (!liveService) return;
      const item = (key, text, iconName) => el("button", {
        type: "button", class: ["sim-tab", tab === key ? "is-active" : ""], role: "tab", id: `sim-tab-${key}`,
        "aria-selected": tab === key ? "true" : "false", "aria-controls": `sim-panel-${key}`, tabindex: tab === key ? "0" : "-1",
        onClick: () => showTab(key),
        onKeydown: (e) => {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          showTab(key === "live" ? "scenarios" : "live");
          for (const n of tabs.querySelectorAll("[id]")) if (n.getAttribute("id") === `sim-tab-${tab}` && typeof n.focus === "function") n.focus();
        },
      }, [icon(iconName), text]);
      tabs.replaceChildren(item("scenarios", "Scenarios", "flask-conical"), item("live", "Live control", "sliders-horizontal"));
    }

    function showTab(key) {
      if (!liveService || key === tab) return;
      tab = key;
      if (tab === "live") {
        content.setAttribute("hidden", "");
        livePanel.removeAttribute("hidden");
        if (!liveView) {
          liveView = createLiveControl({
            session,
            service: { recordManualReading: (s, i) => service.recordManualReading(s, i), startCustomCurve: (s, i) => service.startCustomCurve(s, i) },
            live: liveService,
            reset: resetService,
            notifyReset,
            signal,
            host: {
              getRun: () => (st.data && st.data.run ? st.data.run : null),
              lastRisk: () => st.risk,
              announce,
              control: (kind) => control(kind),
              adoptRun: async (runRef) => {
                st.driving = runRef;
                st.risk = null;
                channel.notify();
                await load();
              },
            },
          });
          livePanel.replaceChildren(liveView.node);
        }
        liveView.load();
        announce("Live control. Choose a crew member to edit.");
      } else {
        livePanel.setAttribute("hidden", "");
        content.removeAttribute("hidden");
        announce("Scenarios.");
      }
      drawTabs();
    }

    // ---- actions --------------------------------------------------------------------------

    /** Run one service call with every control disabled. Returns null when the view was left. */
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

    function fail(res) {
      st.driving = null;
      clearTimer();
      st.message = { tone: "error", text: messageFor(res) };
      announce(st.message.text);
    }

    async function advance() {
      const run = st.data && st.data.run;
      if (!run || st.busy || aborted()) return;
      clearTimer();
      const res = await act(() => service.advanceSimulation(session, run.runRef, { expectedStep: run.step }));
      if (!res) return;
      if (res.status === "advanced" || res.status === "completed") {
        st.risk = res.risk ? { ...res.risk, step: res.step } : null;
        const major = st.risk && st.risk.status === "evaluated" ? st.risk.changes.filter((c) => c.change === "opened" || c.change === "escalated") : [];
        if (st.risk && st.risk.status !== "evaluated" && st.risk.status !== "not_configured") announce("Risk evaluation unavailable for this step. The reading was saved.");
        else if (major.length) announce(major.map((c) => `${c.alertNumber} ${c.title} ${c.change} (${c.severity}).`).join(" "));
        if (st.risk && st.risk.changes && st.risk.changes.length && typeof channel.notifyAlerts === "function") channel.notifyAlerts();
      }
      if (res.status === "advanced") {
        st.message = null;
        channel.notify();
      } else if (res.status === "completed") {
        st.driving = null;
        st.message = { tone: "info", text: `Simulation completed. All ${res.totalSteps} steps were generated.` };
        announce(st.message.text);
        channel.notify();
      } else if (res.status === "conflict" && res.reason === "step_mismatch") {
        st.message = { tone: "info", text: messageFor(res) }; // keep driving: the next step continues from the stored state
      } else {
        fail(res);
      }
      await load();
    }

    async function control(kind) {
      const run = st.data && st.data.run;
      if (!run || st.busy) return;
      clearTimer();
      if (kind === "continue") {
        st.driving = run.runRef;
        st.message = null;
        announce("Continuing the simulation in this tab.");
        draw();
        schedule();
        return;
      }
      if (kind === "pause") st.driving = null;
      const call =
        kind === "pause" ? () => service.pauseSimulation(session, run.runRef)
        : kind === "resume" ? () => service.resumeSimulation(session, run.runRef)
        : () => service.stopSimulation(session, run.runRef, { confirm: true });
      const res = await act(call);
      if (!res) return;
      st.confirmStop = false;
      if (res.status === "paused" || (kind === "pause" && res.status === "unchanged")) {
        st.message = null;
        announce("Simulation paused.");
      } else if (res.status === "running" || (kind === "resume" && res.status === "unchanged")) {
        st.driving = run.runRef;
        st.message = null;
        announce("Simulation resumed.");
      } else if (res.status === "stopped" || (kind === "stop" && res.status === "unchanged")) {
        st.driving = null;
        st.message = { tone: "info", text: "Simulation stopped. Readings already generated stay stored and labelled Simulated." };
        announce("Simulation stopped.");
      } else {
        fail(res);
      }
      if (["paused", "running", "stopped"].includes(res.status)) channel.notify();
      await load();
    }

    async function requestPreview() {
      const { crewId, scenarioId } = st.form;
      const token = ++st.previewGen;
      st.preview = { status: "loading" };
      draw();
      let res;
      try {
        res = await service.previewSimulation(session, { crewId, scenarioId });
      } catch {
        res = { status: "unavailable", reason: "unexpected_error" };
      }
      if (token !== st.previewGen || aborted()) return;
      st.preview = res;
      draw();
    }

    async function start() {
      const f = st.form;
      if (st.busy || !canStart()) return;
      const res = await act(() => service.startSimulation(session, { crewId: f.crewId, scenarioId: f.scenarioId, speed: f.speed, confirm: f.confirm === true }));
      if (!res) return;
      if (res.status === "started") {
        st.driving = res.runRef;
        st.form = { crewId: "", scenarioId: "", speed: DEFAULT_SPEED, confirm: false };
        st.preview = null;
        st.message = null;
        announce(`Simulation started for ${res.run.name}.`);
        channel.notify();
      } else if (res.status === "conflict" && res.activeRun) {
        const a = res.activeRun;
        st.message = { tone: "error", text: `${messageFor(res)} Active: ${a.name || "a crew member"}${a.crewId ? ` (${a.crewId})` : ""}, ${a.scenarioName}.` };
        announce(st.message.text);
      } else {
        fail(res);
      }
      await load();
    }

    function canStart() {
      const f = st.form;
      return Boolean(f.crewId && f.scenarioId && f.confirm === true && st.preview && st.preview.status === "ready");
    }

    // ---- timer -------------------------------------------------------------------------------

    function schedule() {
      clearTimer();
      const run = st.data && st.data.run;
      if (aborted() || st.busy || !run || run.status !== "running" || st.driving !== run.runRef || run.scenarioAvailable !== true || run.astronautAvailable === "no") return;
      st.timer = timers.set(() => {
        st.timer = null;
        advance();
      }, run.stepIntervalMs);
    }

    // ---- loading -------------------------------------------------------------------------------

    async function load() {
      const token = ++st.generation;
      root.setAttribute("aria-busy", "true");
      if (!st.data) content.replaceChildren(...loadingView("Loading the Simulation Center…"));
      let res;
      try {
        res = await service.getSimulationCenter(session);
      } catch {
        res = { status: "unavailable", reason: "unexpected_error" };
      }
      if (token !== st.generation || aborted()) return;
      root.setAttribute("aria-busy", "false");
      if (!res || res.status !== "ready") {
        clearTimer();
        st.driving = null;
        st.data = null;
        content.replaceChildren(refusalView(res, () => load(), BASE));
        return;
      }
      st.data = res;
      const run = res.run;
      if (st.driving && (!run || run.runRef !== st.driving || run.status !== "running")) st.driving = null;
      if (!run || !run.active) st.confirmStop = false;
      draw();
      schedule();
      if (liveView) liveView.sync(); // a curve step landed, a run changed, …
      if (st.focusHeading) {
        st.focusHeading = false;
        for (const n of content.querySelectorAll("[data-heading]")) n.focus();
      }
    }

    // ---- drawing -------------------------------------------------------------------------------

    function draw() {
      const activeId = globalThis.document && document.activeElement && typeof document.activeElement.getAttribute === "function"
        ? document.activeElement.getAttribute("id")
        : null;
      const d = st.data;
      const run = d.run;
      const parts = [header(d), messageBox()];
      parts.push(simulationScan(run));
      if (run && run.active) parts.push(activeRunSection(run));
      if (d.active.status === "error") parts.push(section("sim-active-title", "Active run", [sectionError(() => load(), "the active run")]));
      else if (!run || !run.active) {
        if (run) parts.push(activeRunSection(run)); // the most recent finished run
        parts.push(startSection(d));
      }
      if (run) parts.push(readingsSection(run), timelineSection(run));
      parts.push(recentSection(d), notesSection(d));
      content.replaceChildren(...parts.filter(Boolean));
      if (activeId) {
        for (const n of content.querySelectorAll("[id]")) if (n.getAttribute("id") === activeId && typeof n.focus === "function") n.focus();
      }
    }

    function simulationScan(run) {
      if (!run) return createContextBodyScan({
        id: "simulation-body-map-title",
        title: "Simulation body map",
        description: "Start a simulation to see its deterministic synthetic readings mapped to the relevant body area here.",
        pins: [], compact: true, eyebrow: "Simulation ready",
        note: "No simulation is active. The body map never generates or changes a reading by itself.",
      });
      const targetId = run.active ? "sim-run-title" : "sim-readings-title";
      return createContextBodyScan({
        id: "simulation-body-map-title",
        title: run.active ? "Live simulation body map" : "Last simulation body map",
        description: `${run.scenarioName} for ${run.name || run.crewId || "the selected crew member"}. The marker follows generated synthetic readings only.`,
        pins: [{
          number: 1, zone: "lungs", severity: run.active ? "warning" : "info",
          tag: `Step ${run.step} of ${run.totalSteps}`,
          label: `Go to simulation details, step ${run.step} of ${run.totalSteps}`,
          targetId,
        }],
        compact: true, eyebrow: run.active ? "Simulation running" : "Simulation record",
        note: "Simulation output is deterministic demonstration data and is not clinically validated.",
      });
    }

    function header(d) {
      return el("section", { class: "sim__header", "aria-labelledby": "sim-title" }, [
        el("div", { class: "sim__title-row" }, [
          el("h2", { class: "sim__title", id: "sim-title", tabindex: "-1", "data-heading": "" }, "Simulation Center"),
          el("span", { class: "sim-tag" }, [icon("flask-conical", { size: 12 }), "SIMULATED"]),
        ]),
        el("p", { class: "sim__subtitle" }, "Generate deterministic synthetic readings for one crew member and watch them appear in the dashboards."),
        syntheticNotice(),
        el("p", { class: "sim__note" }, d.notes.disclaimer),
      ]);
    }

    function messageBox() {
      if (!st.message) return null;
      const error = st.message.tone === "error";
      return el("div", { class: ["banner", "sim__message", error ? "banner--critical" : ""] }, [
        icon(error ? "circle-alert" : "info"),
        el("p", { class: "banner__text" }, st.message.text),
      ]);
    }

    function activeRunSection(run) {
      const key = statusKey(run, st.driving);
      const driving = st.driving === run.runRef;
      const title = run.active ? "Active run" : "Last run";
      const pct = run.totalSteps ? Math.round((run.step / run.totalSteps) * 100) : 0;
      const who = run.crewId ? `${run.name} · ${run.crewId}` : run.astronautAvailable === "no" ? "Crew member no longer available" : "Crew member unknown";

      const facts = [
        ["Crew member", who],
        ["Scenario", run.scenarioName],
        ["Speed", `${run.speed}× · one step every ${durationText(run.stepIntervalMs)}`],
        ["Started", utcTime(run.startedAt)],
        ["Last step", run.step > 0 ? [utcTime(run.lastStepAt), ` · ${formatRelative(run.lastStepAt, st.data.generatedAt)}`] : "No step yet"],
        run.status === "paused" ? ["Paused", utcTime(run.pausedAt)] : null,
        run.endedAt ? ["Ended", utcTime(run.endedAt)] : null,
        ["Started by", run.operatorName],
      ].filter(Boolean);

      let explain = null;
      if (run.active && run.astronautAvailable === "no") explain = "The crew member for this run is no longer stored on this device. The run can only be stopped.";
      else if (run.active && run.scenarioAvailable !== true) explain = "This run's scenario is not available in this version of the app. The run can only be stopped.";
      else if (key === "stale") explain = "Not advancing — the page may have been closed. Missed steps are never filled in. Continue in this tab, pause, or stop.";
      else if (run.status === "running" && !driving) explain = "Running, but not advanced by this tab — it may be advancing in another tab or window. Continue here, pause, or stop.";
      else if (run.status === "paused") explain = "Paused. Resume to generate the next reading, or stop the run.";

      return section("sim-run-title", title, [
        el("div", { class: "sim-run__status" }, [statusBadge(key), el("span", { class: "sim-run__step", id: "sim-progress-text" }, `Step ${run.step} of ${run.totalSteps}`)]),
        el("progress", { class: "sim-progress", max: String(run.totalSteps || 1), value: String(run.step), "aria-labelledby": "sim-run-title", "aria-describedby": "sim-progress-text" }, `${pct}%`),
        el("dl", { class: "sim-facts" }, facts.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)])),
        explain ? el("p", { class: "sim__text" }, explain) : null,
        riskBox(),
        run.active ? controls(run, key, driving) : null,
        run.active ? stopConfirm(run) : null,
      ]);
    }

    function button(id, action, cls, iconName, label, onClick, disabled, describedBy) {
      return el("button", {
        class: ["btn", cls, "btn--sm"], type: "button", id, "data-action": action,
        disabled: st.busy || disabled, "aria-describedby": describedBy, onClick,
      }, [icon(iconName), label]);
    }

    function controls(run, key, driving) {
      const usable = run.scenarioAvailable === true && run.astronautAvailable !== "no";
      const list = [];
      if (run.status === "running" && usable && !driving) list.push(button("sim-continue", "continue", "btn--primary", "play", "Continue in this tab", () => control("continue")));
      if (run.status === "running") list.push(button("sim-pause", "pause", "btn--secondary", "pause", "Pause", () => control("pause")));
      if (run.status === "paused" && usable) list.push(button("sim-resume", "resume", "btn--primary", "play", "Resume", () => control("resume")));
      const stepBlocked = run.status !== "running" || !usable;
      list.push(button("sim-advance", "advance", "btn--secondary", "arrow-right", "Advance one step", () => advance(), stepBlocked, stepBlocked ? "sim-advance-help" : undefined));
      list.push(button("sim-stop", "stop", "btn--danger", "square", "Stop", () => { st.confirmStop = true; draw(); for (const n of content.querySelectorAll("[data-stop-title]")) n.focus(); }, st.confirmStop));
      return el("div", { class: "sim-controls" }, [
        el("div", { class: "sim-controls__row", role: "group", "aria-label": "Simulation controls" }, list),
        stepBlocked
          ? el("p", { class: "sim__note", id: "sim-advance-help" }, run.status === "paused" ? "Advancing is disabled while the run is paused." : "Advancing is disabled for this run.")
          : el("p", { class: "sim__note" }, key === "running" && driving ? `This tab advances one step every ${durationText(run.stepIntervalMs)}.` : ""),
      ]);
    }

    function stopConfirm(run) {
      if (!st.confirmStop) return null;
      return el("div", { class: "sim-confirm", role: "group", "aria-labelledby": "sim-stop-title" }, [
        el("h3", { class: "sim-confirm__title", id: "sim-stop-title", tabindex: "-1", "data-stop-title": "" }, "Stop this simulation?"),
        el("p", { class: "sim__text" }, `The run ends at step ${run.step} of ${run.totalSteps}. Readings already generated stay stored and labelled Simulated. A stopped run can't be resumed.`),
        el("div", { class: "sim-controls__row" }, [
          button("sim-stop-confirm", "stop-confirm", "btn--danger", "square", "Stop simulation", () => control("stop")),
          button("sim-stop-cancel", "stop-cancel", "btn--secondary", "x", "Keep the run", () => { st.confirmStop = false; draw(); for (const n of content.querySelectorAll("[id]")) if (n.getAttribute("id") === "sim-stop") n.focus(); }),
        ]),
      ]);
    }

    function startSection(d) {
      const f = st.form;
      const crew = d.crew;
      if (crew.status === "error") return section("sim-start-title", "New simulation run", [sectionError(() => load(), "the crew list")]);
      if (!crew.items.length) return section("sim-start-title", "New simulation run", [el("p", { class: "sim__empty" }, "No crew profiles are stored on this device.")]);

      const onField = (key, value) => {
        st.form = { ...st.form, [key]: value, confirm: false };
        st.message = null;
        if (key !== "speed" && st.form.crewId && st.form.scenarioId) {
          requestPreview(); // draws "Loading preview…", then the preview
          return;
        }
        if (key !== "speed") {
          st.previewGen += 1; // drop any late preview
          st.preview = null;
        }
        draw();
      };

      const crewSelect = el("select", { id: "sim-crew", name: "crew", onChange: (e) => onField("crewId", e.target.value) }, [
        el("option", { value: "", selected: !f.crewId }, "Choose a crew member"),
        ...crew.items.map((c) => el("option", { value: c.crewId, selected: f.crewId === c.crewId }, `${c.name} · ${c.crewId}`)),
      ]);
      const scenarioSet = el("fieldset", { class: "sim-scenarios" }, [
        el("legend", { class: "sim-scenarios__legend" }, "Scenario"),
        ...d.scenarios.map((s) =>
          el("label", { class: "sim-scenario", for: `sim-scenario-${s.id}` }, [
            el("input", { type: "radio", name: "scenario", id: `sim-scenario-${s.id}`, value: s.id, checked: f.scenarioId === s.id, onChange: (e) => onField("scenarioId", e.target.value) }),
            el("span", { class: "sim-scenario__body" }, [
              el("strong", {}, s.name),
              el("span", { class: "sim__text" }, s.description),
              el("span", { class: "sim__note" }, `${s.metricLabel} (${s.unit}) · ${s.totalSteps} steps: ${s.phases.ramp} ramp, ${s.phases.hold} hold, ${s.phases.recovery} recovery`),
            ]),
          ])),
      ]);
      const chosen = d.scenarios.find((s) => s.id === f.scenarioId);
      const speedSelect = el("select", { id: "sim-speed", name: "speed", onChange: (e) => onField("speed", Number(e.target.value)) },
        d.speeds.map((sp) => el("option", { value: String(sp), selected: f.speed === sp }, chosen ? `${sp}× · ${durationText(chosen.durationsMs[sp])} in total` : `${sp}×`)));

      const preview = previewBlock();
      const crewName = st.preview && st.preview.status === "ready" ? st.preview.crew.name : "the selected crew member";
      const confirmBox = el("label", { class: "sim-check", for: "sim-confirm" }, [
        el("input", { type: "checkbox", id: "sim-confirm", checked: f.confirm, disabled: !(st.preview && st.preview.status === "ready"), onChange: (e) => { st.form = { ...st.form, confirm: e.target.checked === true }; draw(); } }),
        el("span", {}, `I understand this writes ${chosen ? chosen.totalSteps : 12} synthetic readings to ${crewName}'s stored record on this device. They are labelled Simulated and stay stored.`),
      ]);
      const reason = !f.crewId ? "Choose a crew member." : !f.scenarioId ? "Choose a scenario." : !(st.preview && st.preview.status === "ready") ? "Waiting for the preview." : !f.confirm ? "Tick the confirmation to start." : "Ready to start.";

      return section("sim-start-title", "New simulation run", [
        el("p", { class: "sim__note" }, "Only one run can be active at a time across the crew. The speed can't be changed after starting."),
        el("div", { class: "sim-form__grid" }, [
          el("div", { class: "field" }, [el("label", { class: "field__label", for: "sim-crew" }, "Crew member"), el("div", { class: "field__control" }, crewSelect)]),
          el("div", { class: "field" }, [el("label", { class: "field__label", for: "sim-speed" }, "Speed"), el("div", { class: "field__control" }, speedSelect)]),
        ]),
        scenarioSet,
        preview,
        confirmBox,
        el("div", { class: "sim-controls__row" }, [
          button("sim-start", "start", "btn--primary", "play", "Start simulation", () => start(), !canStart(), "sim-start-help"),
        ]),
        el("p", { class: "sim__note", id: "sim-start-help" }, reason),
      ]);
    }

    function previewBlock() {
      const p = st.preview;
      if (!p) return el("p", { class: "sim__empty" }, "Choose a crew member and a scenario to preview the exact readings.");
      if (p.status === "loading") return el("p", { class: "sim__empty", role: "status" }, "Loading preview…");
      if (p.status !== "ready") return el("p", { class: "sim__empty" }, [icon("circle-alert"), ` Preview unavailable: ${messageFor(p)}`]);
      const s = p.scenario;
      return el("div", { class: "sim-preview", "aria-labelledby": "sim-preview-title", role: "group" }, [
        el("h3", { class: "sim-preview__title", id: "sim-preview-title" }, `Preview · ${p.crew.name} · ${p.crew.crewId}`),
        el("p", { class: "sim__text" },
          `Starts at ${unitText(p.startValue, s.unit)} (${p.startSource === "baseline" ? "the stored personal baseline" : "the catalog default, because no usable baseline is stored"}), ` +
            `moves to ${unitText(s.target, s.unit)}, and returns to ${unitText(p.startValue, s.unit)}. Values are identical every time.`),
        stepsTable("sim-preview-table", `${s.metricLabel} preview, ${s.totalSteps} synthetic steps, in ${s.unit}`, p.steps.map((x) => [String(x.step), x.phase, unitText(x.value, s.unit)]), ["Step", "Phase", "Value"]),
      ]);
    }

    function stepsTable(id, caption, rows, headings) {
      return el("div", { class: "table-wrap sim-table-wrap", role: "region", tabindex: "0", "aria-labelledby": `${id}-caption` }, [
        el("table", { class: "table sim-table", id }, [
          el("caption", { class: "sr-only", id: `${id}-caption` }, caption),
          el("thead", {}, el("tr", {}, headings.map((h) => el("th", { scope: "col" }, h)))),
          el("tbody", {}, rows.map(([first, ...rest]) => el("tr", {}, [el("th", { scope: "row" }, first), ...rest.map((c, i) => el("td", { "data-label": headings[i + 1] }, c))]))),
        ]),
      ]);
    }

    function readingsSection(run) {
      const r = run.readings;
      if (r.status === "error") return section("sim-readings-title", "Generated readings", [sectionError(() => load(), "the generated readings")]);
      const items = r.items;
      const values = [...items.map((x) => x.value), run.startValue ?? 0];
      const lo = Math.min(...values);
      const hi = Math.max(...values);
      const pct = (v) => (hi === lo ? 60 : 15 + ((v - lo) / (hi - lo)) * 85).toFixed(1);
      return section("sim-readings-title", "Generated readings", [
        el("p", { class: "sim__note" }, ["Every value here is synthetic and stored with source “simulation”. Times are UTC. ", el("span", { class: "sim-tag" }, [icon("flask-conical", { size: 12 }), "Simulated", srOnly(" (Simulation Center)")])]),
        items.length
          ? [
              el("div", { class: "sim-bars", "aria-hidden": "true" }, items.map((x) => el("span", { class: "sim-bars__bar", style: { "--h": `${pct(x.value)}%` } }))),
              stepsTable("sim-readings-table", `${run.metricLabel} readings generated by this run, in ${run.unit}`, [...items].reverse().map((x) => [String(x.step), unitText(x.value, x.unit), utcTime(x.timestamp)]), ["Step", "Value", "Time (UTC)"]),
            ]
          : el("p", { class: "sim__empty" }, "No readings generated yet."),
        run.crewId
          ? el("p", { class: "sim__links" }, [
              el("a", { class: "btn btn--secondary btn--sm", href: `#/physical/${run.crewId}` }, [icon("heart"), `Physical Health · ${run.crewId}`]),
              el("a", { class: "btn btn--secondary btn--sm", href: `#/crew/${run.crewId}` }, [icon("users"), `Crew Monitor detail · ${run.crewId}`]),
            ])
          : null,
        el("p", { class: "sim__note" }, "The readings appear in the Overview, Physical Health (latest readings and today's daily summary) and the Crew Monitor, labelled Simulated."),
      ]);
    }

    function timelineSection(run) {
      const t = run.timeline;
      if (t.status === "error") return section("sim-timeline-title", "Run timeline", [sectionError(() => load(), "the run timeline")]);
      return section("sim-timeline-title", "Run timeline", [
        t.items.length
          ? el("ol", { class: "sim-timeline", role: "list" }, t.items.map((e) =>
              el("li", { class: "sim-timeline__item" }, [el("strong", {}, e.kind), el("span", { class: "sim__text" }, e.summary), el("span", { class: "sim__note" }, utcTime(e.timestamp))])))
          : el("p", { class: "sim__empty" }, "No events recorded for this run."),
        el("p", { class: "sim__note" }, "Newest first. Only this run's simulation events are listed."),
      ]);
    }

    function recentSection(d) {
      const r = d.recent;
      if (r.status === "error") return section("sim-recent-title", "Recent runs", [sectionError(() => load(), "recent runs")]);
      return section("sim-recent-title", "Recent runs", [
        r.status === "partial" ? el("p", { class: "sim__note" }, [icon("circle-alert"), " Some runs couldn't be loaded."]) : null,
        r.items.length
          ? el("ul", { class: "sim-recent", role: "list" }, r.items.map((x) =>
              el("li", { class: "sim-recent__item" }, [
                statusBadge(STATUS_VIEW[x.status] ? x.status : "stopped"),
                el("span", { class: "sim__text" }, `${x.name} · ${x.crewId} · ${x.scenarioName} · step ${x.step} of ${x.totalSteps} · ${x.speed}×`),
                el("span", { class: "sim__note" }, ["Started ", utcTime(x.startedAt)]),
              ])))
          : el("p", { class: "sim__empty" }, "No simulation runs yet."),
      ]);
    }

    /** The last step's risk evaluation, shown honestly (never a success when it failed). */
    function riskBox() {
      const r = st.risk;
      if (!r || r.status === "not_configured") return null;
      if (r.status !== "evaluated") {
        return el("p", { class: "sim__text sim__iconline sim-risk sim-risk--error", role: "note" }, [icon("circle-alert"), el("span", {}, `Risk evaluation unavailable after step ${r.step}. The reading was saved; the next step or “Evaluate crew now” on the Alerts page checks the stored data again.`)]);
      }
      const CHANGE = { opened: "opened", escalated: "escalated", updated: "updated with new evidence", condition_cleared: "condition cleared" };
      return el("div", { class: "sim-risk" }, [
        el("p", { class: "sim__text sim__iconline" }, [icon("bell"), el("span", {}, r.changes.length ? `Risk evaluation after step ${r.step}:` : `Risk evaluation after step ${r.step}: no alert changed.`)]),
        r.changes.length
          ? el("ul", { class: "sim-risk__list", role: "list" }, r.changes.map((c) => el("li", {}, [el("a", { href: `#/alerts/${c.alertNumber}` }, `${c.alertNumber} ${c.title}`), ` · ${c.severity} · ${CHANGE[c.change] || c.change}`])))
          : null,
        el("p", { class: "sim__note" }, "Demonstration threshold — not clinically validated."),
      ]);
    }

    function notesSection(d) {
      return section("sim-notes-title", "Risk evaluation and limits", [
        el("p", { class: "sim__text sim__iconline" }, [icon("info"), el("span", {}, d.notes.risk)]),
        el("p", { class: "sim__text" }, ["Review, acknowledge and resolve alerts on the ", el("a", { href: "#/alerts" }, "Alerts page"), ". The Simulation Center never acknowledges or resolves alerts."]),
        el("p", { class: "sim__text sim__iconline" }, [icon("clock"), el("span", {}, d.notes.openPage)]),
      ]);
    }

    drawTabs();
    return load();
  };
}

export const renderSimulationCenter = createSimulationCenterRenderer({
  service: Object.freeze({
    getSimulationCenter: (session) => getSimulationCenter(session),
    previewSimulation: (session, input) => previewSimulation(session, input),
    startSimulation: (session, input) => startSimulation(session, input),
    advanceSimulation: (session, runRef, input) => advanceSimulation(session, runRef, input),
    pauseSimulation: (session, runRef) => pauseSimulation(session, runRef),
    resumeSimulation: (session, runRef) => resumeSimulation(session, runRef),
    stopSimulation: (session, runRef, input) => stopSimulation(session, runRef, input),
    recordManualReading: (session, input) => recordManualReading(session, input),
    startCustomCurve: (session, input) => startCustomCurve(session, input),
  }),
  live: Object.freeze({ getLiveControl: (session, input) => getLiveControl(session, input) }),
  reset: Object.freeze({ resetDemoData: (session, input) => resetDemoData(session, input) }),
});
