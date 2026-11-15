// js/services/wellbeing-service.js — #/wellbeing (Sprint 6)
//
//   getOwnWellbeing(session)                          astronaut: own check-ins (private + shared)
//   createCheckin(session, answers, options)          astronaut: the ONLY write in Sprint 6
//   getCrewMemberSharedWellbeing(session, "AH-04")    Medical Officer: SHARED check-ins only
//   listCrewForWellbeingSelection(session)            Medical Officer: picker
//
// PRIVACY
//   • The private journal is deferred (D3): journalRepo is never imported.
//   • The officer path reads ONLY wellbeingRepo.getSharedRange() and keeps
//     only sharedWithMedical === 1 for the selected astronaut. Private
//     check-ins are never returned, counted or used in any average.
//   • Cognitive checks: last-completed time only (no scores).
//
// WRITE (createCheckin)
//   1. verify the astronaut   2. validate six whole-number scores + share
//   3. sharing needs explicit confirmation (confirmShare: true)
//   4. per-astronaut in-memory lock (double clicks / concurrent saves)
//   5. a second check-in on the same UTC day needs confirmSameDay: true
//   6. ONE transaction: wellbeingAssessments + missionEvents and, only when
//      shared, WB-01 alert evaluation + alert action/events. The
//      "checkin_completed" event contains { shared: 0|1 }, NO scores.
//   7. lock released in `finally`
//   Private check-ins never enter the alert evaluator. Identity, timestamp,
//   source and createdBy come from the service — never
//   from page input. A failed transaction rolls back both writes.
//
// Test seam: createWellbeingService({ repos, withTransaction }).

import {
  usersRepo,
  astronautsRepo,
  wellbeingRepo,
  cognitiveRepo,
  alertsRepo,
  alertActionsRepo,
  eventsRepo,
  withTransaction,
  WELLBEING_SCALES,
  OPEN_ALERT_STATUSES,
  SEVERITIES,
  DAY_MS,
  toDateKey,
} from "../db/index.js";
import { verifyAstronaut, verifyMedicalOfficer, resolveCrewMember, listCrewForSelection } from "./access-control.js";
import { describeCognitive } from "./astronaut-overview-service.js";
import { compareAlerts } from "./crew-monitor-service.js";
import { planAlertChange } from "../engine/risk-engine.js";
import { WELLBEING_RULE, evaluateWellbeingRule, checkinConcerns } from "../engine/rules/wellbeing-rules.js";

export const SCORE_FIELDS = Object.freeze(["mood", "stress", "sleepQuality", "fatigue", "isolation", "wellbeing"]);
export const HISTORY_WINDOW_MS = 30 * DAY_MS;
export const SUMMARY_SIZE = 7;
export const SHARED_SUMMARY_LABEL = "Based only on check-ins shared by the astronaut.";
export const OWN_SUMMARY_LABEL = "Based on your own check-ins (private and shared).";
export const NO_ALERTS_NOTE = "Shared check-ins update the demonstration wellbeing alert. Private check-ins remain private and never create a Medical Officer-visible alert.";
export const CHECKIN_STORES = Object.freeze(["wellbeingAssessments", "alerts", "meta", "alertActions", "missionEvents"]);

const SCORE_LABELS = { mood: "Mood", stress: "Stress", sleepQuality: "Sleep quality", fatigue: "Fatigue", isolation: "Isolation", wellbeing: "Overall wellbeing" };
const ERROR = Symbol("error");
const valueOf = (s) => (s.status === "fulfilled" ? s.value : ERROR);
const attempt = (fn) => Promise.resolve().then(fn);
const isText = (v) => typeof v === "string" && v.trim() !== "";
const isTime = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Validate a check-in. Returns { ok: true, value } or { ok: false, errors }.
 * Six whole numbers inside WELLBEING_SCALES; `share` must be exactly true/false.
 * Unknown extra fields are ignored (never stored).
 */
export function validateCheckin(input) {
  const errors = {};
  const value = {};
  const source = input && typeof input === "object" ? input : {};
  for (const field of SCORE_FIELDS) {
    const [min, max] = WELLBEING_SCALES[field];
    const v = source[field];
    if (v === undefined || v === null || v === "") errors[field] = `Choose a ${SCORE_LABELS[field].toLowerCase()} score from ${min} to ${max}.`;
    else if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) errors[field] = `${SCORE_LABELS[field]} must be a whole number from ${min} to ${max}.`;
    else value[field] = v;
  }
  if (source.share !== true && source.share !== false) errors.share = "Choose who can see this check-in.";
  else value.share = source.share;
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

/** Presentation-safe check-in (no ids, no createdBy). */
function presentCheckin(w) {
  const scores = {};
  for (const f of SCORE_FIELDS) {
    const [min, max] = WELLBEING_SCALES[f];
    scores[f] = typeof w[f] === "number" && Number.isFinite(w[f]) && w[f] >= min && w[f] <= max ? w[f] : null;
  }
  return {
    timestamp: w.timestamp,
    ...scores,
    shared: w.sharedWithMedical === 1,
    source: ["seed", "simulation", "manual"].includes(w.source) ? w.source : "unknown",
    simulated: w.source === "seed" || w.source === "simulation",
  };
}

/** Averages over the newest SUMMARY_SIZE check-ins given (already privacy-filtered). */
export function summarizeCheckins(items, label) {
  const recent = items.slice(0, SUMMARY_SIZE);
  const averages = {};
  for (const f of SCORE_FIELDS) {
    const vals = recent.map((c) => c[f]).filter((v) => v !== null);
    averages[f] = vals.length ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null;
  }
  return { basedOn: label, count: recent.length, averages };
}

function presentAlert(a) {
  return {
    number: isText(a.number) ? a.number : "",
    title: isText(a.title) ? a.title.trim() : isText(a.type) ? a.type.replace(/[_-]+/g, " ") : "Alert",
    severity: SEVERITIES.includes(a.severity) ? a.severity : "info",
    status: a.status,
    detectedAt: isTime(a.detectedAt) ? a.detectedAt : 0,
    explanation: isText(a.explanation) ? a.explanation : "",
    synthetic: true,
  };
}

/** TEST SEAM. Pages use the exported functions below. */
export function createWellbeingService({ repos, withTransaction: runTransaction }) {
  const saving = new Set(); // astronaut ids with a save in progress (per service instance)
  const nowOf = (options) => (options && Number.isFinite(options.now) ? options.now : Date.now());

  /** Reads shared by both views, for one verified astronaut. */
  async function loadCommon(aid, now) {
    const [cogS, alertS] = await Promise.allSettled([
      attempt(() => repos.cognitiveRepo.getRange(aid, undefined, now)),
      attempt(() => repos.alertsRepo.query({ astronautId: aid, status: [...OPEN_ALERT_STATUSES] })),
    ]);
    const cog = valueOf(cogS);
    const alerts = valueOf(alertS);
    const own = (list) => (Array.isArray(list) ? list.filter((x) => x && x.astronautId === aid) : []);
    return {
      cognitive: cog === ERROR ? { status: "error", lastAt: 0 } : { status: "ok", lastAt: describeCognitive(own(cog)).lastAt },
      alerts:
        alerts === ERROR
          ? { status: "error", items: [] }
          : { status: "ok", items: own(alerts).filter((a) => OPEN_ALERT_STATUSES.includes(a.status) && a.category === "wellbeing").sort(compareAlerts).map(presentAlert) },
    };
  }

  const profileOf = (a) => ({ crewId: a.crewId, name: a.name, missionRole: a.missionRole });

  return {
    /** Astronaut: own check-ins of the last 30 days (private and shared). */
    async getOwnWellbeing(session, options = {}) {
      const now = nowOf(options);
      const who = await verifyAstronaut(session, repos, now);
      if (!who.ok) return who.refusal;
      const aid = who.astronaut.id;
      const [rangeS, common] = await Promise.all([
        Promise.allSettled([attempt(() => repos.wellbeingRepo.getRange(aid, now - HISTORY_WINDOW_MS, now))]).then(([s]) => s),
        loadCommon(aid, now),
      ]);
      const raw = valueOf(rangeS);
      const today = toDateKey(now);
      let checkins;
      let summary = null;
      let todayCheckin = { known: false, exists: false, at: 0 };
      if (raw === ERROR) checkins = { status: "error", items: [] };
      else {
        const items = (Array.isArray(raw) ? raw : [])
          .filter((w) => w && w.astronautId === aid && isTime(w.timestamp) && w.timestamp <= now)
          .sort((a, b) => b.timestamp - a.timestamp)
          .map(presentCheckin);
        checkins = { status: "ok", items };
        summary = summarizeCheckins(items, OWN_SUMMARY_LABEL);
        const todays = items.filter((c) => toDateKey(c.timestamp) === today);
        todayCheckin = { known: true, exists: todays.length > 0, at: todays.length ? todays[0].timestamp : 0 };
      }
      return {
        status: "ready", reason: "", generatedAt: now, today, viewer: "astronaut",
        profile: profileOf(who.astronaut), checkins, summary, todayCheckin, ...common, note: NO_ALERTS_NOTE,
      };
    },

    /**
     * Astronaut: save one check-in.
     * @param {object} answers  { mood, stress, sleepQuality, fatigue, isolation, wellbeing, share }
     * @param {{ now?: number, confirmShare?: boolean, confirmSameDay?: boolean }} [options]
     * @returns {Promise<{status:"saved", checkin:{timestamp, shared}}
     *   | {status:"invalid", errors} | {status:"confirm_share"} | {status:"confirm_same_day", existingAt}
     *   | {status:"busy"} | {status:"unavailable"|"forbidden", reason}>}
     */
    async createCheckin(session, answers, options = {}) {
      const now = nowOf(options);
      const who = await verifyAstronaut(session, repos, now);
      if (!who.ok) return who.refusal;
      const checked = validateCheckin(answers);
      if (!checked.ok) return { status: "invalid", reason: "validation", errors: checked.errors };
      const { share, ...scores } = checked.value;
      if (share === true && options.confirmShare !== true) return { status: "confirm_share", reason: "" };

      const aid = who.astronaut.id;
      if (saving.has(aid)) return { status: "busy", reason: "save_in_progress" };
      saving.add(aid);
      try {
        let latest;
        try {
          latest = await repos.wellbeingRepo.getLatest(aid);
        } catch {
          return { status: "unavailable", reason: "database_error" };
        }
        if (latest && latest.astronautId === aid && isTime(latest.timestamp) && toDateKey(latest.timestamp) === toDateKey(now) && options.confirmSameDay !== true) {
          return { status: "confirm_same_day", reason: "", existingAt: latest.timestamp };
        }

        const record = {
          astronautId: aid,
          timestamp: now,
          ...scores,
          sharedWithMedical: share ? 1 : 0,
          source: "manual",
          createdBy: who.user.id,
        };
        let outcome = null;
        try {
          await runTransaction(CHECKIN_STORES, "readwrite", async (tx) => {
            outcome = null;
            const saved = await repos.wellbeingRepo.add(record, { tx });
            await repos.eventsRepo.add(
              {
                type: "checkin_completed",
                timestamp: now,
                astronautId: aid,
                actorUserId: who.user.id,
                refStore: "wellbeingAssessments",
                refId: saved.id,
                summary: share ? "Check-in completed (shared with the Medical Officer)" : "Check-in completed (private)",
                data: { shared: share ? 1 : 0 },
              },
              { tx }
            );

            // Privacy boundary: only an explicitly shared check-in may affect
            // the Medical Officer-visible wellbeing alert.
            if (share) {
              const history = (await repos.wellbeingRepo.getRange(aid, now - HISTORY_WINDOW_MS, now, { tx }))
                .filter((w) => w && w.astronautId === aid && w.sharedWithMedical === 1);
              const evaluation = evaluateWellbeingRule(history, now);
              const openRaw = await repos.alertsRepo.getOpenByDedupeKey(`${aid}:${WELLBEING_RULE.id}`, { tx });
              const open = openRaw && openRaw.astronautId === aid ? openRaw : null;
              const plan = planAlertChange({ rule: WELLBEING_RULE, result: evaluation, openAlert: open, astronautId: aid, now, trigger: "daily_checkin" });
              outcome = { kind: plan.kind, number: open ? open.number : "", severity: open ? open.severity : null, explanation: evaluation.explanation, evaluation: evaluation.outcome };
              if (plan.kind === "open") {
                const created = await repos.alertsRepo.add({ ...plan.record }, { tx });
                outcome.number = created.number;
                outcome.severity = created.severity;
                await repos.alertActionsRepo.add({ alertId: created.id, action: "created", userId: "system", timestamp: now, note: "" }, { tx });
                for (const e of plan.events) await repos.eventsRepo.add({ type: e.type, timestamp: now, astronautId: aid, actorUserId: "system", refStore: "alerts", refId: created.id, summary: e.summary.replace("{number}", created.number), data: { ...e.data } }, { tx });
              } else if (plan.kind !== "none") {
                await repos.alertsRepo.update(open.id, {
                  ...plan.changes,
                  rule: {
                    id: WELLBEING_RULE.id,
                    version: WELLBEING_RULE.version,
                    description: WELLBEING_RULE.description,
                    thresholdUsed: evaluation.thresholdUsed,
                    thresholdSource: WELLBEING_RULE.thresholdSource,
                  },
                  suggestedAction: WELLBEING_RULE.suggestedAction,
                }, { tx }).then((u) => { if (u && u.severity) outcome.severity = u.severity; });
                if (plan.action) await repos.alertActionsRepo.add({ alertId: open.id, action: plan.action.action, userId: "system", timestamp: now, note: plan.action.note }, { tx });
                for (const e of plan.events) await repos.eventsRepo.add({ type: e.type, timestamp: now, astronautId: aid, actorUserId: "system", refStore: "alerts", refId: open.id, summary: e.summary.replace("{number}", open.number), data: { ...e.data } }, { tx });
              }
            }
          });
        } catch {
          return { status: "unavailable", reason: "database_error" };
        }
        // What the astronaut sees right after saving: concerns in THIS check-in (their own
        // answers) and, only for a shared check-in, what happened to the WB-01 alert.
        const CHANGE = { open: "opened", escalate: "escalated", retrigger: "updated", clear: "condition_cleared", none: "none" };
        const review = {
          concerns: checkinConcerns(record),
          shared: share,
          alert: share && outcome
            ? { change: CHANGE[outcome.kind] || "none", number: outcome.number || "", severity: outcome.severity || null, explanation: outcome.explanation || "" }
            : null,
        };
        return { status: "saved", reason: "", checkin: { timestamp: now, shared: share }, review };
      } finally {
        saving.delete(aid);
      }
    },

    /** Medical Officer: one astronaut's SHARED check-ins only. */
    async getCrewMemberSharedWellbeing(session, crewId, options = {}) {
      const now = nowOf(options);
      const officer = await verifyMedicalOfficer(session, repos, now);
      if (!officer.ok) return officer.refusal;
      const member = await resolveCrewMember(repos, crewId, now);
      if (!member.ok) return member.refusal;
      const aid = member.astronaut.id;
      const [sharedS, common] = await Promise.all([
        Promise.allSettled([attempt(() => repos.wellbeingRepo.getSharedRange(now - HISTORY_WINDOW_MS, now))]).then(([s]) => s),
        loadCommon(aid, now),
      ]);
      const raw = valueOf(sharedS);
      let checkins;
      let summary = null;
      if (raw === ERROR) checkins = { status: "error", items: [] };
      else {
        const items = (Array.isArray(raw) ? raw : [])
          .filter((w) => w && w.astronautId === aid && w.sharedWithMedical === 1 && isTime(w.timestamp) && w.timestamp <= now)
          .sort((a, b) => b.timestamp - a.timestamp)
          .map(presentCheckin);
        checkins = { status: "ok", items };
        summary = summarizeCheckins(items, SHARED_SUMMARY_LABEL);
      }
      return {
        status: "ready", reason: "", generatedAt: now, today: toDateKey(now), viewer: "officer",
        profile: profileOf(member.astronaut), checkins, summary, ...common,
      };
    },

    /** Medical Officer: picker (names + public crew IDs only). */
    async listCrewForWellbeingSelection(session, options = {}) {
      return listCrewForSelection(session, repos, nowOf(options));
    },
  };
}

const production = createWellbeingService({
  repos: Object.freeze({ usersRepo, astronautsRepo, wellbeingRepo, cognitiveRepo, alertsRepo, alertActionsRepo, eventsRepo }),
  withTransaction,
});
export const getOwnWellbeing = (session, options) => production.getOwnWellbeing(session, options);
export const createCheckin = (session, answers, options) => production.createCheckin(session, answers, options);
export const getCrewMemberSharedWellbeing = (session, crewId, options) => production.getCrewMemberSharedWellbeing(session, crewId, options);
export const listCrewForWellbeingSelection = (session, options) => production.listCrewForWellbeingSelection(session, options);
