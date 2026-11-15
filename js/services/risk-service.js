// js/services/risk-service.js — Sprint 8 risk evaluation (demonstration rules).
//
//   evaluateAstronaut(session, "AH-03", { now?, trigger? })   Medical Officer only
//   evaluateCrew(session, { now?, trigger? })                 Medical Officer only
//
// Triggers (no background processing, no evaluation on page load):
//   • after a successfully committed Simulation Center step (simulation-service)
//   • an explicit "Evaluate crew now" by a verified Medical Officer (#/alerts)
//
// Rules: js/engine/rules/physical-rules.js (PHY-01 v2, PHY-02, PHY-03, PHY-05).
// Threshold values come ONLY from settings.thresholds — demonstration values,
// not clinically validated. The engine (js/engine/risk-engine.js) is pure.
//
// ONE transaction per astronaut over measurements (read), alerts + meta (new
// alert numbers), alertActions and missionEvents. Inside it, for each rule,
// the readings and the open alert are RE-READ and the plan is computed from
// what is stored now; the plan's writes (alert change + alertAction +
// missionEvent) either all commit or none do. IndexedDB runs overlapping
// readwrite transactions one after another, so competing evaluations (other
// tabs) can't create duplicate alerts; a per-astronaut in-memory lock also
// stops double clicks. Identical repeated evaluations write nothing.
//
// Reads ONLY: users (verification), astronauts, measurements, settings
// (thresholds), alerts. Never the journal, wellbeing records, messages or
// password material. Outputs are presentation-safe: public crew IDs and alert
// numbers only.
//
// Test seam: createRiskService({ repos, withTransaction, rules }).

import {
  usersRepo,
  astronautsRepo,
  measurementsRepo,
  settingsRepo,
  alertsRepo,
  alertActionsRepo,
  eventsRepo,
  withTransaction,
} from "../db/index.js";
import { verifyMedicalOfficer, resolveCrewMember, CREW_ID_PATTERN } from "./access-control.js";
import { PHYSICAL_RULES, DEMO_THRESHOLD_LABEL } from "../engine/rules/physical-rules.js";
import { evaluateRule, planAlertChange } from "../engine/risk-engine.js";
import { EXERCISE_RULE, evaluateExerciseRule } from "../engine/rules/exercise-rules.js";

export { DEMO_THRESHOLD_LABEL };
export const EVALUATION_STORES = Object.freeze(["measurements", "alerts", "meta", "alertActions", "missionEvents"]);
export const READINGS_PER_RULE = 24;
export const TRIGGERS = Object.freeze(["evaluation", "simulation"]);

const isTime = (v) => typeof v === "number" && Number.isFinite(v);
const result = (status, reason, now, extra = {}) => ({ status, reason, generatedAt: now, ...extra });
const CHANGE_LABEL = { open: "opened", escalate: "escalated", retrigger: "updated", clear: "condition_cleared", none: "none" };

/** Stored thresholds, or null if the record is missing / unreadable. */
function usableThresholds(value) {
  return value && typeof value === "object" && value.metrics && typeof value.metrics === "object" ? value : null;
}

/** TEST SEAM. Pages use the exported functions below. */
export function createRiskService({ repos, withTransaction: runTransaction, rules = PHYSICAL_RULES, exercise = true }) {
  const locks = new Set();
  const nowOf = (options) => (options && options.now !== undefined ? options.now : Date.now());
  const triggerOf = (options) => (options && TRIGGERS.includes(options.trigger) ? options.trigger : "evaluation");

  async function loadThresholds() {
    try {
      return { ok: true, value: usableThresholds(await repos.settingsRepo.get("thresholds")) };
    } catch {
      return { ok: false, value: null };
    }
  }

  /** Evaluate every rule for ONE verified astronaut (internal ids stay here). */
  async function evaluateOne(astronaut, thresholds, now, trigger) {
    const aid = astronaut.id;
    if (locks.has(aid)) return { crewId: astronaut.crewId, name: astronaut.name, status: "busy", reason: "evaluation_in_progress", rules: [] };
    locks.add(aid);
    try {
      let outcomes;
      try {
        outcomes = await runTransaction(EVALUATION_STORES, "readwrite", async (tx) => {
          const out = [];
          for (const rule of rules) {
            const readings = await repos.measurementsRepo.getRecent(aid, rule.metric, READINGS_PER_RULE, { tx });
            const own = (Array.isArray(readings) ? readings : []).filter((m) => m && m.astronautId === aid);
            const evaluation = evaluateRule(rule, own, thresholds, now);
            const openRaw = await repos.alertsRepo.getOpenByDedupeKey(`${aid}:${rule.id}`, { tx });
            const open = openRaw && openRaw.astronautId === aid ? openRaw : null;
            const plan = planAlertChange({ rule, result: evaluation, openAlert: open, astronautId: aid, now, trigger });
            const entry = { ruleId: rule.id, ruleVersion: rule.version, metric: rule.metric, title: rule.title, outcome: evaluation.outcome, severity: evaluation.severity, reason: evaluation.reason || plan.reason || "", change: CHANGE_LABEL[plan.kind], alertNumber: open ? open.number : "", alertSeverity: open ? open.severity : null, explanation: typeof evaluation.explanation === "string" ? evaluation.explanation : "", thresholdUsed: evaluation.thresholdUsed || "" };

            if (plan.kind === "open") {
              const created = await repos.alertsRepo.add({ ...plan.record }, { tx });
              await repos.alertActionsRepo.add({ alertId: created.id, action: "created", userId: "system", timestamp: now, note: "" }, { tx });
              for (const e of plan.events) {
                await repos.eventsRepo.add({ type: e.type, timestamp: now, astronautId: aid, actorUserId: "system", refStore: "alerts", refId: created.id, summary: e.summary.replace("{number}", created.number), data: { ...e.data } }, { tx });
              }
              entry.alertNumber = created.number;
              entry.alertSeverity = created.severity;
            } else if (plan.kind !== "none") {
              const updated = await repos.alertsRepo.update(open.id, { ...plan.changes }, { tx });
              if (plan.action) await repos.alertActionsRepo.add({ alertId: open.id, action: plan.action.action, userId: "system", timestamp: now, note: plan.action.note }, { tx });
              for (const e of plan.events) {
                await repos.eventsRepo.add({ type: e.type, timestamp: now, astronautId: aid, actorUserId: "system", refStore: "alerts", refId: open.id, summary: e.summary.replace("{number}", open.number), data: { ...e.data } }, { tx });
              }
              entry.alertSeverity = updated.severity;
            }
            out.push(entry);
          }
          // EX-01 (missed exercise days) from the logged sessions — same transaction, same planner.
          if (exercise) {
            const raw = await repos.eventsRepo.getRange({ astronautId: aid, fromTs: now - 30 * 24 * 3600000, toTs: now, types: ["exercise_logged"] }, { tx });
            const sessions = (Array.isArray(raw) ? raw : []).filter((e) => e && e.astronautId === aid && e.data).map((e) => ({ timestamp: e.timestamp, sessionType: e.data.sessionType, minutes: e.data.minutes, completion: e.data.completion }));
            const evaluation = evaluateExerciseRule(sessions, now);
            const openRaw = await repos.alertsRepo.getOpenByDedupeKey(`${aid}:${EXERCISE_RULE.id}`, { tx });
            const open = openRaw && openRaw.astronautId === aid ? openRaw : null;
            const plan = planAlertChange({ rule: EXERCISE_RULE, result: evaluation, openAlert: open, astronautId: aid, now, trigger });
            const entry = { ruleId: EXERCISE_RULE.id, ruleVersion: EXERCISE_RULE.version, metric: "exercise", title: EXERCISE_RULE.title, outcome: evaluation.outcome, severity: evaluation.severity, reason: evaluation.reason || plan.reason || "", change: CHANGE_LABEL[plan.kind], alertNumber: open ? open.number : "", alertSeverity: open ? open.severity : null, explanation: evaluation.explanation, thresholdUsed: evaluation.thresholdUsed };
            if (plan.kind === "open") {
              const created = await repos.alertsRepo.add({ ...plan.record }, { tx });
              await repos.alertActionsRepo.add({ alertId: created.id, action: "created", userId: "system", timestamp: now, note: "" }, { tx });
              for (const e of plan.events) await repos.eventsRepo.add({ type: e.type, timestamp: now, astronautId: aid, actorUserId: "system", refStore: "alerts", refId: created.id, summary: e.summary.replace("{number}", created.number), data: { ...e.data } }, { tx });
              entry.alertNumber = created.number;
              entry.alertSeverity = created.severity;
            } else if (plan.kind !== "none") {
              const updated = await repos.alertsRepo.update(open.id, { ...plan.changes }, { tx });
              if (plan.action) await repos.alertActionsRepo.add({ alertId: open.id, action: plan.action.action, userId: "system", timestamp: now, note: plan.action.note }, { tx });
              for (const e of plan.events) await repos.eventsRepo.add({ type: e.type, timestamp: now, astronautId: aid, actorUserId: "system", refStore: "alerts", refId: open.id, summary: e.summary.replace("{number}", open.number), data: { ...e.data } }, { tx });
              entry.alertSeverity = updated.severity;
            }
            out.push(entry);
          }
          return out;
        });
      } catch {
        return { crewId: astronaut.crewId, name: astronaut.name, status: "unavailable", reason: "database_error", rules: [] };
      }
      return { crewId: astronaut.crewId, name: astronaut.name, status: "evaluated", reason: "", rules: outcomes };
    } finally {
      locks.delete(aid);
    }
  }

  return {
    /** Medical Officer: evaluate one crew member now. */
    async evaluateAstronaut(session, crewId, options = {}) {
      const now = nowOf(options);
      if (!isTime(now)) return result("invalid", "invalid_time", Date.now());
      const officer = await verifyMedicalOfficer(session, repos, now);
      if (!officer.ok) return officer.refusal;
      const member = await resolveCrewMember(repos, crewId, now);
      if (!member.ok) return member.refusal;
      const th = await loadThresholds();
      if (!th.ok) return result("unavailable", "database_error", now);
      const one = await evaluateOne(member.astronaut, th.value, now, triggerOf(options));
      if (one.status !== "evaluated") return result(one.status, one.reason, now, { crewId: one.crewId });
      return result("evaluated", "", now, { crewId: one.crewId, name: one.name, rules: one.rules, thresholdLabel: DEMO_THRESHOLD_LABEL, thresholdsAvailable: Boolean(th.value) });
    },

    /** Medical Officer: evaluate every crew member (one transaction each). */
    async evaluateCrew(session, options = {}) {
      const now = nowOf(options);
      if (!isTime(now)) return result("invalid", "invalid_time", Date.now());
      const officer = await verifyMedicalOfficer(session, repos, now);
      if (!officer.ok) return officer.refusal;
      let all;
      try {
        all = await repos.astronautsRepo.getAll();
      } catch {
        return result("unavailable", "database_error", now);
      }
      const th = await loadThresholds();
      if (!th.ok) return result("unavailable", "database_error", now);
      const seen = new Set();
      const crew = (Array.isArray(all) ? all : [])
        .filter((a) => a && typeof a.id === "string" && typeof a.crewId === "string" && CREW_ID_PATTERN.test(a.crewId) && !seen.has(a.crewId) && seen.add(a.crewId))
        .sort((a, b) => a.crewId.localeCompare(b.crewId));
      const members = [];
      for (const a of crew) members.push(await evaluateOne({ id: a.id, crewId: a.crewId, name: typeof a.name === "string" ? a.name : a.crewId }, th.value, now, triggerOf(options)));
      const failed = members.filter((m) => m.status !== "evaluated").length;
      return result(failed === 0 ? "evaluated" : failed === members.length && members.length ? "unavailable" : "partial", failed ? "some_members_failed" : "", now, {
        members,
        thresholdLabel: DEMO_THRESHOLD_LABEL,
        thresholdsAvailable: Boolean(th.value),
      });
    },
  };
}

const production = createRiskService({
  repos: Object.freeze({ usersRepo, astronautsRepo, measurementsRepo, settingsRepo, alertsRepo, alertActionsRepo, eventsRepo }),
  withTransaction,
});
export const evaluateAstronaut = (session, crewId, options) => production.evaluateAstronaut(session, crewId, options);
export const evaluateCrew = (session, options) => production.evaluateCrew(session, options);
