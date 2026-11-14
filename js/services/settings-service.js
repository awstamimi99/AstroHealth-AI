// js/services/settings-service.js — #/settings (Sprint 9), READ-ONLY.
//
//   getSettingsView(session, options)
//
// Astronaut: mission, canonical units, data/privacy explanation.
// Medical Officer: additionally the demonstration thresholds (read-only), the
// simulation default speed (read-only) and `canResetDemo` (shows the "Reset
// synthetic demo data" control; demo-reset-service.js re-checks the role).
// Thresholds, simulation configuration and the reset flag are NEVER returned
// to astronauts.
//
// This service never calls settingsRepo.set and writes nothing. Personal
// display preferences are browser-only (js/core/preferences.js).
//
// Test seam: createSettingsService({ repos }).

import { usersRepo, astronautsRepo, settingsRepo, METRIC_UNITS } from "../db/index.js";
import { verifyAstronaut, verifyMedicalOfficer } from "./access-control.js";
import { describeMission } from "./mission-service.js";

export const THRESHOLDS_LABEL = "Demonstration thresholds — not clinically validated.";
export const ALLOWED_SPEEDS = Object.freeze([1, 2, 4, 8]);
const UNIT_ROWS = Object.freeze([
  ["heartRate", "Heart rate"], ["spo2", "SpO₂"], ["bpSystolic", "Blood pressure (systolic)"], ["bpDiastolic", "Blood pressure (diastolic)"],
  ["sleepDuration", "Sleep duration"], ["activity", "Activity (steps since 00:00 UTC)"], ["fatigue", "Fatigue"],
]);
// Demonstration rule → stored threshold keys (presentation only; values come from settings).
const THRESHOLD_ROWS = Object.freeze([
  { metric: "heartRate", label: "Heart rate", rule: "PHY-01", keys: ["warningHigh", "criticalHigh"] },
  { metric: "spo2", label: "SpO₂", rule: "PHY-02", keys: ["warningLow", "criticalLow"] },
  { metric: "bpSystolic", label: "Systolic blood pressure", rule: "PHY-03", keys: ["warningHigh", "criticalHigh"] },
  { metric: "sleepDuration", label: "Sleep duration", rule: "PHY-05", keys: ["warningLow", "criticalLow"] },
]);
export const PRIVACY_NOTES = Object.freeze([
  "All data in this prototype is synthetic and stored in this browser's IndexedDB on this device.",
  "The Medical Officer never sees your private journal or the scores of check-ins you keep private.",
  "Medical Officer lifecycle notes on alerts are internal and are not shown to astronauts.",
  "Display preferences on this page are saved only in this browser, for your account, and never change data, alerts or risk rules.",
]);

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const result = (status, reason, now, extra = {}) => ({ status, reason, generatedAt: now, ...extra });

/** TEST SEAM. */
export function createSettingsService({ repos }) {
  const nowOf = (options) => (options && options.now !== undefined ? options.now : Date.now());
  return {
    async getSettingsView(session, options = {}) {
      const now = nowOf(options);
      let role;
      if (session && session.role === "astronaut") {
        const v = await verifyAstronaut(session, repos, now);
        if (!v.ok) return v.refusal;
        role = "astronaut";
      } else {
        const v = await verifyMedicalOfficer(session, repos, now);
        if (!v.ok) return v.refusal;
        role = "officer";
      }
      let mission;
      try {
        const m = await repos.settingsRepo.get("mission");
        const d = describeMission(m, now);
        mission = d.available
          ? { status: "ok", name: d.name, missionDay: d.missionDay, startDate: m && isNum(m.startDate) ? m.startDate : 0 }
          : { status: "unavailable" };
      } catch {
        mission = { status: "error" };
      }
      const units = UNIT_ROWS.map(([key, label]) => ({ key, label, unit: METRIC_UNITS[key] }));
      const view = { viewer: role, mission, units, privacy: [...PRIVACY_NOTES] };
      if (role === "officer") {
        view.canResetDemo = true; // the reset itself is authorized again by demo-reset-service.js
        try {
          const t = await repos.settingsRepo.get("thresholds");
          const metrics = t && typeof t === "object" && t.metrics && typeof t.metrics === "object" ? t.metrics : null;
          view.thresholds = metrics
            ? {
                status: "ok",
                label: THRESHOLDS_LABEL,
                rows: THRESHOLD_ROWS.map((r) => {
                  const m = metrics[r.metric] && typeof metrics[r.metric] === "object" ? metrics[r.metric] : {};
                  return { rule: r.rule, label: r.label, unit: METRIC_UNITS[r.metric], warning: isNum(m[r.keys[0]]) ? m[r.keys[0]] : null, critical: isNum(m[r.keys[1]]) ? m[r.keys[1]] : null, direction: r.keys[0].endsWith("High") ? "high" : "low" };
                }),
              }
            : { status: "unavailable", label: THRESHOLDS_LABEL };
        } catch {
          view.thresholds = { status: "error", label: THRESHOLDS_LABEL };
        }
        try {
          const sim = await repos.settingsRepo.get("simulation");
          view.simulation = sim && ALLOWED_SPEEDS.includes(sim.speed) ? { status: "ok", speed: sim.speed } : { status: "unavailable" };
        } catch {
          view.simulation = { status: "error" };
        }
      }
      return result("ready", "", now, view);
    },
  };
}

const production = createSettingsService({ repos: Object.freeze({ usersRepo, astronautsRepo, settingsRepo }) });
export const getSettingsView = (session, options) => production.getSettingsView(session, options);
