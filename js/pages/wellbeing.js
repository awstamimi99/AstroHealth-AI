// js/pages/wellbeing.js — #/wellbeing (Sprint 6)
//
//   Astronaut        #/wellbeing          check-in form + own 30-day history
//                    #/wellbeing/<any>    safe "not found" (no officer service call)
//   Medical Officer  #/wellbeing          crew picker (names + crew IDs only)
//                    #/wellbeing/AH-04    that astronaut's SHARED check-ins only
//                    other #/wellbeing/…  safe "not found"
//
// The form: six native radio groups (fieldset + legend + scale text) and a
// required sharing choice with no default. Sharing asks for a separate
// confirmation; a second check-in on the same UTC day asks for another. The
// service is the authority for both (it answers "confirm_share" /
// "confirm_same_day"); the page shows the matching panel and re-submits
// with that confirmation for THIS attempt only. While saving, the form is
// busy and every submit/confirm button is disabled. Answers are kept after
// errors; the form is cleared only after a successful save.
//
// Presentation only; no js/db imports; text inserted via el().

import { getOwnWellbeing, createCheckin, getCrewMemberSharedWellbeing, listCrewForWellbeingSelection, SCORE_FIELDS } from "../services/wellbeing-service.js";
import { icon } from "../components/icon.js";
import { el } from "../core/utils/dom.js";
import { formatTime } from "../core/utils/format.js";
import { alertItem, loadingView, section, sectionError, stamp, syntheticNotice, utcTime, badge } from "../components/crew-view.js";
import { astronautNestedNotFound, crewPicker, parseHealthRoute, refusalView, sharingBadge } from "../components/health-view.js";
import { createContextBodyScan } from "../components/context-body-scan.js";

const BASE = "wellbeing";
export const QUESTIONS = Object.freeze([
  { field: "mood", label: "Mood", min: 1, max: 5, scale: "1 = very low, 5 = very good" },
  { field: "stress", label: "Stress", min: 0, max: 10, scale: "0 = none, 10 = extreme" },
  { field: "sleepQuality", label: "Sleep quality", min: 1, max: 5, scale: "1 = very poor, 5 = very good" },
  { field: "fatigue", label: "Fatigue", min: 0, max: 10, scale: "0 = none, 10 = exhausted" },
  { field: "isolation", label: "Feeling isolated", min: 0, max: 10, scale: "0 = not at all, 10 = completely" },
  { field: "wellbeing", label: "Overall wellbeing", min: 1, max: 5, scale: "1 = very low, 5 = very good" },
]);
const MAX_OF = Object.fromEntries(QUESTIONS.map((q) => [q.field, q.max]));
const LABEL_OF = Object.fromEntries(QUESTIONS.map((q) => [q.field, q.label]));

// ---- History / summary (shared by both roles) ------------------------------------------

function scoresList(c) {
  return el("dl", { class: "health-scores" },
    SCORE_FIELDS.flatMap((f) => [el("dt", {}, LABEL_OF[f]), el("dd", {}, c[f] === null ? "—" : `${c[f]} / ${MAX_OF[f]}`)]));
}

function historySection(data, onRetry, { officer }) {
  const c = data.checkins;
  let body;
  if (c.status === "error") body = [sectionError(onRetry, "check-ins")];
  else if (!c.items.length) body = [el("p", { class: "health__empty" }, officer ? "No shared check-ins in the last 30 days." : "No check-ins in the last 30 days.")];
  else {
    body = [
      el("ul", { class: "health-checkins", role: "list" },
        c.items.map((item) =>
          el("li", { class: "health-checkin" }, [
            el("p", { class: "health-checkin__date" }, utcTime(item.timestamp)),
            el("p", { class: "health__tags" }, [
              officer ? badge("badge--info", "eye", "Shared by the astronaut") : sharingBadge(item.shared),
              item.simulated ? el("span", { class: "sim-tag" }, "Simulated") : badge("badge--neutral", "user", "Self-reported"),
            ]),
            scoresList(item),
          ]))),
    ];
  }
  return section("wellbeing-history-title", officer ? "Shared check-ins (last 30 days)" : "Your check-ins (last 30 days)", [
    officer ? el("p", { class: "health__note" }, "Private check-ins and the private journal are never shown or counted.") : null,
    ...body,
  ]);
}

function summarySection(data) {
  const s = data.summary;
  if (!s) return null;
  return section("wellbeing-summary-title", "Recent averages", [
    el("p", { class: "health__note" }, `${s.basedOn} Newest ${s.count} check-in${s.count === 1 ? "" : "s"}. Self-reported scores — not a diagnosis.`),
    s.count
      ? el("dl", { class: "health-scores health-scores--summary" },
          SCORE_FIELDS.flatMap((f) => [el("dt", {}, LABEL_OF[f]), el("dd", {}, s.averages[f] === null ? "—" : `${s.averages[f]} / ${MAX_OF[f]}`)]))
      : el("p", { class: "health__empty" }, "Nothing to summarize yet."),
  ]);
}

function wellbeingScan(data, officer) {
  const avg = data.summary && data.summary.averages ? data.summary.averages : {};
  const values = [
    ["Mood", "head", avg.mood, 5, "wellbeing-summary-title"],
    ["Stress", "chest", avg.stress, 10, "wellbeing-summary-title"],
    ["Sleep quality", "head", avg.sleepQuality, 5, "wellbeing-history-title"],
    ["Fatigue", "abdomen", avg.fatigue, 10, officer ? "wellbeing-history-title" : "checkin-title"],
  ];
  const pins = values.map(([label, zone, value, max, targetId], index) => ({
    number: index + 1, zone, severity: "info",
    tag: `${label} · ${value === null || value === undefined ? "No recent average" : `${value} / ${max}`}`,
    label: `Go to ${label.toLowerCase()} information`, targetId,
  }));
  return createContextBodyScan({
    id: "wellbeing-body-map-title",
    title: officer ? "Shared wellbeing map" : "Your wellbeing map",
    description: officer
      ? "A visual index of shared check-in averages only. Private check-ins and journal text are never included."
      : "A visual index of your recent self-reported check-ins. It supports reflection and does not provide a diagnosis.",
    pins, crop: "upper", compact: true, eyebrow: "Mind and body map",
  });
}

function extrasSection(data, onRetry) {
  return section("wellbeing-extras-title", "Cognitive check and alerts", [
    data.cognitive.status === "error"
      ? sectionError(onRetry, "cognitive checks")
      : el("p", { class: "health__text" }, data.cognitive.lastAt ? ["Cognitive check last completed ", ...stamp(data.cognitive.lastAt, data.generatedAt)] : "No cognitive check recorded."),
    data.alerts.status === "error"
      ? sectionError(onRetry, "wellbeing alerts")
      : data.alerts.items.length
        ? el("ul", { class: "health__alerts", role: "list" }, data.alerts.items.map((a) => alertItem(a)))
        : el("p", { class: "health__empty" }, "No open wellbeing alerts."),
    el("p", { class: "health__note" }, "Stored open alerts only. This is not a health assessment."),
  ]);
}

function header(data, officer) {
  const p = data.profile;
  return el("section", { class: "health__header", "aria-labelledby": "wellbeing-title" }, [
    el("h2", { class: "health__welcome", id: "wellbeing-title", tabindex: "-1" }, officer ? `${p.name} · ${p.crewId}` : "Your wellbeing"),
    el("p", { class: "health__subtitle" }, officer ? `${p.missionRole} · shared check-ins only · read-only` : `${p.name} · ${p.crewId}`),
    officer
      ? el("p", { class: "health__links" }, [
          el("a", { class: "btn btn--secondary btn--sm", href: `#/crew/${p.crewId}` }, [icon("users"), "Crew member detail"]),
          el("a", { class: "btn btn--secondary btn--sm", href: `#/physical/${p.crewId}` }, [icon("heart"), "Physical health"]),
          el("a", { class: "btn btn--secondary btn--sm", href: "#/wellbeing" }, [icon("arrow-right"), "Choose another crew member"]),
        ])
      : null,
    syntheticNotice(),
  ]);
}

// ---- Check-in form (astronaut) ------------------------------------------------------------

function buildForm({ onSubmit }) {
  const radios = {}; // field → [input…]
  const errorEls = {};
  const fieldsets = {};

  const questionFieldset = (q) => {
    const errId = `checkin-${q.field}-error`;
    const scaleId = `checkin-${q.field}-scale`;
    const inputs = [];
    for (let v = q.min; v <= q.max; v++) {
      const input = el("input", { type: "radio", name: q.field, value: String(v), id: `checkin-${q.field}-${v}` });
      inputs.push(input);
    }
    radios[q.field] = inputs;
    errorEls[q.field] = el("p", { class: "field__error health-error", id: errId, hidden: true });
    const fs = el("fieldset", { class: "health-question", "aria-describedby": scaleId }, [
      el("legend", { class: "health-question__legend" }, q.label),
      el("p", { class: "health__note", id: scaleId }, q.scale),
      el("div", { class: "health-scale" }, inputs.map((input) =>
        el("label", { class: "health-scale__option", for: input.getAttribute("id") }, [input, el("span", {}, input.getAttribute("value"))]))),
      errorEls[q.field],
    ]);
    fieldsets[q.field] = fs;
    return fs;
  };

  // Sharing: required, no default.
  const sharePrivate = el("input", { type: "radio", name: "share", value: "private", id: "checkin-share-private" });
  const shareShared = el("input", { type: "radio", name: "share", value: "shared", id: "checkin-share-shared" });
  radios.share = [sharePrivate, shareShared];
  errorEls.share = el("p", { class: "field__error health-error", id: "checkin-share-error", hidden: true });
  fieldsets.share = el("fieldset", { class: "health-question health-share" }, [
    el("legend", { class: "health-question__legend" }, "Who can see this check-in?"),
    el("label", { class: "health-share__option", for: "checkin-share-private" }, [sharePrivate, el("span", {}, [icon("eye-off"), " Only me (private)"])]),
    el("label", { class: "health-share__option", for: "checkin-share-shared" }, [shareShared, el("span", {}, [icon("eye"), " Share with the Medical Officer"])]),
    errorEls.share,
  ]);

  const summary = el("div", { class: "health-error-summary", role: "alert", tabindex: "-1", hidden: true });
  const submit = el("button", { class: "btn btn--primary", type: "submit", "data-submit": "" }, [icon("check"), "Save check-in"]);
  const form = el("form", { class: "health-form", novalidate: true, "aria-labelledby": "checkin-title" }, [
    summary,
    ...QUESTIONS.map(questionFieldset),
    fieldsets.share,
    el("p", { class: "health-form__actions" }, submit),
  ]);
  form.addEventListener("submit", (e) => { e.preventDefault(); onSubmit(); });

  return {
    form,
    submit,
    radios,
    /** Current answers: numbers for scores, true/false for share; missing = undefined. */
    read() {
      const answers = {};
      for (const q of QUESTIONS) {
        const chosen = radios[q.field].find((i) => i.checked);
        answers[q.field] = chosen ? Number(chosen.value) : undefined;
      }
      const shareChoice = radios.share.find((i) => i.checked);
      answers.share = shareChoice ? shareChoice.value === "shared" : undefined;
      return answers;
    },
    showErrors(errors) {
      const fields = Object.keys(errors);
      for (const [field, p] of Object.entries(errorEls)) {
        const message = errors[field];
        p.textContent = message || "";
        if (message) p.removeAttribute("hidden");
        else p.setAttribute("hidden", "");
        const fs = fieldsets[field];
        const described = [field === "share" ? null : `checkin-${field}-scale`, message ? `checkin-${field}-error` : null].filter(Boolean).join(" ");
        if (described) fs.setAttribute("aria-describedby", described);
        else fs.removeAttribute("aria-describedby");
        if (message) fs.setAttribute("aria-invalid", "true");
        else fs.removeAttribute("aria-invalid");
      }
      if (fields.length) {
        summary.replaceChildren(el("p", {}, `Please answer ${fields.length === 1 ? "1 question" : `${fields.length} questions`} before saving:`),
          el("ul", {}, fields.map((f) => el("li", {}, f === "share" ? "Who can see this check-in" : LABEL_OF[f]))));
        summary.removeAttribute("hidden");
        summary.focus();
      } else {
        summary.replaceChildren();
        summary.setAttribute("hidden", "");
      }
    },
    clear() {
      for (const list of Object.values(radios)) for (const i of list) i.checked = false;
      this.showErrors({});
    },
    setBusy(busy) {
      form.setAttribute("aria-busy", busy ? "true" : "false");
      submit.disabled = busy;
    },
  };
}

function checkinSection({ onSubmit }) {
  const formApi = buildForm({ onSubmit });
  const status = el("p", { class: "health-status", role: "status", tabindex: "-1" });
  const confirmBox = el("div", { class: "health-confirm", hidden: true, role: "group", "aria-labelledby": "checkin-confirm-title" });
  const today = el("p", { class: "health__note" });
  const node = section("checkin-title", "Daily check-in", [
    el("p", { class: "health__note" }, "Self-reported, for your own awareness. Every question is required. Saving a check-in does not create alerts in this version."),
    today,
    formApi.form,
    confirmBox,
    status,
  ]);
  return { node, formApi, status, confirmBox, today };
}

// ---- Renderer -------------------------------------------------------------------------------

/** TEST SEAM: tests pass fake loaders/savers. Production uses renderWellbeing. */
export function createWellbeingRenderer({ loadOwn, saveCheckin, loadShared, listCrew }) {
  return function render(container, session, { signal, hash = `#/${BASE}`, focus = false } = {}) {
    const route = parseHealthRoute(hash, BASE);
    const root = el("div", { class: "health", "aria-busy": "false" });
    container.replaceChildren(root);
    const officer = session && session.role === "medical_officer";
    const alive = () => !(signal && signal.aborted);

    if (!officer && route.view !== "base") {
      root.append(astronautNestedNotFound(BASE));
      return Promise.resolve();
    }
    if (officer && route.view === "invalid") {
      root.append(refusalView({ status: "not_found", reason: "invalid_crew_id" }, null, BASE));
      return Promise.resolve();
    }

    // ---- Medical Officer -------------------------------------------------------------
    if (officer) {
      let generation = 0;
      async function loadOfficer() {
        const token = ++generation;
        root.setAttribute("aria-busy", "true");
        if (!root.childNodes.length) root.replaceChildren(...loadingView("Loading shared wellbeing…"));
        let result;
        try {
          result = route.view === "base" ? await listCrew(session) : await loadShared(session, route.crewId);
        } catch {
          result = { status: "unavailable", reason: "unexpected_error" };
        }
        if (token !== generation || !alive()) return;
        const retry = () => loadOfficer();
        if (result && result.status === "ready" && route.view === "base") {
          root.replaceChildren(crewPicker(result.crew, BASE, { title: "Choose a crew member", intro: "Select a crew member to review the wellbeing check-ins they chose to share." }));
        } else if (result && result.status === "ready") {
          root.replaceChildren(header(result, true), wellbeingScan(result, true), summarySection(result), historySection(result, retry, { officer: true }), extrasSection(result, retry));
          if (focus) root.querySelectorAll("[tabindex]")[0]?.focus();
        } else {
          root.replaceChildren(refusalView(result, retry, BASE));
        }
        root.setAttribute("aria-busy", "false");
      }
      return loadOfficer();
    }

    // ---- Astronaut ---------------------------------------------------------------------
    let generation = 0;
    let busy = false;
    let attempt = { confirmShare: false, confirmSameDay: false }; // for THIS save attempt only
    const scanHost = el("div", { class: "health__scan" });
    const dataHost = el("div", { class: "health__data" });
    const checkin = checkinSection({ onSubmit: () => startSave() });
    const { formApi, status, confirmBox, today } = checkin;
    let headerNode = null;

    // Any change to an answer starts a fresh attempt (confirmations don't carry over).
    for (const list of Object.values(formApi.radios)) for (const input of list) {
      input.addEventListener("change", () => { attempt = { confirmShare: false, confirmSameDay: false }; hideConfirm(); });
    }

    function hideConfirm() {
      confirmBox.replaceChildren();
      confirmBox.setAttribute("hidden", "");
    }

    function showConfirm({ title, text, confirmLabel, onConfirm }) {
      const heading = el("h3", { class: "health-confirm__title", id: "checkin-confirm-title", tabindex: "-1" }, title);
      const yes = el("button", { class: "btn btn--primary btn--sm", type: "button", "data-confirm": "" }, [icon("check"), confirmLabel]);
      const no = el("button", { class: "btn btn--secondary btn--sm", type: "button", "data-cancel": "" }, [icon("x"), "Cancel"]);
      yes.addEventListener("click", () => {
        if (busy) return;
        yes.disabled = true; // no repeated confirmation clicks
        onConfirm();
      });
      no.addEventListener("click", () => {
        attempt = { confirmShare: false, confirmSameDay: false };
        hideConfirm();
        formApi.submit.focus();
      });
      confirmBox.replaceChildren(heading, el("p", { class: "health__text" }, text), el("p", { class: "health-confirm__actions" }, [yes, no]));
      confirmBox.removeAttribute("hidden");
      heading.focus();
    }

    function setStatus(kind, text, withRetry) {
      status.className = `health-status health-status--${kind}`;
      status.setAttribute("role", kind === "error" ? "alert" : "status");
      status.replaceChildren(icon(kind === "error" ? "circle-alert" : kind === "ok" ? "circle-check" : "info"), ` ${text}`,
        withRetry ? el("button", { class: "btn btn--secondary btn--sm", type: "button", "data-retry": "", onClick: () => startSave() }, [icon("rotate-ccw"), "Retry"]) : null);
      status.focus();
    }

    function startSave() {
      if (busy) return; // double clicks / repeated submits do nothing
      save();
    }

    async function save() {
      busy = true;
      formApi.setBusy(true);
      for (const b of confirmBox.querySelectorAll("[data-confirm]")) b.disabled = true;
      const answers = formApi.read();
      let result;
      try {
        result = await saveCheckin(session, answers, { ...attempt });
      } catch {
        result = { status: "unavailable", reason: "unexpected_error" };
      }
      busy = false;
      formApi.setBusy(false);
      if (!alive()) return;

      if (result.status === "invalid") {
        hideConfirm();
        attempt = { confirmShare: false, confirmSameDay: false };
        formApi.showErrors(result.errors || {});
        return;
      }
      formApi.showErrors({});
      if (result.status === "confirm_share") {
        showConfirm({
          title: "Share this check-in with the Medical Officer?",
          text: "All six scores will be shared with the Medical Officer. This check-in can't be edited, and sharing can't be changed or revoked in this version.",
          confirmLabel: "Share check-in",
          onConfirm: () => { attempt.confirmShare = true; startSave(); },
        });
        return;
      }
      if (result.status === "confirm_same_day") {
        showConfirm({
          title: "You already checked in today",
          text: `A check-in was already saved today (UTC) at ${formatTime(result.existingAt, { timeZone: "UTC" })} UTC. Add another check-in?`,
          confirmLabel: "Add another check-in",
          onConfirm: () => { attempt.confirmSameDay = true; startSave(); },
        });
        return;
      }
      hideConfirm();
      if (result.status === "saved") {
        attempt = { confirmShare: false, confirmSameDay: false };
        formApi.clear();
        setStatus("ok", result.checkin.shared ? "Check-in saved and shared with the Medical Officer." : "Check-in saved. It is private (only you can see it).");
        await refresh();
        status.focus();
        return;
      }
      if (result.status === "busy") {
        setStatus("info", "A save is already in progress. Please wait.");
        return;
      }
      // unavailable / forbidden / anything else: never a success, answers kept.
      attempt = { confirmShare: false, confirmSameDay: false };
      setStatus("error", "Your check-in was not saved. Your answers are still here.", result.status === "unavailable");
    }

    async function refresh() {
      const token = ++generation;
      let result;
      try {
        result = await loadOwn(session);
      } catch {
        result = { status: "unavailable", reason: "unexpected_error" };
      }
      if (token !== generation || !alive()) return result;
      if (result && result.status === "ready") {
        today.textContent = result.todayCheckin && result.todayCheckin.exists
          ? `You already checked in today (UTC) at ${formatTime(result.todayCheckin.at, { timeZone: "UTC" })} UTC. You can add another; you'll be asked to confirm.`
          : "No check-in yet today (UTC).";
        const retry = () => refresh();
        if (!headerNode) headerNode = header(result, false); // name/crew don't change after a save
        scanHost.replaceChildren(wellbeingScan(result, false));
        dataHost.replaceChildren(summarySection(result), historySection(result, retry, { officer: false }), extrasSection(result, retry));
      } else {
        dataHost.replaceChildren(refusalView(result, () => refresh(), BASE));
      }
      return result;
    }

    async function loadAstronaut() {
      root.setAttribute("aria-busy", "true");
      root.replaceChildren(...loadingView("Loading your wellbeing…"));
      const result = await refresh();
      if (!alive()) return;
      if (result && result.status === "ready") {
        root.replaceChildren(headerNode, scanHost, checkin.node, dataHost);
      } else {
        root.replaceChildren(refusalView(result, () => loadAstronaut(), BASE));
      }
      root.setAttribute("aria-busy", "false");
    }
    return loadAstronaut();
  };
}

export const renderWellbeing = createWellbeingRenderer({
  loadOwn: (session) => getOwnWellbeing(session),
  saveCheckin: (session, answers, options) => createCheckin(session, answers, options),
  loadShared: (session, crewId) => getCrewMemberSharedWellbeing(session, crewId),
  listCrew: (session) => listCrewForWellbeingSelection(session),
});
