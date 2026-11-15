// js/services/ai-context-service.js — builds the COMPACT, AUTHORIZED data
// context that the AI Assistant (#/ai) sends to the local AI server.
//
//   getAstronautAiContext(session, options)  → own data only
//   getOfficerAiContext(session, options)    → every crew member; wellbeing
//                                              from SHARED check-ins only
//
// All arithmetic is done HERE, deterministically, from stored synthetic data
// (Gemini only explains the numbers): for the last 24 hours, 7 days and 30
// days — count, average, minimum, maximum, the previous period of the same
// length, the change in percent, the deviation from the personal baseline,
// and how many days in the window had no reading. Invalid readings are
// excluded; suspect readings are counted separately and excluded from the
// numbers. Nothing is invented: a window without data says so.
//
// NEVER included: private journal text, passwords / hashes / salts / the
// session, internal user or astronaut ids, raw records, messages. For the
// Medical Officer, private (unshared) check-ins are never read.
//
// Pure helper exported for tests: windowStats(readings, { now, ms, baseline }).
// Test seam: createAiContextService({ repos }).

import { usersRepo, astronautsRepo, measurementsRepo, wellbeingRepo, alertsRepo, eventsRepo, OPEN_ALERT_STATUSES, SEVERITIES, DAY_MS } from "../db/index.js";
import { minutesByDay, EXERCISE_TARGET_MIN, MISSED_DAY_MIN } from "../engine/rules/exercise-rules.js";
import { verifyAstronaut, verifyMedicalOfficer, CREW_ID_PATTERN } from "./access-control.js";

export const AI_WINDOWS = Object.freeze([
  Object.freeze({ key: "last24h", label: "last 24 hours", ms: DAY_MS }),
  Object.freeze({ key: "last7d", label: "last 7 days", ms: 7 * DAY_MS }),
  Object.freeze({ key: "last30d", label: "last 30 days", ms: 30 * DAY_MS }),
]);
export const AI_METRICS = Object.freeze([
  Object.freeze({ key: "heartRate", label: "Heart rate", unit: "bpm", decimals: 0 }),
  Object.freeze({ key: "spo2", label: "SpO₂", unit: "%", decimals: 0 }),
  Object.freeze({ key: "bpSystolic", label: "Systolic blood pressure", unit: "mmHg", decimals: 0 }),
  Object.freeze({ key: "bpDiastolic", label: "Diastolic blood pressure", unit: "mmHg", decimals: 0 }),
  Object.freeze({ key: "sleepDuration", label: "Sleep duration", unit: "h", decimals: 1 }),
  Object.freeze({ key: "activity", label: "Activity (steps, running daily total)", unit: "steps", decimals: 0 }),
  Object.freeze({ key: "fatigue", label: "Fatigue (sensor/self-report)", unit: "0-10", decimals: 1 }),
  Object.freeze({ key: "bodyTemperature", label: "Body temperature", unit: "°C", decimals: 1 }),
  Object.freeze({ key: "cabinCo2", label: "Cabin CO₂ at the crew member's location (ppCO₂)", unit: "mmHg", decimals: 1 }),
  Object.freeze({ key: "cabinPressure", label: "Cabin pressure", unit: "kPa", decimals: 1 }),
  Object.freeze({ key: "cabinHumidity", label: "Cabin humidity", unit: "%RH", decimals: 0 }),
]);
const CHECKIN_FIELDS = Object.freeze(["mood", "stress", "sleepQuality", "fatigue", "isolation", "wellbeing"]);
const ERROR = Symbol("error");
const attempt = (fn) => Promise.resolve().then(fn);
const valueOf = (s) => (s.status === "fulfilled" ? s.value : ERROR);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isText = (v) => typeof v === "string" && v.trim() !== "";
const round = (v, d = 1) => (isNum(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const result = (status, reason, now, extra = {}) => ({ status, reason, generatedAt: now, ...extra });

/**
 * Deterministic statistics of one window and the previous window of the same length.
 * `readings`: [{ value, timestamp, quality }]. Invalid and suspect readings are excluded.
 * `daily: true` (activity) uses the newest value per UTC day (a running total).
 */
export function windowStats(readings, { now, ms, baseline = null, decimals = 1, daily = false }) {
  const list = (Array.isArray(readings) ? readings : []).filter((r) => r && isNum(r.value) && isNum(r.timestamp) && r.timestamp <= now);
  const pick = (from, to) => {
    let rows = list.filter((r) => r.timestamp > from && r.timestamp <= to && r.quality === "ok");
    if (daily) {
      const byDay = new Map();
      for (const r of rows) {
        const d = Math.floor(r.timestamp / DAY_MS);
        if (!byDay.has(d) || byDay.get(d).timestamp < r.timestamp) byDay.set(d, r);
      }
      rows = [...byDay.values()];
    }
    return rows;
  };
  const cur = pick(now - ms, now);
  const prev = pick(now - 2 * ms, now - ms);
  const avg = (rows) => (rows.length ? rows.reduce((s, r) => s + r.value, 0) / rows.length : null);
  const a = avg(cur);
  const p = avg(prev);
  const days = Math.max(1, Math.round(ms / DAY_MS));
  const daysWith = new Set(cur.map((r) => Math.floor(r.timestamp / DAY_MS))).size;
  const excluded = list.filter((r) => r.timestamp > now - ms && r.quality !== "ok");
  return {
    count: cur.length,
    average: round(a, decimals),
    min: cur.length ? round(Math.min(...cur.map((r) => r.value)), decimals) : null,
    max: cur.length ? round(Math.max(...cur.map((r) => r.value)), decimals) : null,
    previousAverage: round(p, decimals),
    changePercent: a !== null && p !== null && p !== 0 ? round(((a - p) / Math.abs(p)) * 100, 1) : null,
    baselineDeviationPercent: a !== null && isNum(baseline) && baseline !== 0 ? round(((a - baseline) / Math.abs(baseline)) * 100, 1) : null,
    daysWithoutData: ms >= DAY_MS ? Math.max(0, days - daysWith) : null,
    excludedReadings: { suspect: excluded.filter((r) => r.quality === "suspect").length, invalid: excluded.filter((r) => r.quality !== "suspect").length },
    missing: cur.length === 0,
  };
}

/** Check-in averages per window (self-reported scores). */
export function checkinStats(checkins, { now, ms }) {
  const list = (Array.isArray(checkins) ? checkins : []).filter((c) => c && isNum(c.timestamp) && c.timestamp <= now);
  const avgOf = (rows, f) => {
    const vals = rows.map((c) => c[f]).filter(isNum);
    return vals.length ? round(vals.reduce((s, v) => s + v, 0) / vals.length, 1) : null;
  };
  const cur = list.filter((c) => c.timestamp > now - ms);
  const prev = list.filter((c) => c.timestamp > now - 2 * ms && c.timestamp <= now - ms);
  const out = { count: cur.length, previousCount: prev.length, averages: {}, previousAverages: {} };
  for (const f of CHECKIN_FIELDS) {
    out.averages[f] = avgOf(cur, f);
    out.previousAverages[f] = avgOf(prev, f);
  }
  return out;
}

function presentAlerts(list, aid) {
  return (Array.isArray(list) ? list : [])
    .filter((a) => a && a.astronautId === aid && OPEN_ALERT_STATUSES.includes(a.status))
    .map((a) => ({
      number: isText(a.number) ? a.number : "",
      title: isText(a.title) ? a.title : "Alert",
      severity: SEVERITIES.includes(a.severity) ? a.severity : "info",
      status: a.status,
      category: isText(a.category) ? a.category : "",
      ruleId: isText(a.ruleId) ? a.ruleId : "",
      detectedAt: isNum(a.detectedAt) ? new Date(a.detectedAt).toISOString() : "",
      explanation: isText(a.explanation) ? a.explanation.slice(0, 300) : "",
    }));
}

/** TEST SEAM. */
export function createAiContextService({ repos }) {
  const nowOf = (options) => (options && options.now !== undefined ? options.now : Date.now());

  /** Everything the AI may know about one crew member (internal ids stay here). */
  async function memberContext(astronaut, { now, sharedOnly }) {
    const aid = astronaut.id;
    const from = now - 60 * DAY_MS; // 30-day window + its previous 30 days
    const [exerciseS, checkinsS, alertsS, ...metricS] = await Promise.allSettled([
      attempt(() => repos.eventsRepo.getRange({ astronautId: aid, fromTs: now - 14 * DAY_MS, toTs: now, types: ["exercise_logged"] })),
      attempt(() => repos.wellbeingRepo.getRange(aid, from, now)),
      attempt(() => repos.alertsRepo.query({ astronautId: aid })),
      ...AI_METRICS.map((m) => attempt(() => repos.measurementsRepo.getRange(aid, m.key, from, now))),
    ]);
    const metrics = {};
    AI_METRICS.forEach((m, i) => {
      const raw = valueOf(metricS[i]);
      if (raw === ERROR) {
        metrics[m.key] = { label: m.label, unit: m.unit, status: "unavailable" };
        return;
      }
      const rows = (Array.isArray(raw) ? raw : []).filter((r) => r && r.astronautId === aid && r.metric === m.key);
      const baseline = astronaut.baseline && isNum(astronaut.baseline[m.key]) ? astronaut.baseline[m.key] : null;
      const ok = rows.filter((r) => r.quality === "ok" && isNum(r.value)).sort((a, b) => a.timestamp - b.timestamp);
      const last = ok[ok.length - 1];
      metrics[m.key] = {
        label: m.label,
        unit: m.unit,
        baseline,
        latest: last ? { value: round(last.value, m.decimals), at: new Date(last.timestamp).toISOString(), source: last.source === "manual" ? "manual" : "simulated" } : null,
        windows: Object.fromEntries(AI_WINDOWS.map((w) => [w.key, windowStats(rows, { now, ms: w.ms, baseline, decimals: m.decimals, daily: m.key === "activity" })])),
      };
      if (m.key === "sleepDuration") {
        metrics[m.key].last7Nights = ok.filter((r) => r.timestamp > now - 7 * DAY_MS).map((r) => ({ date: new Date(r.timestamp).toISOString().slice(0, 10), hours: round(r.value, 1) }));
      }
    });
    const checkinsRaw = valueOf(checkinsS);
    const checkins = checkinsRaw === ERROR
      ? null
      : (Array.isArray(checkinsRaw) ? checkinsRaw : []).filter((c) => c && c.astronautId === aid && (!sharedOnly || c.sharedWithMedical === 1));
    const alertsRaw = valueOf(alertsS);
    const exRaw = valueOf(exerciseS);
    let exercise = { status: "unavailable" };
    if (exRaw !== ERROR) {
      const sessions = (Array.isArray(exRaw) ? exRaw : []).filter((e) => e && e.astronautId === aid && e.data).map((e) => ({ timestamp: e.timestamp, sessionType: e.data.sessionType, minutes: e.data.minutes, completion: e.data.completion, intensity: e.data.intensity }));
      const byDay = minutesByDay(sessions);
      const today = Math.floor(now / DAY_MS);
      const days = Array.from({ length: 14 }, (_, i) => today - 13 + i);
      exercise = {
        status: "ok",
        note: `Aerobic + resistance minutes per UTC day (target about ${EXERCISE_TARGET_MIN}; under ${MISSED_DAY_MIN} counts as missed — rule EX-01).`,
        minutesPerDay: days.map((d) => ({ date: new Date(d * DAY_MS).toISOString().slice(0, 10), minutes: byDay[d] || 0 })),
        todayMinutes: byDay[today] || 0,
        sessionsLast14Days: sessions.length,
        skippedLast14Days: sessions.filter((x) => x.completion === "skipped").length,
        partialLast14Days: sessions.filter((x) => x.completion === "partial").length,
      };
    }
    return {
      crewId: astronaut.crewId,
      name: astronaut.name,
      missionRole: astronaut.missionRole || "",
      metrics,
      checkins: checkins === null
        ? { status: "unavailable" }
        : {
            status: "ok",
            scope: sharedOnly ? "shared check-ins only (private check-ins are never included)" : "own check-ins (private and shared)",
            scales: "mood, sleepQuality, wellbeing 1–5 (higher is better); stress, fatigue, isolation 0–10 (higher is worse)",
            windows: Object.fromEntries(AI_WINDOWS.slice(1).map((w) => [w.key, checkinStats(checkins, { now, ms: w.ms })])),
          },
      openAlerts: alertsRaw === ERROR ? { status: "unavailable" } : { status: "ok", items: presentAlerts(alertsRaw, aid) },
      exercise,
    };
  }

  const envelope = (viewer, crewIds, now, extra) => ({
    viewer,
    crewIds,
    generatedAt: new Date(now).toISOString(),
    dataNote: "All records are synthetic demonstration data. Numbers were computed by the app; invalid and suspect readings are excluded. Alerts come from deterministic demonstration rules, not clinically validated.",
    windows: AI_WINDOWS.map((w) => w.label),
    ...extra,
  });

  return {
    async getAstronautAiContext(session, options = {}) {
      const now = nowOf(options);
      const who = await verifyAstronaut(session, repos, now);
      if (!who.ok) return who.refusal;
      const member = await memberContext(who.astronaut, { now, sharedOnly: false });
      return result("ready", "", now, { context: envelope("astronaut", [member.crewId], now, { member }) });
    },

    async getOfficerAiContext(session, options = {}) {
      const now = nowOf(options);
      const officer = await verifyMedicalOfficer(session, repos, now);
      if (!officer.ok) return officer.refusal;
      let all;
      try {
        all = await repos.astronautsRepo.getAll();
      } catch {
        return result("unavailable", "database_error", now);
      }
      const seen = new Set();
      const crew = (Array.isArray(all) ? all : [])
        .filter((a) => a && isText(a.id) && typeof a.crewId === "string" && CREW_ID_PATTERN.test(a.crewId) && !seen.has(a.crewId) && seen.add(a.crewId))
        .sort((a, b) => a.crewId.localeCompare(b.crewId));
      const members = [];
      for (const a of crew) {
        const b = a.baseline || {};
        members.push(await memberContext({ id: a.id, crewId: a.crewId, name: isText(a.name) ? a.name : a.crewId, missionRole: a.missionRole, baseline: b }, { now, sharedOnly: true }));
      }
      return result("ready", "", now, {
        crew: members.map((m) => ({ crewId: m.crewId, name: m.name })),
        context: envelope("officer", members.map((m) => m.crewId), now, { members }),
      });
    },
  };
}

const production = createAiContextService({
  repos: Object.freeze({ usersRepo, astronautsRepo, measurementsRepo, wellbeingRepo, alertsRepo, eventsRepo }),
});
export const getAstronautAiContext = (session, options) => production.getAstronautAiContext(session, options);
export const getOfficerAiContext = (session, options) => production.getOfficerAiContext(session, options);
