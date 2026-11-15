// js/services/exercise-service.js — Daily Exercise Countermeasure (#/exercise)
// and its DAILY NOTIFICATION (Alerts page + top-bar bell).
//
//   getOwnExercise(session, options)                  astronaut: readiness, today's plan, log, history
//   getCrewExercise(session, options)                 Medical Officer: crew adherence table
//   getCrewMemberExercise(session, crewId, options)   Medical Officer: one member (read-only)
//   logExerciseSession(session, input, options)       astronaut: log ONE session (own only)
//   getExerciseReminder(session, options)             the daily notification
//
// Storage (no schema change): one missionEvents record per logged session,
// type "exercise_logged", data { sessionType, device, plannedMin, minutes,
// intensity, completion, rpe, stopReason, peakHeartRate, recoveryHeartRate,
// postFatigue, symptoms[], source }. Every value is checked against
// allow-lists / ranges; no free text is stored (stop reasons and symptoms
// come from fixed lists). Identity, timestamp and source come from here.
//
// After a session is saved, rule EX-01 (js/engine/rules/exercise-rules.js)
// is evaluated in the SAME transaction (event + alert + alertAction +
// events: all or nothing). The readiness check and the plan are
// deterministic and use the stored demonstration thresholds. Non-clinical:
// not an exercise prescription, not a fitness-for-duty decision.
//
// Test seam: createExerciseService({ repos, withTransaction }).

import {
  usersRepo, astronautsRepo, measurementsRepo, alertsRepo, alertActionsRepo, eventsRepo, settingsRepo, withTransaction,
  OPEN_ALERT_STATUSES, EXERCISE_TYPES, EXERCISE_INTENSITIES, EXERCISE_COMPLETIONS, DAY_MS,
} from "../db/index.js";
import { verifyAstronaut, verifyMedicalOfficer, resolveCrewMember, CREW_ID_PATTERN } from "./access-control.js";
import { planAlertChange } from "../engine/risk-engine.js";
import {
  EXERCISE_RULE, EXERCISE_TARGET_MIN, MISSED_DAY_MIN, DEVICES, STOP_REASONS, SYMPTOMS,
  evaluateExerciseRule, readinessCheck, dailyPlan, minutesByDay, countedMinutes,
} from "../engine/rules/exercise-rules.js";

export { EXERCISE_TARGET_MIN, MISSED_DAY_MIN, DEVICES, STOP_REASONS, SYMPTOMS };
export const HISTORY_DAYS = 14;
export const EXERCISE_NOTE = "Demonstration countermeasure plan from stored synthetic data and demonstration thresholds. Not an exercise prescription and not a fitness-for-duty decision.";
export const LOG_STORES = Object.freeze(["missionEvents", "alerts", "meta", "alertActions"]);
const ERROR = Symbol("error");
const attempt = (fn) => Promise.resolve().then(fn);
const valueOf = (s) => (s.status === "fulfilled" ? s.value : ERROR);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isText = (v) => typeof v === "string" && v.trim() !== "";
const result = (status, reason, now, extra = {}) => ({ status, reason, generatedAt: now, ...extra });
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const TYPE_LABEL = Object.freeze({ aerobic: "Aerobic", resistance: "Resistance", mobility: "Mobility" });

/** A stored exercise event → presentation-safe session (allow-listed fields only). */
export function presentSession(e) {
  const d = e && e.data && typeof e.data === "object" ? e.data : {};
  if (!e || e.type !== "exercise_logged" || !isNum(e.timestamp) || !EXERCISE_TYPES.includes(d.sessionType)) return null;
  const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
  return {
    timestamp: e.timestamp,
    sessionType: d.sessionType,
    label: TYPE_LABEL[d.sessionType],
    device: Object.values(DEVICES).flat().includes(d.device) ? d.device : "",
    plannedMin: int(d.plannedMin, 0, 240),
    minutes: int(d.minutes, 0, 240) ?? 0,
    intensity: EXERCISE_INTENSITIES.includes(d.intensity) ? d.intensity : "",
    completion: EXERCISE_COMPLETIONS.includes(d.completion) ? d.completion : "",
    rpe: int(d.rpe, 0, 10),
    stopReason: STOP_REASONS.includes(d.stopReason) ? d.stopReason : d.stopReason ? "Other" : "",
    peakHeartRate: int(d.peakHeartRate, 40, 220),
    recoveryHeartRate: int(d.recoveryHeartRate, 40, 220),
    postFatigue: int(d.postFatigue, 0, 10),
    symptoms: Array.isArray(d.symptoms) ? d.symptoms.filter((x) => SYMPTOMS.includes(x)) : [],
    source: d.source === "seed" ? "seed" : "manual",
  };
}

/** TEST SEAM. */
export function createExerciseService({ repos, withTransaction: runTransaction }) {
  const nowOf = (o) => (o && o.now !== undefined ? o.now : Date.now());
  const saving = new Set();

  async function sessionsOf(aid, fromTs, toTs) {
    const raw = await repos.eventsRepo.getRange({ astronautId: aid, fromTs, toTs, types: ["exercise_logged"] });
    return (Array.isArray(raw) ? raw : []).filter((e) => e && e.astronautId === aid).map(presentSession).filter(Boolean).sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Everything the page shows for one astronaut (internal ids stay here). */
  async function build(astronaut, now) {
    const aid = astronaut.id;
    const today0 = Math.floor(now / DAY_MS) * DAY_MS;
    const latestOf = (metric) => attempt(() => repos.measurementsRepo.getRecent(aid, metric, 6));
    const [sessS, alertsS, thS, sleepS, fatS, hrS, spoS, bpS, tS] = await Promise.allSettled([
      attempt(() => sessionsOf(aid, today0 - (HISTORY_DAYS - 1) * DAY_MS, now)),
      attempt(() => repos.alertsRepo.query({ astronautId: aid, status: [...OPEN_ALERT_STATUSES] })),
      attempt(() => repos.settingsRepo.get("thresholds")),
      latestOf("sleepDuration"), latestOf("fatigue"), latestOf("heartRate"), latestOf("spo2"), latestOf("bpSystolic"), latestOf("bodyTemperature"),
    ]);
    const sessions = valueOf(sessS);
    if (sessions === ERROR) return result("unavailable", "database_error", now);
    const last = (s, maxAge) => {
      const list = valueOf(s);
      if (list === ERROR || !Array.isArray(list)) return null;
      const ok = list.filter((m) => m && m.astronautId === aid && m.quality === "ok" && isNum(m.value) && m.timestamp <= now && now - m.timestamp <= maxAge).sort((a, b) => b.timestamp - a.timestamp);
      return ok.length ? ok[0].value : null;
    };
    const alertsRaw = valueOf(alertsS);
    const openPhysical = alertsRaw === ERROR ? [] : (Array.isArray(alertsRaw) ? alertsRaw : []).filter((a) => a && a.astronautId === aid && a.category === "physical" && OPEN_ALERT_STATUSES.includes(a.status) && a.ruleId !== EXERCISE_RULE.id);
    const byDay = minutesByDay(sessions);
    const todayIdx = Math.floor(now / DAY_MS);
    const readiness = readinessCheck({
      sleep: last(sleepS, 36 * 3600000), fatigue: last(fatS, 24 * 3600000), heartRate: last(hrS, 24 * 3600000), spo2: last(spoS, 24 * 3600000),
      bpSystolic: last(bpS, 24 * 3600000), bodyTemperature: last(tS, 24 * 3600000), openAlerts: openPhysical.map((a) => ({ severity: a.severity })),
      yesterdayMinutes: byDay[todayIdx - 1] || 0,
    }, valueOf(thS) === ERROR ? null : valueOf(thS));
    const plan = dailyPlan(readiness.level, readiness.items, todayIdx);
    const todaySessions = sessions.filter((s) => s.timestamp >= today0);
    const minutesToday = byDay[todayIdx] || 0;
    const history = Array.from({ length: HISTORY_DAYS }, (_, i) => {
      const d = todayIdx - (HISTORY_DAYS - 1) + i;
      const items = sessions.filter((s) => Math.floor(s.timestamp / DAY_MS) === d);
      return { date: dayKey(d * DAY_MS), minutes: byDay[d] || 0, sessions: items.length, skipped: items.filter((s) => s.completion === "skipped").length, today: d === todayIdx, missed: d < todayIdx && items.length > 0 ? (byDay[d] || 0) < MISSED_DAY_MIN : d < todayIdx && (byDay[d] || 0) < MISSED_DAY_MIN && sessions.length > 0 && d >= Math.floor(sessions[0].timestamp / DAY_MS) };
    });
    const ex = alertsRaw === ERROR ? null : (Array.isArray(alertsRaw) ? alertsRaw : []).find((a) => a && a.astronautId === aid && a.ruleId === EXERCISE_RULE.id && OPEN_ALERT_STATUSES.includes(a.status));
    const done = plan.targetMin > 0 && minutesToday >= plan.targetMin;
    return result("ready", "", now, {
      profile: { crewId: astronaut.crewId, name: astronaut.name, missionRole: astronaut.missionRole },
      readiness,
      plan,
      today: { date: dayKey(now), minutes: minutesToday, targetMin: plan.targetMin, sessions: todaySessions, done },
      history,
      sevenDayAverage: Math.round(history.slice(-8, -1).reduce((s, d) => s + d.minutes, 0) / 7),
      exerciseAlert: ex ? { number: ex.number, severity: ex.severity, status: ex.status, explanation: isText(ex.explanation) ? ex.explanation : "" } : null,
      reminder: reminderFor(plan, minutesToday, now),
      note: EXERCISE_NOTE,
      options: { types: [...EXERCISE_TYPES], intensities: [...EXERCISE_INTENSITIES], completions: [...EXERCISE_COMPLETIONS], devices: { ...DEVICES }, stopReasons: [...STOP_REASONS], symptoms: [...SYMPTOMS] },
    });
  }

  function reminderFor(plan, minutesToday, now) {
    if (plan.level === "recovery") return { due: true, kind: "recovery", text: "Today's readiness check suggests a recovery day. Talk to the Medical Officer before any aerobic or resistance session.", minutes: minutesToday, targetMin: 0, date: dayKey(now) };
    const left = Math.max(0, plan.targetMin - minutesToday);
    return left
      ? { due: true, kind: "exercise", text: `Daily exercise countermeasure: ${minutesToday} of ${plan.targetMin} min logged today (${plan.level === "reduced" ? "reduced plan" : "standard plan"}).`, minutes: minutesToday, targetMin: plan.targetMin, date: dayKey(now) }
      : { due: false, kind: "done", text: `Daily exercise countermeasure done: ${minutesToday} of ${plan.targetMin} min today.`, minutes: minutesToday, targetMin: plan.targetMin, date: dayKey(now) };
  }

  async function crewMembers() {
    const all = await repos.astronautsRepo.getAll();
    const seen = new Set();
    return (Array.isArray(all) ? all : [])
      .filter((a) => a && isText(a.id) && typeof a.crewId === "string" && CREW_ID_PATTERN.test(a.crewId) && !seen.has(a.crewId) && seen.add(a.crewId))
      .sort((a, b) => a.crewId.localeCompare(b.crewId));
  }

  return {
    async getOwnExercise(session, options = {}) {
      const now = nowOf(options);
      const who = await verifyAstronaut(session, repos, now);
      if (!who.ok) return who.refusal;
      return build(who.astronaut, now);
    },

    async getCrewMemberExercise(session, crewId, options = {}) {
      const now = nowOf(options);
      const officer = await verifyMedicalOfficer(session, repos, now);
      if (!officer.ok) return officer.refusal;
      const member = await resolveCrewMember(repos, crewId, now);
      if (!member.ok) return member.refusal;
      const r = await build(member.astronaut, now);
      if (r.status === "ready") delete r.options; // read-only for the Medical Officer
      return r;
    },

    async getCrewExercise(session, options = {}) {
      const now = nowOf(options);
      const officer = await verifyMedicalOfficer(session, repos, now);
      if (!officer.ok) return officer.refusal;
      let crew;
      try {
        crew = await crewMembers();
      } catch {
        return result("unavailable", "database_error", now);
      }
      const rows = [];
      for (const a of crew) {
        const r = await build({ id: a.id, crewId: a.crewId, name: isText(a.name) ? a.name : a.crewId, missionRole: a.missionRole || "", baseline: a.baseline || {} }, now);
        rows.push(r.status !== "ready"
          ? { crewId: a.crewId, name: a.name, status: "error" }
          : { crewId: a.crewId, name: r.profile.name, status: "ok", level: r.plan.level, minutesToday: r.today.minutes, targetMin: r.today.targetMin, done: r.today.done, sevenDayAverage: r.sevenDayAverage, missedDays: r.history.filter((d) => d.missed).length, exerciseAlert: r.exerciseAlert, lastSession: r.history.length ? [...r.history].reverse().find((d) => d.sessions > 0)?.date || "" : "" });
      }
      return result("ready", "", now, { crew: rows, note: EXERCISE_NOTE });
    },

    /** The daily notification: astronaut → own plan progress; Medical Officer → who hasn't logged today. */
    async getExerciseReminder(session, options = {}) {
      const now = nowOf(options);
      if (session && session.role === "medical_officer") {
        const r = await this.getCrewExercise(session, { now });
        if (r.status !== "ready") return r;
        const due = r.crew.filter((c) => c.status === "ok" && !c.done);
        return result("ready", "", now, { viewer: "officer", due: due.length > 0, text: due.length ? `Daily exercise: ${due.length} of ${r.crew.length} crew members haven't reached today's target yet (${due.map((c) => c.name).join(", ")}).` : "Daily exercise: every crew member has reached today's target.", crew: due.map((c) => ({ crewId: c.crewId, name: c.name, minutesToday: c.minutesToday, targetMin: c.targetMin })) });
      }
      const r = await this.getOwnExercise(session, { now });
      if (r.status !== "ready") return r;
      return result("ready", "", now, { viewer: "astronaut", ...r.reminder, plan: { level: r.plan.level, headline: r.plan.headline } });
    },

    /**
     * Astronaut: log ONE session. Page input (anything else is ignored):
     * { sessionType, device, plannedMin, minutes, intensity, completion, rpe,
     *   stopReason, peakHeartRate, recoveryHeartRate, postFatigue, symptoms[] }
     */
    async logExerciseSession(session, input, options = {}) {
      const now = nowOf(options);
      const who = await verifyAstronaut(session, repos, now);
      if (!who.ok) return who.refusal;
      const src = input && typeof input === "object" ? input : {};
      const errors = {};
      const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
      const opt = (v, lo, hi, field) => {
        if (v === undefined || v === null || v === "") return null;
        const n = int(v, lo, hi);
        if (n === null) errors[field] = `Enter a whole number from ${lo} to ${hi}.`;
        return n;
      };
      if (!EXERCISE_TYPES.includes(src.sessionType)) errors.sessionType = "Choose the type of session.";
      const devices = DEVICES[src.sessionType] || [];
      if (!devices.includes(src.device)) errors.device = "Choose the device used.";
      if (!EXERCISE_COMPLETIONS.includes(src.completion)) errors.completion = "Choose completed, partial or skipped.";
      if (!EXERCISE_INTENSITIES.includes(src.intensity) && src.completion !== "skipped") errors.intensity = "Choose the intensity.";
      const minutes = src.completion === "skipped" ? 0 : int(src.minutes, 1, 240);
      if (minutes === null) errors.minutes = "Enter the minutes done (1–240).";
      const plannedMin = opt(src.plannedMin, 0, 240, "plannedMin");
      const rpe = src.completion === "skipped" ? null : opt(src.rpe, 1, 10, "rpe");
      const peakHeartRate = src.completion === "skipped" ? null : opt(src.peakHeartRate, 40, 220, "peakHeartRate");
      const recoveryHeartRate = src.completion === "skipped" ? null : opt(src.recoveryHeartRate, 40, 220, "recoveryHeartRate");
      const postFatigue = opt(src.postFatigue, 0, 10, "postFatigue");
      const stopReason = src.completion === "completed" ? "" : src.stopReason;
      if (src.completion !== "completed" && !STOP_REASONS.includes(stopReason)) errors.stopReason = "Choose why the session was shorter or skipped.";
      const symptoms = Array.isArray(src.symptoms) ? [...new Set(src.symptoms.filter((x) => SYMPTOMS.includes(x)))] : [];
      if (Object.keys(errors).length) return result("invalid", "validation", now, { errors });
      const astronaut = who.astronaut;
      const aid = astronaut.id;
      if (saving.has(aid)) return result("busy", "save_in_progress", now);
      saving.add(aid);
      let outcome = null;
      try {
        await runTransaction(LOG_STORES, "readwrite", async (tx) => {
          const label = TYPE_LABEL[src.sessionType];
          await repos.eventsRepo.add({
            type: "exercise_logged", timestamp: now, astronautId: aid, actorUserId: who.user.id, refStore: "", refId: "",
            summary: src.completion === "skipped" ? `${label} session skipped` : `${label} session ${src.completion}: ${minutes} min`,
            data: { sessionType: src.sessionType, device: src.device, plannedMin, minutes, intensity: src.completion === "skipped" ? "" : src.intensity, completion: src.completion, rpe, stopReason, peakHeartRate, recoveryHeartRate, postFatigue, symptoms, source: "manual" },
          }, { tx });
          // EX-01 on the stored sessions (re-read inside the transaction).
          const raw = await repos.eventsRepo.getRange({ astronautId: aid, fromTs: now - 30 * DAY_MS, toTs: now, types: ["exercise_logged"] }, { tx });
          const sessions = (Array.isArray(raw) ? raw : []).filter((e) => e && e.astronautId === aid).map(presentSession).filter(Boolean);
          const evaluation = evaluateExerciseRule(sessions, now);
          const openRaw = await repos.alertsRepo.getOpenByDedupeKey(`${aid}:${EXERCISE_RULE.id}`, { tx });
          const open = openRaw && openRaw.astronautId === aid ? openRaw : null;
          const plan = planAlertChange({ rule: EXERCISE_RULE, result: evaluation, openAlert: open, astronautId: aid, now, trigger: "exercise_log" });
          outcome = { change: plan.kind, number: open ? open.number : "", severity: open ? open.severity : null };
          if (plan.kind === "open") {
            const created = await repos.alertsRepo.add({ ...plan.record }, { tx });
            outcome.number = created.number;
            outcome.severity = created.severity;
            await repos.alertActionsRepo.add({ alertId: created.id, action: "created", userId: "system", timestamp: now, note: "" }, { tx });
            for (const e of plan.events) await repos.eventsRepo.add({ type: e.type, timestamp: now, astronautId: aid, actorUserId: "system", refStore: "alerts", refId: created.id, summary: e.summary.replace("{number}", created.number), data: { ...e.data } }, { tx });
          } else if (plan.kind !== "none") {
            const updated = await repos.alertsRepo.update(open.id, { ...plan.changes }, { tx });
            if (updated && updated.severity) outcome.severity = updated.severity;
            if (plan.action) await repos.alertActionsRepo.add({ alertId: open.id, action: plan.action.action, userId: "system", timestamp: now, note: plan.action.note }, { tx });
            for (const e of plan.events) await repos.eventsRepo.add({ type: e.type, timestamp: now, astronautId: aid, actorUserId: "system", refStore: "alerts", refId: open.id, summary: e.summary.replace("{number}", open.number), data: { ...e.data } }, { tx });
          }
        });
      } catch {
        return result("unavailable", "database_error", now);
      } finally {
        saving.delete(aid);
      }
      const CHANGE = { open: "opened", escalate: "escalated", retrigger: "updated", clear: "condition_cleared", none: "none" };
      return result("saved", "", now, {
        crewId: astronaut.crewId,
        session: { sessionType: src.sessionType, minutes, completion: src.completion },
        alert: outcome ? { change: CHANGE[outcome.change] || "none", number: outcome.number, severity: outcome.severity } : null,
        overheatingNote: null,
      });
    },
  };
}

const production = createExerciseService({
  repos: Object.freeze({ usersRepo, astronautsRepo, measurementsRepo, alertsRepo, alertActionsRepo, eventsRepo, settingsRepo }),
  withTransaction,
});
export const getOwnExercise = (session, options) => production.getOwnExercise(session, options);
export const getCrewExercise = (session, options) => production.getCrewExercise(session, options);
export const getCrewMemberExercise = (session, crewId, options) => production.getCrewMemberExercise(session, crewId, options);
export const logExerciseSession = (session, input, options) => production.logExerciseSession(session, input, options);
export const getExerciseReminder = (session, options) => production.getExerciseReminder(session, options);
export { countedMinutes };
