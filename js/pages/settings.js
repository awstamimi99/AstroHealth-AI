// js/pages/settings.js — #/settings (Sprint 9), both roles.
//
// Personal display preferences (text size, motion) are saved in this browser
// only, per signed-in user (js/core/preferences.js), and applied immediately.
// Everything else is READ-ONLY from settings-service.js: mission and units for
// everyone; demonstration thresholds and the simulation default speed for the
// Medical Officer only. The only database write is the Medical-Officer-only
// "Reset synthetic demo data" action (typed confirmation RESET DEMO), done by
// js/services/demo-reset-service.js. After a successful reset this page
// emits a no-payload "demo:reset" event; the app shell then signs the user
// out and opens login.html (other tabs follow through the same event).
//
// Test seam: createSettingsRenderer({ service, prefs, notifyReset }).

import { getSettingsView } from "../services/settings-service.js";
import { resetDemoData, RESET_PHRASE } from "../services/demo-reset-service.js";
import { bus } from "../core/event-bus.js";
import { preferences, TEXT_SIZES, MOTIONS } from "../core/preferences.js";
import { icon } from "../components/icon.js";
import { el } from "../core/utils/dom.js";
import { formatDate, formatNumber } from "../core/utils/format.js";
import { loadingView, section } from "../components/crew-view.js";
import { refusalView } from "../components/health-view.js";

const TEXT_LABELS = { standard: "Standard", large: "Large", larger: "Larger" };
const MOTION_LABELS = { system: "Follow system setting", reduce: "Reduce motion" };

/** TEST SEAM. Production uses renderSettings. */
export function createSettingsRenderer({ service, prefs = preferences, notifyReset = () => bus.emit("demo:reset", {}) }) {
  return function render(container, session, { signal, focus = false } = {}) {
    const live = el("p", { class: "sr-only", role: "status", "aria-live": "polite" });
    const content = el("div", { class: "settings__content" });
    const root = el("div", { class: "settings", "aria-busy": "false" }, [live, content]);
    container.replaceChildren(root);
    const st = { generation: 0, data: null, notice: "", focusHeading: focus, reset: { open: false, typed: "", busy: false, error: "" } };
    const aborted = () => Boolean(signal && signal.aborted);
    const userKey = session && typeof session.userId === "string" ? session.userId : "";
    let unsubscribe = null;
    if (signal) signal.addEventListener("abort", () => { if (unsubscribe) unsubscribe(); }, { once: true });

    async function load() {
      const token = ++st.generation;
      root.setAttribute("aria-busy", "true");
      content.replaceChildren(...loadingView("Loading settings…"));
      let res;
      try {
        res = await service.getSettingsView(session);
      } catch {
        res = { status: "unavailable", reason: "unexpected_error" };
      }
      if (token !== st.generation || aborted()) return;
      root.setAttribute("aria-busy", "false");
      if (!res || res.status !== "ready") {
        content.replaceChildren(refusalView(res, () => load(), "settings"));
        return;
      }
      st.data = res;
      if (!unsubscribe) unsubscribe = prefs.subscribe(userKey, () => { if (!aborted()) { draw(); live.textContent = "Display preferences updated from another tab."; } });
      if (!prefs.isPersistent()) st.notice = "This browser isn't saving preferences right now, so your choice applies to this tab only.";
      draw();
      if (st.focusHeading) {
        st.focusHeading = false;
        for (const n of content.querySelectorAll("[data-heading]")) n.focus();
      }
    }

    function change(key, value) {
      const r = prefs.set(userKey, { [key]: value });
      st.notice = r.ok && !r.persisted ? "This browser isn't saving preferences right now, so your choice applies to this tab only." : "";
      live.textContent = r.ok ? "Display preference saved." : "That value isn't available.";
      draw();
    }

    function radios(name, legend, values, labels, current) {
      return el("fieldset", { class: "settings-group" }, [
        el("legend", { class: "settings-group__legend" }, legend),
        el("div", { class: "settings-options" }, values.map((v) => el("label", { class: "settings-option", for: `pref-${name}-${v}` }, [
          el("input", { type: "radio", name: `pref-${name}`, id: `pref-${name}-${v}`, value: v, checked: v === current, onChange: () => change(name, v) }),
          el("span", {}, labels[v]),
        ]))),
      ]);
    }

    function draw() {
      const d = st.data;
      const p = prefs.get(userKey);
      const parts = [
        el("section", { class: "settings__header", "aria-labelledby": "settings-title" }, [
          el("h2", { class: "settings__title", id: "settings-title", tabindex: "-1", "data-heading": "" }, "Settings"),
          el("p", { class: "settings__note" }, "Personal display preferences are saved in this browser for your account. Mission, units and risk settings are read-only."),
        ]),
        section("settings-display-title", "Display preferences", [
          radios("textSize", "Text size", TEXT_SIZES, TEXT_LABELS, p.textSize),
          radios("motion", "Motion", MOTIONS, MOTION_LABELS, p.motion),
          st.notice ? el("p", { class: "settings__notice", role: "note" }, [icon("info"), " ", st.notice]) : null,
          el("p", {}, el("button", { class: "btn btn--secondary btn--sm", type: "button", id: "pref-reset", onClick: () => { const r = prefs.reset(userKey); st.notice = r.persisted ? "" : st.notice; live.textContent = "Display preferences reset to the defaults."; draw(); } }, [icon("rotate-ccw"), "Reset my display preferences"])),
          el("p", { class: "settings__note" }, "These preferences only change how pages look on this device. They never change data, alerts, thresholds or simulations."),
        ]),
        section("settings-mission-title", "Mission (read-only)", [
          d.mission.status === "ok"
            ? el("dl", { class: "settings-facts" }, [
                el("dt", {}, "Mission"), el("dd", {}, d.mission.name),
                el("dt", {}, "Mission Day"), el("dd", {}, d.mission.missionDay ? String(d.mission.missionDay) : "Not available"),
                el("dt", {}, "Start date"), el("dd", {}, d.mission.startDate ? `${formatDate(d.mission.startDate, { timeZone: "UTC" })} (UTC)` : "Not available"),
              ])
            : el("p", {}, "Mission information is not available."),
        ]),
        section("settings-units-title", "Units (read-only)", [
          el("div", { class: "table-wrap" }, el("table", { class: "table settings-table" }, [
            el("caption", { class: "sr-only" }, "Canonical units used to store and show readings"),
            el("thead", {}, el("tr", {}, [el("th", { scope: "col" }, "Measure"), el("th", { scope: "col" }, "Unit")])),
            el("tbody", {}, d.units.map((u) => el("tr", {}, [el("th", { scope: "row" }, u.label), el("td", {}, u.unit)]))),
          ])),
          el("p", { class: "settings__note" }, "Values are stored and shown in these units."),
        ]),
      ];
      if (d.viewer === "officer") {
        const t = d.thresholds;
        parts.push(section("settings-thresholds-title", "Demonstration risk thresholds (read-only)", [
          el("p", { class: "settings__label" }, [icon("info"), " ", t.label]),
          t.status === "ok"
            ? el("div", { class: "table-wrap" }, el("table", { class: "table settings-table" }, [
                el("caption", { class: "sr-only" }, "Stored demonstration thresholds used by the risk rules"),
                el("thead", {}, el("tr", {}, ["Rule", "Measure", "Watch (info)", "Warning", "Critical"].map((h) => el("th", { scope: "col" }, h)))),
                el("tbody", {}, t.rows.map((r) => el("tr", {}, [
                  el("th", { scope: "row" }, r.rule),
                  el("td", { "data-label": "Measure" }, r.label),
                  el("td", { "data-label": "Watch (info)" }, r.watch === null || r.watch === undefined ? "—" : `${r.direction === "high" ? "above" : "below"} ${formatNumber(r.watch, r.watch % 1 ? 1 : 0)} ${r.unit}`),
                  el("td", { "data-label": "Warning" }, r.warning === null ? "Not set" : `${r.direction === "high" ? "above" : "below"} ${formatNumber(r.warning, r.warning % 1 ? 1 : 0)} ${r.unit}`),
                  el("td", { "data-label": "Critical" }, r.critical === null ? "Not set" : `${r.direction === "high" ? "above" : "below"} ${formatNumber(r.critical, r.critical % 1 ? 1 : 0)} ${r.unit}`),
                ]))),
              ]))
            : el("p", {}, "Stored thresholds are not available."),
          el("p", { class: "settings__note" }, "Thresholds can't be edited in this version. PHY-03 uses “at or above”; see the Alerts page for each rule's exact wording."),
        ]));
        parts.push(section("settings-sim-title", "Simulation (read-only)", [
          el("p", {}, d.simulation.status === "ok" ? `Default speed: ${d.simulation.speed}×` : "Default speed is not available."),
        ]));
      }
      if (d.viewer === "officer" && d.canResetDemo === true) parts.push(resetSection());
      parts.push(section("settings-privacy-title", "Data and privacy", [el("ul", { class: "settings-list" }, d.privacy.map((x) => el("li", {}, x)))]));
      const activeId = globalThis.document && document.activeElement && typeof document.activeElement.getAttribute === "function" ? document.activeElement.getAttribute("id") : null;
      content.replaceChildren(...parts);
      if (activeId) for (const n of content.querySelectorAll("[id]")) if (n.getAttribute("id") === activeId && typeof n.focus === "function") n.focus();
    }

    const focusId = (id) => { for (const n of content.querySelectorAll("[id]")) if (n.getAttribute("id") === id) n.focus(); };

    function resetSection() {
      const r = st.reset;
      const children = [
        el("p", {}, "Restore this browser's local data to the original synthetic demo state, for example before a demonstration."),
      ];
      if (!r.open) {
        children.push(el("p", {}, el("button", { class: "btn btn--secondary btn--sm", type: "button", id: "reset-open", onClick: () => { st.reset = { open: true, typed: "", busy: false, error: "" }; draw(); focusId("reset-title"); } }, [icon("rotate-ccw"), "Reset synthetic demo data"])));
        return section("settings-reset-title", "Demo data", children);
      }
      const matches = r.typed === RESET_PHRASE;
      children.push(el("div", { class: "settings-reset", role: "group", "aria-labelledby": "reset-title" }, [
        el("h3", { class: "settings-reset__title", id: "reset-title", tabindex: "-1" }, "Reset synthetic demo data?"),
        el("ul", { class: "settings-list" }, [
          el("li", {}, "All locally stored synthetic demo activity on this browser will be deleted and replaced with the original demo data."),
          el("li", {}, "Simulation runs, generated alerts, check-ins and the local history are reset."),
          el("li", {}, "Personal display preferences are separate and are not deleted."),
          el("li", {}, "This affects only this browser on this device. Everyone signed in here is signed out."),
          el("li", {}, "This cannot be undone."),
        ]),
        el("div", { class: "field" }, [
          el("label", { class: "field__label", for: "reset-phrase" }, `Type ${RESET_PHRASE} to confirm`),
          el("div", { class: "field__control" }, el("input", { id: "reset-phrase", type: "text", autocomplete: "off", spellcheck: "false", value: r.typed, "aria-describedby": "reset-help", disabled: r.busy, onInput: (e) => { st.reset = { ...st.reset, typed: String(e.target.value || ""), error: "" }; syncReset(); } })),
          el("p", { class: "field__hint", id: "reset-help" }, `The button is enabled only when the text is exactly ${RESET_PHRASE} (capital letters).`),
        ]),
        r.error ? el("p", { class: "settings__notice settings__notice--error", role: "alert" }, [icon("circle-alert"), " ", r.error]) : null,
        el("p", { class: "settings-reset__actions" }, [
          el("button", { class: "btn btn--danger btn--sm", type: "button", id: "reset-confirm", "data-reset-confirm": "", disabled: !matches || r.busy, onClick: () => confirmReset() }, [icon("rotate-ccw"), r.busy ? "Resetting…" : "Reset synthetic demo data"]),
          el("button", { class: "btn btn--secondary btn--sm", type: "button", id: "reset-cancel", disabled: r.busy, onClick: () => { st.reset = { open: false, typed: "", busy: false, error: "" }; draw(); focusId("reset-open"); live.textContent = "Reset cancelled. Nothing was changed."; } }, [icon("x"), "Cancel"]),
        ]),
      ]));
      return section("settings-reset-title", "Demo data", children);
    }

    function syncReset() {
      const ok = st.reset.typed === RESET_PHRASE && !st.reset.busy;
      for (const b of content.querySelectorAll("[data-reset-confirm]")) {
        b.disabled = !ok;
        if (ok) b.removeAttribute("disabled");
        else b.setAttribute("disabled", "");
      }
    }

    async function confirmReset() {
      if (st.reset.busy || st.reset.typed !== RESET_PHRASE) return;
      st.reset = { ...st.reset, busy: true, error: "" };
      draw();
      live.textContent = "Resetting synthetic demo data…";
      let res;
      try {
        res = await service.resetDemoData(session, { confirmation: st.reset.typed });
      } catch {
        res = { status: "unavailable", reason: "unexpected_error" };
      }
      if (aborted()) return;
      if (res && res.status === "reset") {
        content.replaceChildren(el("p", { class: "settings__notice", role: "status" }, [icon("circle-check"), " Synthetic demo data was reset. Signing you out…"]));
        live.textContent = "Synthetic demo data was reset. Signing you out.";
        notifyReset(); // the app shell signs out and opens the login page (all tabs)
        return;
      }
      const msg = res && res.reason === "confirmation_required" ? `Type ${RESET_PHRASE} exactly to confirm.`
        : res && res.status === "forbidden" ? "Only a verified Medical Officer can reset demo data."
        : res && res.status === "busy" ? "A reset is already running. Please wait."
        : "The demo data could not be reset. The reset is all-or-nothing, so nothing was changed. Try again.";
      st.reset = { ...st.reset, busy: false, error: msg };
      draw();
      live.textContent = msg;
      focusId("reset-phrase");
    }

    return load();
  };
}

export const renderSettings = createSettingsRenderer({
  service: Object.freeze({ getSettingsView: (s) => getSettingsView(s), resetDemoData: (s, i) => resetDemoData(s, i) }),
});
