// js/services/physical-health-service.js — #/physical (Sprint 6), read-only.
//
//   getOwnPhysicalHealth(session)                  astronaut: own data only
//   getCrewMemberPhysicalHealth(session, "AH-04")  Medical Officer: one astronaut
//   listCrewForPhysicalSelection(session)          Medical Officer: picker
//
// Readings: heart rate, SpO₂, blood pressure (paired by sampleId), sleep.
// No daily steps (deferred, D10). No thresholds, no normal/abnormal labels:
// the only comparison is a NUMERIC difference from the astronaut's stored
// personal baseline, which is descriptive, not a clinical assessment.
// Trends use the stored daily summaries (min/max/avg per UTC day; they
// include readings marked suspect and exclude invalid ones). Missing days
// stay missing. Alerts: stored OPEN alerts in the "physical" category only.
//
// Identity: js/services/access-control.js (verified BEFORE any health read).
// Every record is re-filtered to the verified astronaut. Never throws for
// expected repository failures; bugs in this file's own logic are not hidden.
// Test seam: createPhysicalHealthService({ repos }).

import {
  usersRepo,
  astronautsRepo,
  measurementsRepo,
  dailySummariesRepo,
  alertsRepo,
  METRIC_UNITS,
  OPEN_ALERT_STATUSES,
  SEVERITIES,
  toDateKey,
} from "../db/index.js";
import { verifyAstronaut, verifyMedicalOfficer, resolveCrewMember, listCrewForSelection } from "./access-control.js";
import {
  selectLatestUsable,
  pairBloodPressure,
  lastUtcDates,
  VITALS_STALE_MS,
  SLEEP_STALE_MS,
  RECENT_READINGS_LIMIT,
} from "./astronaut-overview-service.js";
import { compareAlerts } from "./crew-monitor-service.js";

export const TREND_WINDOWS = Object.freeze([7, 30]);
export const BASELINE_NOTE = "A numeric comparison with the stored personal baseline. Descriptive only — not a clinical assessment.";
export const TREND_NOTE = "Daily values come from stored daily summaries. They include readings marked suspect; invalid readings are excluded.";

const TREND_METRICS = Object.freeze([
  { key: "heartRate", label: "Heart rate", decimals: 0 },
  { key: "spo2", label: "SpO₂", decimals: 0 },
  { key: "bpSystolic", label: "Blood pressure (systolic)", decimals: 0 },
  { key: "bpDiastolic", label: "Blood pressure (diastolic)", decimals: 0 },
  { key: "sleepDuration", label: "Sleep duration", decimals: 1 },
  { key: "bodyTemperature", label: "Body temperature", decimals: 1 },
]);

const ERROR = Symbol("error");
const valueOf = (s) => (s.status === "fulfilled" ? s.value : ERROR);
const attempt = (fn) => Promise.resolve().then(fn);
const isText = (v) => typeof v === "string" && v.trim() !== "";
const round = (v, decimals) => Math.round(v * 10 ** decimals) / 10 ** decimals;

/** value − baseline, rounded to the metric's precision (null when either is missing). */
export function baselineDifference(value, baseline, decimals = 0) {
  if (typeof value !== "number" || !Number.isFinite(value) || typeof baseline !== "number" || !Number.isFinite(baseline)) return null;
  return round(value - baseline, decimals);
}

/**
 * One metric's trend over the last 30 UTC days (oldest first) plus 7- and
 * 30-day summaries. Missing days are { date, missing: true } — never 0.
 */
export function buildTrend(summaries, metric, baseline, now) {
  const dates = lastUtcDates(toDateKey(now), 30);
  const byDate = new Map();
  for (const s of Array.isArray(summaries) ? summaries : []) {
    if (s && s.metric === metric.key && dates.includes(s.date) && s.count > 0 && [s.avg, s.min, s.max].every((v) => typeof v === "number" && Number.isFinite(v))) {
      byDate.set(s.date, { date: s.date, avg: round(s.avg, metric.decimals === 0 ? 1 : 2), min: s.min, max: s.max, count: s.count });
    }
  }
  const days = dates.map((date) => byDate.get(date) || { date, missing: true });
  const windows = {};
  for (const n of TREND_WINDOWS) {
    const slice = days.slice(-n).filter((d) => !d.missing);
    const average = slice.length ? round(slice.reduce((sum, d) => sum + d.avg, 0) / slice.length, metric.decimals === 0 ? 1 : 2) : null;
    windows[n] = {
      days: n,
      daysWithData: slice.length,
      missingDays: n - slice.length,
      average,
      differenceFromBaseline: average === null ? null : baselineDifference(average, baseline, metric.decimals === 0 ? 1 : 2),
    };
  }
  return { key: metric.key, label: metric.label, unit: METRIC_UNITS[metric.key], baseline, days, windows };
}

function presentAlert(a) {
  return {
    number: isText(a.number) ? a.number : "",
    title: isText(a.title) ? a.title.trim() : isText(a.type) ? a.type.replace(/[_-]+/g, " ") : "Alert",
    severity: SEVERITIES.includes(a.severity) ? a.severity : "info",
    status: a.status,
    detectedAt: typeof a.detectedAt === "number" && Number.isFinite(a.detectedAt) ? a.detectedAt : 0,
    explanation: isText(a.explanation) ? a.explanation : "",
    synthetic: true,
  };
}

/** Everything #/physical shows for ONE verified astronaut. */
async function buildPhysical(repos, astronaut, viewer, now) {
  const aid = astronaut.id;
  const dates = lastUtcDates(toDateKey(now), 30);
  const from = dates[0];
  const to = dates[dates.length - 1];
  const keys = ["heartRate", "spo2", "bpSystolic", "bpDiastolic", "sleepDuration", "bodyTemperature", "sum:heartRate", "sum:spo2", "sum:bpSystolic", "sum:bpDiastolic", "sum:sleepDuration", "sum:bodyTemperature", "alerts"];
  const settled = await Promise.allSettled([
    ...["heartRate", "spo2", "bpSystolic", "bpDiastolic", "sleepDuration", "bodyTemperature"].map((m) => attempt(() => repos.measurementsRepo.getRecent(aid, m, RECENT_READINGS_LIMIT))),
    ...TREND_METRICS.map((m) => attempt(() => repos.dailySummariesRepo.getRange(aid, m.key, from, to))),
    attempt(() => repos.alertsRepo.query({ astronautId: aid, status: [...OPEN_ALERT_STATUSES] })),
  ]);
  const r = Object.fromEntries(keys.map((k, i) => [k, valueOf(settled[i])]));
  const own = (list) => (Array.isArray(list) ? list.filter((x) => x && x.astronautId === aid) : []);
  const b = astronaut.baseline;

  // Latest readings (same rules as the Overview), plus a numeric baseline difference.
  const card = (key, label, metric, staleMs, decimals) => {
    const base = { key, label, unit: METRIC_UNITS[metric], baseline: b[metric] };
    if (r[metric] === ERROR) return { ...base, state: "error" };
    const item = { ...base, ...selectLatestUsable(own(r[metric]), { now, staleMs }) };
    return item.state === "ok" ? { ...item, differenceFromBaseline: baselineDifference(item.value, b[metric], decimals) } : item;
  };
  const bpBaseline = b.bpSystolic !== null && b.bpDiastolic !== null ? { systolic: b.bpSystolic, diastolic: b.bpDiastolic } : null;
  let bp;
  if (r.bpSystolic === ERROR || r.bpDiastolic === ERROR) bp = { key: "bloodPressure", label: "Blood pressure", unit: METRIC_UNITS.bpSystolic, baseline: bpBaseline, state: "error" };
  else {
    bp = { key: "bloodPressure", label: "Blood pressure", unit: METRIC_UNITS.bpSystolic, baseline: bpBaseline, ...pairBloodPressure(own(r.bpSystolic), own(r.bpDiastolic), { now, staleMs: VITALS_STALE_MS }) };
    if (bp.state === "ok") {
      bp.differenceFromBaseline = { systolic: baselineDifference(bp.systolic, b.bpSystolic), diastolic: baselineDifference(bp.diastolic, b.bpDiastolic) };
    }
  }
  const latest = [
    card("heartRate", "Heart rate", "heartRate", VITALS_STALE_MS, 0),
    card("spo2", "SpO₂", "spo2", VITALS_STALE_MS, 0),
    bp,
    card("sleepDuration", "Sleep duration", "sleepDuration", SLEEP_STALE_MS, 1),
    card("bodyTemperature", "Body temperature", "bodyTemperature", VITALS_STALE_MS, 1),
  ];
  const failedLatest = latest.filter((i) => i.state === "error").length;

  // Trends (30 days, with 7- and 30-day summaries).
  const trends = TREND_METRICS.map((m) => {
    const list = r[`sum:${m.key}`];
    if (list === ERROR) return { key: m.key, label: m.label, unit: METRIC_UNITS[m.key], status: "error" };
    return { status: "ok", ...buildTrend(own(list), m, b[m.key], now) };
  });

  // Data quality per measure: latest state + missing days in the 30-day window.
  const trendByKey = Object.fromEntries(trends.map((t) => [t.key, t]));
  const missingOf = (keysForCard) => {
    const ts = keysForCard.map((k) => trendByKey[k]);
    if (ts.some((t) => t.status !== "ok")) return null;
    return Math.max(...ts.map((t) => t.windows[30].missingDays));
  };
  const quality = latest.map((item) => ({
    key: item.key,
    label: item.label,
    state: item.state,
    suspect: item.state === "ok" && item.quality === "suspect",
    stale: item.state === "ok" && Boolean(item.stale),
    missingDays30: missingOf(item.key === "bloodPressure" ? ["bpSystolic", "bpDiastolic"] : [item.key]),
  }));

  const alerts =
    r.alerts === ERROR
      ? { status: "error", items: [] }
      : { status: "ok", items: own(r.alerts).filter((a) => OPEN_ALERT_STATUSES.includes(a.status) && a.category === "physical").sort(compareAlerts).map(presentAlert) };

  return {
    status: "ready",
    reason: "",
    generatedAt: now,
    today: toDateKey(now),
    viewer,
    profile: { crewId: astronaut.crewId, name: astronaut.name, missionRole: astronaut.missionRole, baseline: { ...b } },
    latest: { status: failedLatest === 0 ? "ok" : failedLatest === latest.length ? "error" : "partial", items: latest },
    trends: { windows: [...TREND_WINDOWS], note: TREND_NOTE, metrics: trends },
    quality: { items: quality },
    alerts,
    baselineNote: BASELINE_NOTE,
  };
}

/** TEST SEAM. Pages use the exported functions below. */
export function createPhysicalHealthService({ repos }) {
  const nowOf = (options) => (options && Number.isFinite(options.now) ? options.now : Date.now());
  return {
    /** Astronaut: own physical data only. Any id in options is ignored. */
    async getOwnPhysicalHealth(session, options = {}) {
      const now = nowOf(options);
      const who = await verifyAstronaut(session, repos, now);
      if (!who.ok) return who.refusal;
      return buildPhysical(repos, who.astronaut, "astronaut", now);
    },
    /** Medical Officer: one crew member, after officer verification. */
    async getCrewMemberPhysicalHealth(session, crewId, options = {}) {
      const now = nowOf(options);
      const officer = await verifyMedicalOfficer(session, repos, now);
      if (!officer.ok) return officer.refusal;
      const member = await resolveCrewMember(repos, crewId, now);
      if (!member.ok) return member.refusal;
      return buildPhysical(repos, member.astronaut, "officer", now);
    },
    /** Medical Officer: picker (names + public crew IDs only). */
    async listCrewForPhysicalSelection(session, options = {}) {
      return listCrewForSelection(session, repos, nowOf(options));
    },
  };
}

const production = createPhysicalHealthService({
  repos: Object.freeze({ usersRepo, astronautsRepo, measurementsRepo, dailySummariesRepo, alertsRepo }),
});
export const getOwnPhysicalHealth = (session, options) => production.getOwnPhysicalHealth(session, options);
export const getCrewMemberPhysicalHealth = (session, crewId, options) => production.getCrewMemberPhysicalHealth(session, crewId, options);
export const listCrewForPhysicalSelection = (session, options) => production.listCrewForPhysicalSelection(session, options);
