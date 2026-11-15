// js/pages/exercise.js — #/exercise, the Daily Exercise Countermeasure.
//
//   Astronaut          → today's notification, readiness check, today's plan
//                        (aerobic + resistance + mobility), the session log
//                        form, today's sessions and the last 14 days.
//   Medical Officer    → #/exercise: crew adherence table (read-only);
//                        #/exercise/AH-0n: one member's page without the form.
//
// Presentation only: every rule (readiness, plan, EX-01) lives in
// js/services/exercise-service.js and js/engine/rules/exercise-rules.js.
// No js/db imports; all text via el(). Non-clinical demonstration.
//
// Test seam: createExerciseRenderer({ loadOwn, loadCrew, loadMember, logSession, subscribe, publish }).

import { getOwnExercise, getCrewExercise, getCrewMemberExercise, logExerciseSession } from "../services/exercise-service.js";
import { icon } from "../components/icon.js";
import { el } from "../core/utils/dom.js";
import { formatDateTime, formatNumber } from "../core/utils/format.js";
import { badge, loadingView, section } from "../components/crew-view.js";
import { astronautNestedNotFound, parseHealthRoute, refusalView, shortDate } from "../components/health-view.js";
import { onHealthChanged, keepFocus, HEALTH_EVENT } from "../core/live-updates.js";
import { bus } from "../core/event-bus.js";

const BASE = "exercise";
const STATUS = Object.freeze({
  ok: ["badge--ok", "circle-check", "Usual range"],
  caution: ["badge--warning", "triangle-alert", "Caution"],
  hold: ["badge--critical", "circle-alert", "Hold"],
  unknown: ["badge--neutral", "clock", "No recent data"],
});
const LEVEL = Object.freeze({
  standard: ["badge--ok", "circle-check", "Standard plan"],
  reduced: ["badge--warning", "triangle-alert", "Reduced plan"],
  recovery: ["badge--critical", "circle-alert", "Recovery day"],
});
const SEV = Object.freeze({ critical: ["badge--critical", "circle-alert", "Critical"], warning: ["badge--warning", "triangle-alert", "Warning"], info: ["badge--info", "info", "Info"] });
const TYPE_LABEL = Object.freeze({ aerobic: "Aerobic", resistance: "Resistance", mobility: "Mobility / recovery" });
const COMPLETION_LABEL = Object.freeze({ completed: "Completed", partial: "Partial", skipped: "Skipped" });
const SYMPTOM_LABEL = Object.freeze({ dizziness: "Dizziness", pain: "Pain", shortness_of_breath: "Shortness of breath", nausea: "Nausea" });
const utc = (t) => `${formatDateTime(t, { timeZone: "UTC" })} UTC`;
const b = (triple) => badge(triple[0], triple[1], triple[2]);

function header(data, officer) {
  return el("section", { class: "health__header", "aria-labelledby": "ex-title" }, [
    el("h2", { class: "health__title", id: "ex-title", tabindex: "-1" }, officer ? `Daily exercise · ${data.profile.name} (${data.profile.crewId})` : "Daily Exercise Countermeasure"),
    el("p", { class: "health__note" }, "Aerobic and resistance exercise is the main countermeasure for the bone, muscle and heart changes of weightlessness. " + data.note),
  ]);
}

function notificationCard(data) {
  const r = data.reminder;
  return el("section", { class: ["card", "ex-notice", r.due ? "ex-notice--due" : "ex-notice--done"], "aria-labelledby": "ex-notice-title", "data-exercise-notice": r.due ? "due" : "done" }, [
    el("div", { class: "ex-notice__head" }, [
      el("span", { class: "ex-notice__icon", "aria-hidden": "true" }, icon(r.due ? "bell" : "circle-check")),
      el("h3", { class: "ex-notice__title", id: "ex-notice-title" }, r.due ? "Today's exercise notification" : "Today's exercise is done"),
      b(LEVEL[data.plan.level]),
    ]),
    el("p", { class: "health__text" }, r.text),
    data.today.targetMin > 0
      ? el("div", { class: "ex-progress" }, [
          el("progress", { class: "ex-progress__bar", max: String(data.today.targetMin), value: String(Math.min(data.today.minutes, data.today.targetMin)), "aria-label": `${data.today.minutes} of ${data.today.targetMin} minutes` }),
          el("span", { class: "health__note" }, `${data.today.minutes} / ${data.today.targetMin} min · 7-day average ${data.sevenDayAverage} min/day · KPI target about 120 min/day`),
        ])
      : null,
    data.exerciseAlert
      ? el("p", { class: "health__text ex-notice__alert" }, [b(SEV[data.exerciseAlert.severity] || SEV.info), ` ${data.exerciseAlert.number} Missed exercise countermeasure — `, el("a", { href: `#/alerts/${data.exerciseAlert.number}` }, "open the alert")])
      : null,
  ]);
}

function readinessSection(data) {
  return section("ex-ready-title", "Readiness check", [
    el("p", { class: "health__note" }, "From the latest stored readings and the demonstration thresholds. It sets today's plan; it is not a fitness-for-duty decision."),
    el("ul", { class: "ex-ready", role: "list" }, data.readiness.items.map((i) => el("li", { class: ["ex-ready__item", `ex-ready__item--${i.status}`] }, [
      el("span", { class: "ex-ready__label" }, i.label),
      el("strong", { class: "ex-ready__value" }, i.value === null || i.value === undefined ? "—" : `${formatNumber(i.value, Number.isInteger(i.value) ? 0 : 1)}${i.unit ? `${i.unit.startsWith("/") ? "" : " "}${i.unit}` : ""}`),
      b(STATUS[i.status] || STATUS.unknown),
    ]))),
  ]);
}

function planSection(data) {
  return section("ex-plan-title", "Today's plan", [
    el("p", { class: "health__text" }, [b(LEVEL[data.plan.level]), " ", data.plan.headline]),
    el("ul", { class: "ex-plan", role: "list" }, data.plan.sessions.map((s) => el("li", { class: ["ex-plan__item", `ex-plan__item--${s.type}`] }, [
      el("p", { class: "ex-plan__name" }, [el("strong", {}, TYPE_LABEL[s.type]), ` · ${s.plannedMin} min · ${s.intensity}`]),
      el("p", { class: "health__note" }, `Device: ${s.device}`),
      el("p", { class: "health__note" }, s.reason),
    ]))),
    el("p", { class: "health__note" }, "Demonstration plan — follow the approved crew exercise protocol. The plan never changes the mission schedule."),
  ]);
}

function sessionsList(items) {
  if (!items.length) return el("p", { class: "health__empty" }, "No session logged today yet.");
  return el("ul", { class: "ex-sessions", role: "list" }, items.map((s) => el("li", { class: "ex-sessions__item" }, [
    el("p", {}, [el("strong", {}, `${s.label} · ${s.completion === "skipped" ? "skipped" : `${s.minutes} min`}`), ` · ${COMPLETION_LABEL[s.completion] || ""}${s.intensity ? ` · ${s.intensity}` : ""}${s.device ? ` · ${s.device}` : ""}`]),
    el("p", { class: "health__note" }, [
      utc(s.timestamp),
      s.rpe !== null ? ` · effort ${s.rpe}/10` : "",
      s.peakHeartRate !== null ? ` · peak HR ${s.peakHeartRate} bpm` : "",
      s.recoveryHeartRate !== null ? ` · recovery HR ${s.recoveryHeartRate} bpm` : "",
      s.postFatigue !== null ? ` · fatigue after ${s.postFatigue}/10` : "",
      s.stopReason ? ` · reason: ${s.stopReason}` : "",
      s.symptoms.length ? ` · reported: ${s.symptoms.map((x) => SYMPTOM_LABEL[x] || x).join(", ")}` : "",
      s.source === "seed" ? " · synthetic history" : "",
    ]),
  ])));
}

function historySection(data) {
  const max = Math.max(120, ...data.history.map((d) => d.minutes));
  return section("ex-history-title", "Last 14 days", [
    el("p", { class: "health__note" }, `Aerobic + resistance minutes per UTC day. A day under 30 min counts as missed (rule EX-01). Target about 120 min/day.`),
    el("ol", { class: "ex-history", role: "list" }, data.history.map((d) => el("li", { class: ["ex-history__day", d.missed ? "is-missed" : "", d.today ? "is-today" : ""] }, [
      el("span", { class: "ex-history__bar", "aria-hidden": "true", style: { "--h": `${Math.round((d.minutes / max) * 100)}%` } }),
      el("span", { class: "ex-history__value" }, `${d.minutes} min`),
      el("span", { class: "ex-history__date" }, `${shortDate(d.date)}${d.today ? " · today" : ""}${d.missed ? " · missed" : ""}`),
    ]))),
  ]);
}

/** The session log form (astronaut only). */
function logForm(data, onSubmit) {
  const o = data.options;
  const radio = (name, values, labels) => el("div", { class: "ex-form__choices", role: "radiogroup" }, values.map((v) => el("label", { class: "ex-form__choice", for: `ex-${name}-${v}` }, [
    el("input", { type: "radio", name: `ex-${name}`, id: `ex-${name}-${v}`, value: v }), el("span", {}, labels ? labels[v] || v : v),
  ])));
  const field = (id, label, control, hint) => el("div", { class: "field ex-form__field" }, [
    el("label", { class: "field__label", for: id }, label), el("div", { class: "field__control" }, control), hint ? el("p", { class: "field__hint" }, hint) : null,
    el("p", { class: "field__error", id: `${id}-error`, hidden: true }),
  ]);
  const num = (id, min, max, placeholder = "") => el("input", { type: "number", id, min: String(min), max: String(max), step: "1", inputmode: "numeric", placeholder });
  const device = el("select", { id: "ex-device" }, [el("option", { value: "" }, "Choose the type first…")]);
  const reason = el("select", { id: "ex-reason" }, [el("option", { value: "" }, "Only if partial or skipped…"), ...o.stopReasons.map((r) => el("option", { value: r }, r))]);
  const form = el("form", { class: "ex-form", novalidate: true }, [
    el("fieldset", { class: "health-question" }, [el("legend", { class: "health-question__legend" }, "Session type"), radio("type", o.types, TYPE_LABEL), el("p", { class: "field__error", id: "ex-type-error", hidden: true })]),
    field("ex-device", "Device", device),
    el("fieldset", { class: "health-question" }, [el("legend", { class: "health-question__legend" }, "Completion"), radio("completion", o.completions, COMPLETION_LABEL), el("p", { class: "field__error", id: "ex-completion-error", hidden: true })]),
    el("div", { class: "ex-form__row" }, [
      field("ex-minutes", "Minutes done", num("ex-minutes", 1, 240, "e.g. 45")),
      field("ex-planned", "Planned minutes (optional)", num("ex-planned", 0, 240)),
      field("ex-rpe", "Effort 1–10 (optional)", num("ex-rpe", 1, 10)),
    ]),
    el("fieldset", { class: "health-question" }, [el("legend", { class: "health-question__legend" }, "Intensity"), radio("intensity", o.intensities), el("p", { class: "field__error", id: "ex-intensity-error", hidden: true })]),
    el("div", { class: "ex-form__row" }, [
      field("ex-peak", "Peak heart rate, bpm (optional)", num("ex-peak", 40, 220)),
      field("ex-recovery", "Heart rate 2 min after, bpm (optional)", num("ex-recovery", 40, 220)),
      field("ex-fatigue", "Fatigue after 0–10 (optional)", num("ex-fatigue", 0, 10)),
    ]),
    field("ex-reason", "Reason (if partial or skipped)", reason),
    el("fieldset", { class: "health-question" }, [el("legend", { class: "health-question__legend" }, "Anything noticed? (synthetic demo, optional)"),
      el("div", { class: "ex-form__choices" }, o.symptoms.map((s) => el("label", { class: "ex-form__choice", for: `ex-sym-${s}` }, [el("input", { type: "checkbox", id: `ex-sym-${s}`, value: s, "data-symptom": "" }), el("span", {}, SYMPTOM_LABEL[s] || s)])))]),
    el("p", {}, el("button", { class: "btn btn--primary", type: "submit", id: "ex-save" }, [icon("check"), "Log session"])),
  ]);
  for (const r of form.querySelectorAll ? form.querySelectorAll("[name]") : []) {
    if (r.getAttribute("name") === "ex-type") r.addEventListener("change", () => {
      device.replaceChildren(...(o.devices[r.value] || []).map((d) => el("option", { value: d }, d)));
    });
  }
  form.addEventListener("submit", (e) => { e.preventDefault(); onSubmit(form); });
  return form;
}

function readForm(form) {
  const pick = (name) => { const r = [...form.querySelectorAll("[name]")].find((x) => x.getAttribute("name") === name && x.checked); return r ? r.value : undefined; };
  const byId = (id) => [...form.querySelectorAll("[id]")].find((x) => x.getAttribute("id") === id);
  const n = (id) => { const v = byId(id)?.value; return v === "" || v === undefined ? undefined : Number(v); };
  return {
    sessionType: pick("ex-type"), completion: pick("ex-completion"), intensity: pick("ex-intensity"),
    device: byId("ex-device")?.value || undefined, minutes: n("ex-minutes"), plannedMin: n("ex-planned"), rpe: n("ex-rpe"),
    peakHeartRate: n("ex-peak"), recoveryHeartRate: n("ex-recovery"), postFatigue: n("ex-fatigue"),
    stopReason: byId("ex-reason")?.value || "",
    symptoms: [...form.querySelectorAll("[data-symptom]")].filter((x) => x.checked).map((x) => x.value),
  };
}

function crewTable(data) {
  return section("ex-crew-title", "Crew exercise today", [
    el("p", { class: "health__note" }, `${data.note} Read-only.`),
    el("div", { class: "table-wrap" }, el("table", { class: "table" }, [
      el("thead", {}, el("tr", {}, ["Crew member", "Plan", "Today", "7-day avg", "Missed days (14)", "Alert", ""].map((h) => el("th", { scope: "col" }, h)))),
      el("tbody", {}, data.crew.map((c) => el("tr", {}, c.status !== "ok"
        ? [el("td", {}, `${c.name} · ${c.crewId}`), el("td", { colspan: "6" }, "Couldn't be loaded.")]
        : [
            el("td", { "data-label": "Crew member" }, `${c.name} · ${c.crewId}`),
            el("td", { "data-label": "Plan" }, b(LEVEL[c.level])),
            el("td", { "data-label": "Today" }, [`${c.minutesToday} / ${c.targetMin} min `, c.done ? b(["badge--ok", "circle-check", "Done"]) : b(["badge--neutral", "clock", "Not yet"])]),
            el("td", { "data-label": "7-day avg" }, `${c.sevenDayAverage} min`),
            el("td", { "data-label": "Missed days (14)" }, String(c.missedDays)),
            el("td", { "data-label": "Alert" }, c.exerciseAlert ? el("a", { href: `#/alerts/${c.exerciseAlert.number}` }, [b(SEV[c.exerciseAlert.severity] || SEV.info), ` ${c.exerciseAlert.number}`]) : "—"),
            el("td", {}, el("a", { class: "btn btn--secondary btn--sm", href: `#/exercise/${c.crewId}` }, [icon("arrow-right"), "Details"])),
          ]))),
    ])),
  ]);
}

export function createExerciseRenderer({ loadOwn, loadCrew, loadMember, logSession, subscribe = onHealthChanged, publish = (n, d) => bus.emit(n, d) }) {
  return function render(container, session, { signal, hash = `#/${BASE}`, focus = false } = {}) {
    const route = parseHealthRoute(hash, BASE);
    const officer = Boolean(session && session.role === "medical_officer");
    const live = el("p", { class: "sr-only", role: "status", "aria-live": "polite" });
    const content = el("div", { class: "health__content" });
    const root = el("div", { class: "health ex", "aria-busy": "false" }, [live, content]);
    container.replaceChildren(root);
    if (!officer && route.view !== "base") { content.replaceChildren(astronautNestedNotFound(BASE)); return Promise.resolve(); }
    if (route.view === "invalid") { content.replaceChildren(refusalView({ status: "not_found", reason: "invalid_crew_id" }, null, BASE)); return Promise.resolve(); }
    const aborted = () => Boolean(signal && signal.aborted);
    let generation = 0;
    let shownCrewId = null;
    let busy = false;
    let saveMessage = null;
    subscribe({ signal, crewId: () => (officer ? (route.view === "base" ? "" : route.crewId) : shownCrewId), reload: () => { if (!busy) return keepFocus(root, () => load({ quiet: true })); } });

    async function save(form) {
      if (busy) return;
      busy = true;
      const btn = [...form.querySelectorAll("[id]")].find((x) => x.getAttribute("id") === "ex-save");
      if (btn) btn.disabled = true;
      for (const e of form.querySelectorAll("[id]")) if (/-error$/.test(e.getAttribute("id"))) { e.hidden = true; e.textContent = ""; }
      let res;
      try {
        res = await logSession(session, readForm(form));
      } catch {
        res = { status: "unavailable" };
      }
      busy = false;
      if (btn) btn.disabled = false;
      if (aborted()) return;
      if (res && res.status === "invalid" && res.errors) {
        const map = { sessionType: "ex-type", device: "ex-device", completion: "ex-completion", intensity: "ex-intensity", minutes: "ex-minutes", plannedMin: "ex-planned", rpe: "ex-rpe", peakHeartRate: "ex-peak", recoveryHeartRate: "ex-recovery", postFatigue: "ex-fatigue", stopReason: "ex-reason" };
        for (const [f, msg] of Object.entries(res.errors)) {
          const e = [...form.querySelectorAll("[id]")].find((x) => x.getAttribute("id") === `${map[f]}-error`);
          if (e) { e.textContent = msg; e.hidden = false; }
        }
        live.textContent = "The session wasn't logged. Please check the highlighted answers.";
        return;
      }
      if (!res || res.status !== "saved") {
        saveMessage = { tone: "error", text: res && res.status === "busy" ? "A save is already in progress." : "The session couldn't be logged. Nothing was saved." };
        live.textContent = saveMessage.text;
        await load({ quiet: true });
        return;
      }
      const a = res.alert && res.alert.change && res.alert.change !== "none" ? res.alert : null;
      saveMessage = { tone: "ok", text: `Session logged: ${TYPE_LABEL[res.session.sessionType]} · ${res.session.completion === "skipped" ? "skipped" : `${res.session.minutes} min`}.${a ? ` Exercise alert ${a.number} ${a.change === "condition_cleared" ? "is marked condition cleared" : a.change} (${a.severity}).` : ""}` };
      live.textContent = saveMessage.text;
      try {
        publish(HEALTH_EVENT, { crewId: res.crewId, metric: "exercise", alertsChanged: Boolean(a) });
        if (a) publish("alert:changed", {});
      } catch { /* the session is saved either way */ }
      await load({ quiet: true });
    }

    async function load({ quiet = false } = {}) {
      const token = ++generation;
      if (!quiet) { root.setAttribute("aria-busy", "true"); content.replaceChildren(...loadingView("Loading the exercise countermeasure…")); }
      let res;
      try {
        res = officer ? (route.view === "base" ? await loadCrew(session) : await loadMember(session, route.crewId)) : await loadOwn(session);
      } catch {
        res = { status: "unavailable", reason: "unexpected_error" };
      }
      if (token !== generation || aborted()) return;
      root.setAttribute("aria-busy", "false");
      if (!res || res.status !== "ready") {
        if (quiet) return;
        content.replaceChildren(refusalView(res, () => load(), BASE));
        return;
      }
      if (officer && route.view === "base") {
        content.replaceChildren(
          el("section", { class: "health__header", "aria-labelledby": "ex-title" }, [el("h2", { class: "health__title", id: "ex-title", tabindex: "-1" }, "Daily Exercise Countermeasure · crew")]),
          crewTable(res),
        );
      } else {
        shownCrewId = res.profile.crewId;
        content.replaceChildren(...[
          header(res, officer),
          notificationCard(res),
          saveMessage ? el("p", { class: ["health-status", `health-status--${saveMessage.tone}`], role: saveMessage.tone === "error" ? "alert" : "status", "data-ex-message": "" }, [icon(saveMessage.tone === "error" ? "circle-alert" : "circle-check"), ` ${saveMessage.text}`]) : null,
          el("div", { class: "ex-grid" }, [readinessSection(res), planSection(res)]),
          !officer && res.options ? section("ex-log-title", "Log a session", [el("p", { class: "health__note" }, "Log each session when it ends. A partial or skipped session needs a reason from the list. All values are synthetic demonstration data."), logForm(res, save)]) : null,
          section("ex-today-title", "Today's sessions", [sessionsList(res.today.sessions)]),
          historySection(res),
          officer ? el("p", {}, el("a", { class: "btn btn--secondary btn--sm", href: "#/exercise" }, [icon("arrow-right"), "Back to crew exercise"])) : null,
        ].filter(Boolean));
      }
      if (focus && !quiet) root.querySelectorAll("[tabindex]")[0]?.focus?.();
    }
    return load();
  };
}

export const renderExercise = createExerciseRenderer({
  loadOwn: (s) => getOwnExercise(s),
  loadCrew: (s) => getCrewExercise(s),
  loadMember: (s, crewId) => getCrewMemberExercise(s, crewId),
  logSession: (s, input) => logExerciseSession(s, input),
});
