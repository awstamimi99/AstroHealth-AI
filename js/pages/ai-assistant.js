// js/pages/ai-assistant.js — #/ai, the AI Assistant (its own sidebar section).
//
//   Astronaut        → "AstroHealth AI Companion": own history analysis,
//                      comparisons, questions, and a personalised daily
//                      routine draft that includes the exercise countermeasure.
//   Medical Officer  → "AstroHealth Medical AI": crew trends, one member's
//                      analysis, comparisons, explanations of existing alerts.
//
// The data context comes from js/services/ai-context-service.js (authorized,
// pre-computed numbers only). Questions go to the local AI server through
// js/services/ai-assistant-service.js. The AI never changes records, alerts or
// schedules: a routine is a DRAFT the user may accept (kept in this browser
// only, js/core/routine-drafts.js), reject or ask to change.
// All AI text is inserted with el()/textContent — never innerHTML.
//
// Test seam: createAiAssistantRenderer({ loadContext, ask, checkServer, drafts, subscribe }).

import { getAstronautAiContext, getOfficerAiContext } from "../services/ai-context-service.js";
import { askAi, checkAiServer } from "../services/ai-assistant-service.js";
import { routineDrafts } from "../core/routine-drafts.js";
import { onHealthChanged } from "../core/live-updates.js";
import { icon } from "../components/icon.js";
import { el } from "../core/utils/dom.js";
import { formatDateTime } from "../core/utils/format.js";
import { badge, loadingView } from "../components/crew-view.js";
import { refusalView } from "../components/health-view.js";

/** replaceChildren that skips null / false (the DOM would render them as the text "null"). */
const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));

const BASE = "ai";
const COPY = Object.freeze({
  astronaut: {
    title: "AstroHealth AI Companion",
    subtitle: "Questions about your own synthetic health history, and a personalised daily routine with your exercise countermeasure.",
    actions: [
      ["history", "Analyze my history", "What changed in my health this week?"],
      ["chat", "Compare 7-day periods", "Compare my last seven days with the previous seven."],
      ["chat", "My sleep over 30 days", "What changed in my sleep over the last 30 days?"],
      ["routine", "Build my routine + workout", "Build a personalised daily routine for today, including my exercise session."],
    ],
  },
  medical_officer: {
    title: "AstroHealth Medical AI",
    subtitle: "Crew trend summaries, one crew member's analysis and explanations of existing alerts. Wellbeing data comes from shared check-ins only.",
    actions: [
      ["crew", "Summarize crew trends", "Summarize the crew's health trends."],
      ["trends", "Notable changes", "Which astronauts have notable changes?"],
      ["chat", "Compare crew sleep", "Compare the crew's sleep history."],
      ["chat", "Explain open alerts", "Explain the existing open alerts for the crew."],
    ],
  },
});
const CATEGORY_LABEL = Object.freeze({
  "exercise-aerobic": "Exercise · aerobic", "exercise-resistance": "Exercise · resistance", mobility: "Mobility / recovery",
  work: "Mission work", meal: "Meal", rest: "Rest", sleep: "Sleep", personal: "Personal time", hygiene: "Hygiene", communication: "Communication",
});
const SERVER_BADGE = Object.freeze({
  ready: ["badge--ok", "circle-check", "AI server ready"],
  checking: ["badge--neutral", "clock", "Checking AI server…"],
  offline: ["badge--neutral", "wifi-off", "Offline"],
  no_server: ["badge--warning", "triangle-alert", "AI server not running"],
  not_configured: ["badge--warning", "triangle-alert", "No API key"],
});

function minutesText(n) {
  const h = Math.floor(n / 60);
  const m = n % 60;
  return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
}

/** AI text → paragraphs and bullet lines, as text nodes only. */
function answerNodes(text) {
  const out = [];
  let list = null;
  for (const raw of String(text).replace(/\*\*/g, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { list = null; continue; }
    if (/^recommendation\s*:/i.test(line)) {
      list = null;
      out.push(el("p", { class: "ai-msg__rec", "data-ai-recommendation": "" }, [icon("circle-check"), el("span", {}, [el("strong", {}, "Recommendation: "), line.replace(/^recommendation\s*:\s*/i, "")])]));
      continue;
    }
    const bullet = /^[-*•]\s+/.test(line);
    if (bullet) {
      if (!list) { list = el("ul", { class: "ai-msg__list" }); out.push(list); }
      list.append(el("li", {}, line.replace(/^[-*•]\s+/, "")));
    } else {
      list = null;
      out.push(el("p", {}, line.replace(/^#+\s*/, "")));
    }
  }
  return out;
}

export function createAiAssistantRenderer({ loadContext, ask, checkServer, drafts = routineDrafts, subscribe = onHealthChanged }) {
  return function render(container, session, { signal, focus = false } = {}) {
    const role = session && session.role;
    const copy = COPY[role];
    const root = el("div", { class: "ai-page", "aria-busy": "true" });
    container.replaceChildren(root);
    if (!copy) {
      fill(root, refusalView({ status: "forbidden", reason: "wrong_role" }, null, BASE));
      return Promise.resolve();
    }
    const userKey = typeof session.userId === "string" ? session.userId : "";
    const st = { context: null, crew: [], server: { state: "checking", message: "" }, messages: [], busy: false, error: "", focusCrew: "", routine: null, routineNote: "" };
    const aborted = () => Boolean(signal && signal.aborted);
    const live = el("p", { class: "sr-only", role: "status", "aria-live": "polite" });

    // ---- static frame ---------------------------------------------------------------------------
    const statusSlot = el("div", { class: "ai-page__server" });
    const actionsSlot = el("div", { class: "ai-page__actions" });
    const historyBox = el("div", { class: "ai-chat__history", role: "log", "aria-live": "polite", "aria-label": "Conversation" });
    const errorBox = el("p", { class: "ai-chat__error", role: "alert", hidden: true });
    const input = el("textarea", { class: "ai-chat__input", id: "ai-input", rows: "3", maxlength: "1000", placeholder: role === "astronaut" ? "Ask about your synthetic health data… e.g. “Why did my fatigue score increase?”" : "Ask about the crew… e.g. “Analyze Sami's last seven days.”", "aria-label": "Message to the AI" });
    const sendButton = el("button", { class: "btn btn--primary", type: "button", id: "ai-send", "data-ai-send": "", onClick: () => send("chat", input.value) }, [icon("send"), "Send"]);
    const routineSlot = el("div", { class: "ai-page__routine" });
    const savedSlot = el("div", { class: "ai-page__saved" });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send("chat", input.value); } });

    fill(root,
      live,
      el("section", { class: "ai-page__header", "aria-labelledby": "ai-title" }, [
        el("div", { class: "ai-page__title-row" }, [
          el("span", { class: "ai-page__icon", "aria-hidden": "true" }, icon("message-circle")),
          el("div", {}, [
            el("h2", { class: "ai-page__title", id: "ai-title", tabindex: "-1" }, copy.title),
            el("p", { class: "ai-page__subtitle" }, copy.subtitle),
          ]),
        ]),
        statusSlot,
      ]),
      el("section", { class: "card ai-chat", "aria-labelledby": "ai-chat-title" }, [
        el("div", { class: "ai-chat__head" }, [
          el("h3", { class: "ai-chat__title", id: "ai-chat-title" }, "Conversation"),
          el("button", { class: "btn btn--ghost btn--sm", type: "button", id: "ai-clear", onClick: () => { st.messages = []; drawHistory(); live.textContent = "Conversation cleared."; } }, [icon("trash-2"), "Clear chat"]),
        ]),
        actionsSlot,
        historyBox,
        errorBox,
        el("div", { class: "ai-chat__composer" }, [input, sendButton]),
        el("p", { class: "ai-chat__hint" }, "Enter sends · Shift + Enter adds a new line. Follow-up questions keep the last few messages as context."),
      ]),
      routineSlot,
      savedSlot,
      whatIsSent(),
    );

    function whatIsSent() {
      return el("details", { class: "card ai-page__scope" }, [
        el("summary", {}, "What the AI receives"),
        el("ul", { class: "ai-page__scope-list" }, (role === "astronaut"
          ? ["Your own readings: count, average, min, max and change for the last 24 hours, 7 days and 30 days, and the previous period of the same length",
             "Your baseline and how far the averages are from it; days without data",
             "Your own check-in averages (private and shared), your open alerts with their rule explanation",
             "Never: your private journal, password, session, or anyone else's data"]
          : ["Each crew member's computed reading statistics for the last 24 hours, 7 days and 30 days with previous-period comparison and baseline deviation",
             "Check-in averages from SHARED check-ins only; open alerts with their rule explanation",
             "Never: private check-ins, private journals, passwords, sessions or internal ids"]).map((t) => el("li", {}, t))),
        el("p", { class: "ai-chat__hint" }, "Numbers are calculated by the app from stored synthetic data; Gemini only explains them. Requests go to the local AI server and then to Google's Gemini API with storage turned off."),
      ]);
    }

    // ---- drawing ---------------------------------------------------------------------------------
    function drawStatus() {
      const [cls, ic, text] = SERVER_BADGE[st.server.state] || SERVER_BADGE.no_server;
      fill(statusSlot,
        el("p", { class: "ai-page__badges" }, [badge(cls, ic, text), st.server.model ? el("span", { class: "ai-chat__hint" }, `Model: ${st.server.model}`) : null]),
        st.server.message ? el("p", { class: "banner banner--warning", role: "note" }, [icon("triangle-alert"), el("span", { class: "banner__text" }, st.server.message)]) : null,
      );
    }

    function drawActions() {
      const buttons = copy.actions.map(([action, label, prompt], i) => el("button", {
        class: "btn btn--secondary btn--sm", type: "button", id: `ai-quick-${i}`, "data-ai-action": action, disabled: st.busy || !st.context,
        onClick: () => send(action, prompt),
      }, [icon(action === "routine" ? "calendar" : "message-circle"), label]));
      const memberPick = role === "medical_officer" && st.crew.length
        ? el("div", { class: "ai-page__member" }, [
            el("label", { class: "field__label", for: "ai-member" }, "Analyze one crew member"),
            el("div", { class: "ai-page__member-row" }, [
              el("div", { class: "field__control" }, el("select", { id: "ai-member", onChange: (e) => { st.focusCrew = e.target.value; } }, [
                el("option", { value: "" }, "Choose a crew member…"),
                ...st.crew.map((c) => el("option", { value: c.crewId, selected: c.crewId === st.focusCrew }, `${c.name} · ${c.crewId}`)),
              ])),
              el("button", { class: "btn btn--secondary btn--sm", type: "button", id: "ai-member-go", disabled: st.busy || !st.context, onClick: () => {
                const c = st.crew.find((x) => x.crewId === st.focusCrew);
                if (!c) { showError("Choose a crew member first."); return; }
                send("member", `Analyze ${c.name}'s (${c.crewId}) last seven days.`);
              } }, [icon("arrow-right"), "Analyze last 7 days"]),
            ]),
          ])
        : null;
      fill(actionsSlot, el("div", { class: "ai-page__quick" }, buttons), memberPick);
      sendButton.disabled = st.busy || !st.context;
    }

    function drawHistory() {
      fill(historyBox, ...(st.messages.length
        ? st.messages.map((m) => el("article", { class: ["ai-msg", `ai-msg--${m.role}`] }, [
            el("p", { class: "ai-msg__who" }, m.role === "user" ? "You" : `AstroHealth AI${m.model ? ` · ${m.model}` : ""}`),
            ...(m.role === "user" ? [el("p", {}, m.text)] : answerNodes(m.text)),
            m.role === "assistant" ? el("p", { class: "ai-msg__label" }, "AI-generated · synthetic data · not medical advice") : null,
          ]))
        : [el("p", { class: "ai-chat__empty" }, "Choose a quick action above or type a question. Answers are based only on the stored synthetic data.")]),
      st.busy ? el("p", { class: "ai-msg ai-msg--pending", role: "status" }, [icon("clock"), " Analyzing the authorized synthetic data…"]) : null);
      historyBox.scrollTop = historyBox.scrollHeight;
    }

    function routineTable(r, { id, caption }) {
      return el("div", { class: "ai-routine__table-wrap" }, el("table", { class: "table ai-routine__table", id }, [
        el("caption", { class: "sr-only" }, caption),
        el("thead", {}, el("tr", {}, ["Start", "Duration", "Activity", "Why", "Supporting data"].map((h) => el("th", { scope: "col" }, h)))),
        el("tbody", {}, r.items.map((i) => el("tr", { class: i.category.startsWith("exercise") || i.category === "mobility" ? "ai-routine__row--exercise" : "" }, [
          el("td", { "data-label": "Start" }, i.start),
          el("td", { "data-label": "Duration" }, minutesText(i.durationMin)),
          el("td", { "data-label": "Activity" }, [el("strong", {}, i.activity), el("span", { class: "ai-routine__cat" }, CATEGORY_LABEL[i.category] || i.category)]),
          el("td", { "data-label": "Why" }, i.explanation || "—"),
          el("td", { "data-label": "Supporting data" }, i.evidence || "—"),
        ]))),
      ]));
    }

    function exerciseMinutes(r) {
      return r.items.filter((i) => i.category === "exercise-aerobic" || i.category === "exercise-resistance").reduce((s, i) => s + i.durationMin, 0);
    }

    function drawRoutine() {
      const r = st.routine;
      if (!r) { fill(routineSlot); return; }
      fill(routineSlot, el("section", { class: "card ai-routine", "aria-labelledby": "ai-routine-title", "data-ai-routine": "" }, [
        el("h3", { class: "ai-chat__title", id: "ai-routine-title", tabindex: "-1" }, "Routine draft — review"),
        r.summary ? el("p", {}, r.summary) : null,
        el("p", { class: "ai-page__badges" }, [
          badge("badge--info", "activity", `Exercise countermeasure: ${minutesText(exerciseMinutes(r))}`),
          el("span", { class: "sim-tag" }, "AI draft · not a mission schedule"),
        ]),
        routineTable(r, { id: "ai-routine-draft", caption: "AI routine draft" }),
        el("p", { class: "ai-chat__hint" }, "Non-clinical demonstration. Exercise intensity is not a medical prescription; follow approved crew protocols. Accepting only saves the draft in this browser."),
        st.routineNote ? el("p", { class: "ai-chat__hint", role: "status" }, st.routineNote) : null,
        el("div", { class: "ai-routine__actions" }, [
          el("button", { class: "btn btn--primary btn--sm", type: "button", id: "ai-routine-accept", onClick: () => {
            const res = drafts.save(userKey, r, Date.now());
            st.routineNote = res.ok ? (res.persisted ? "Accepted. Saved as your routine draft in this browser." : "Accepted for this tab only (browser storage is unavailable).") : "This draft couldn't be saved.";
            live.textContent = st.routineNote;
            st.routine = null;
            drawRoutine();
            drawSaved();
          } }, [icon("check"), "Accept draft"]),
          el("button", { class: "btn btn--secondary btn--sm", type: "button", id: "ai-routine-change", onClick: () => {
            input.value = "Please change the routine: ";
            input.focus();
            st.routineNote = "Describe the change, then press Send — the AI will return a new draft.";
            drawRoutine();
          } }, [icon("message-circle"), "Request changes"]),
          el("button", { class: "btn btn--ghost btn--sm", type: "button", id: "ai-routine-reject", onClick: () => { st.routine = null; st.routineNote = ""; drawRoutine(); live.textContent = "Routine draft rejected. Nothing was saved."; } }, [icon("x"), "Reject"]),
        ]),
      ]));
    }

    function drawSaved() {
      if (role !== "astronaut") { fill(savedSlot); return; }
      const d = drafts.get(userKey);
      fill(savedSlot, d
        ? el("section", { class: "card ai-routine ai-routine--saved", "aria-labelledby": "ai-saved-title" }, [
            el("h3", { class: "ai-chat__title", id: "ai-saved-title" }, "My accepted routine draft"),
            el("p", { class: "ai-chat__hint" }, `Accepted ${formatDateTime(d.savedAt, { timeZone: "UTC" })} UTC · kept in this browser only · exercise ${minutesText(exerciseMinutes(d))}`),
            d.summary ? el("p", {}, d.summary) : null,
            routineTable(d, { id: "ai-routine-saved", caption: "Accepted routine draft" }),
            el("button", { class: "btn btn--ghost btn--sm", type: "button", id: "ai-routine-delete", onClick: () => { drafts.clear(userKey); drawSaved(); live.textContent = "Saved routine draft deleted."; } }, [icon("trash-2"), "Delete draft"]),
          ])
        : null);
    }

    function showError(text) {
      errorBox.textContent = text;
      errorBox.hidden = !text;
    }

    // ---- actions ---------------------------------------------------------------------------------
    async function send(action, text) {
      const question = String(text || "").trim();
      if (st.busy || !st.context) return;
      if (action === "chat" && !question) { showError("Type a question first."); return; }
      const wantsRoutine = role === "astronaut" && (action === "routine" || /\broutine\b/i.test(question) && /change|modify|adjust|update/i.test(question) && Boolean(st.routine || drafts.get(userKey)));
      const finalAction = wantsRoutine ? "routine" : action;
      showError("");
      const history = st.messages.slice(-8).map((m) => ({ role: m.role, text: m.text.slice(0, 2000) }));
      st.messages.push({ role: "user", text: question || action });
      st.busy = true;
      input.value = "";
      drawHistory();
      drawActions();
      try {
        const res = await ask({ role, action: finalAction, question, history, context: st.context, signal });
        if (aborted()) return;
        st.messages.push({ role: "assistant", text: res.routine ? `${res.answer}\n- A routine draft with ${res.routine.items.length} blocks is shown below for review.` : res.answer, model: res.model });
        if (res.routine) {
          st.routine = res.routine;
          st.routineNote = "";
          drawRoutine();
        }
        live.textContent = "The AI answered.";
      } catch (err) {
        if (aborted()) return;
        st.messages.pop();
        input.value = question;
        showError(err && err.message ? err.message : "The AI Assistant is unavailable.");
        if (err && (err.status === 404 || err.status === 501 || err.status === undefined || err.status === 0)) refreshServer();
      } finally {
        st.busy = false;
        if (!aborted()) {
          drawHistory();
          drawActions();
        }
      }
    }

    async function refreshServer() {
      let s;
      try {
        s = await checkServer();
      } catch {
        s = { state: "no_server", message: "" };
      }
      if (aborted()) return;
      st.server = s;
      drawStatus();
    }

    async function loadCtx({ quiet = false } = {}) {
      let res;
      try {
        res = await loadContext(session);
      } catch {
        res = { status: "unavailable", reason: "unexpected_error" };
      }
      if (aborted()) return;
      root.setAttribute("aria-busy", "false");
      if (!res || res.status !== "ready") {
        if (quiet) return;
        st.context = null;
        showError("Your synthetic health data couldn't be loaded for the AI. Reload the page to try again.");
      } else {
        st.context = res.context;
        st.crew = Array.isArray(res.crew) ? res.crew : [];
      }
      drawActions();
    }

    // Fresh data after a reading / check-in / alert change, so follow-up questions use it.
    subscribe({ signal, crewId: () => null, reload: () => loadCtx({ quiet: true }) });

    drawStatus();
    drawActions();
    drawHistory();
    drawSaved();
    if (focus) root.querySelectorAll("[tabindex]")[0]?.focus?.();
    return Promise.all([loadCtx(), refreshServer()]).then(() => undefined);
  };
}

export const renderAiAssistant = createAiAssistantRenderer({
  loadContext: (session) => (session && session.role === "medical_officer" ? getOfficerAiContext(session) : getAstronautAiContext(session)),
  ask: (input) => askAi(input),
  checkServer: () => checkAiServer(),
});
