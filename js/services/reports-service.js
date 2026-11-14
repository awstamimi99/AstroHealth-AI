// js/services/reports-service.js — #/reports (Sprint 9). Reports are generated
// DYNAMICALLY and printed by the browser. Nothing is written: no reportsRepo
// record, no report_generated event, no settings, no other store.
//
//   getOwnHealthReport(session, { days }, options)                 astronaut
//   getCrewMemberHealthReport(session, "AH-03", { days }, options) Medical Officer
//   getCrewSummaryReport(session, { days }, options)               Medical Officer
//   listCrewForReportSelection(session, options)                   Medical Officer
//
// The service gathers sanitized inputs (no ids, no scores, no notes, no
// message text) and passes them, with an explicit generatedAt, to the PURE
// builders buildHealthReport() / buildCrewSummary(). Identical input + range +
// generatedAt → deeply equal models. Builders never read the clock.
//
// Provenance counts come only from actual raw measurement records with a
// canonical source (seed / simulation / manual), inside the last
// PROVENANCE_DAYS UTC days (raw-measurement retention). Older dates:
// "Source breakdown is unavailable for this period." Nothing is inferred.
//
// Test seam: createReportsService({ repos }).

import {
  usersRepo,
  astronautsRepo,
  measurementsRepo,
  dailySummariesRepo,
  alertsRepo,
  wellbeingRepo,
  simulationRunsRepo,
  messagesRepo,
  METRIC_UNITS,
  SEVERITIES,
  SOURCES,
  OPEN_ALERT_STATUSES,
  DAY_MS,
  toDateKey,
  startOfUtcDay,
} from "../db/index.js";
import { verifyAstronaut, verifyMedicalOfficer, resolveCrewMember, listCrewForSelection, CREW_ID_PATTERN } from "./access-control.js";

export const REPORT_RANGES = Object.freeze([7, 14, 30]);
export const DEFAULT_REPORT_RANGE = 7;
export const PROVENANCE_DAYS = 7;
export const REPORT_DISCLAIMER =
  "Synthetic data · research and educational prototype · not a medical device · not clinically validated · " +
  "not affiliated with or endorsed by NASA · not a diagnosis or treatment recommendation · does not determine fitness for duty.";
export const REPORT_EXCLUSIONS = Object.freeze([
  "Private journal",
  "Wellbeing scores",
  "Cognitive scores",
  "Alert explanations",
  "Medical Officer notes",
  "Message bodies and responses",
  "Passwords and session data",
  "Internal IDs",
]);
export const THRESHOLD_LIMITATION = "Demonstration threshold — not clinically validated.";
export const PROVENANCE_UNAVAILABLE = "Source breakdown is unavailable for this period.";
export const REPORT_METRICS = Object.freeze([
  { key: "heartRate", label: "Heart rate", decimals: 0 },
  { key: "spo2", label: "SpO₂", decimals: 0 },
  { key: "bpSystolic", label: "Blood pressure (systolic)", decimals: 0 },
  { key: "bpDiastolic", label: "Blood pressure (diastolic)", decimals: 0 },
  { key: "sleepDuration", label: "Sleep duration", decimals: 1 },
]);
const VITALS = ["heartRate", "spo2", "bpSystolic", "bpDiastolic"];

const isText = (v) => typeof v === "string" && v.trim() !== "";
const isTime = (v) => typeof v === "number" && Number.isFinite(v);
const isNum = isTime;
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const result = (status, reason, now, extra = {}) => ({ status, reason, generatedAt: now, ...extra });

/** Whole UTC days, inclusive, ending on the day of `now`. */
export function reportRange(days, now) {
  const fromTs = startOfUtcDay(now) - (days - 1) * DAY_MS;
  const toTs = startOfUtcDay(now) + DAY_MS - 1;
  const dates = [];
  for (let t = fromTs; t <= toTs; t += DAY_MS) dates.push(toDateKey(t));
  return { days, fromTs, toTs, from: dates[0], to: dates[dates.length - 1], dates };
}

const deepFreeze = (o) => {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
};

/** One metric's summary over the range (missing days stay missing). PURE. */
export function summarizeMetric(metric, summaries, dates, baseline) {
  const byDate = new Map();
  for (const s of Array.isArray(summaries) ? summaries : []) {
    if (s && s.metric === metric.key && dates.includes(s.date) && Number.isInteger(s.count) && s.count > 0 && [s.avg, s.min, s.max].every(isNum)) byDate.set(s.date, s);
  }
  const present = dates.filter((d) => byDate.has(d)).map((d) => byDate.get(d));
  const average = present.length ? round(present.reduce((sum, s) => sum + s.avg, 0) / present.length, metric.decimals + 1) : null;
  const base = isNum(baseline) ? baseline : null;
  return {
    key: metric.key,
    label: metric.label,
    unit: METRIC_UNITS[metric.key],
    daysWithData: present.length,
    missingDays: dates.length - present.length,
    average,
    min: present.length ? Math.min(...present.map((s) => s.min)) : null,
    max: present.length ? Math.max(...present.map((s) => s.max)) : null,
    baseline: base,
    differenceFromBaseline: average !== null && base !== null ? round(average - base, metric.decimals + 1) : null,
  };
}

/**
 * PURE builder for astronaut_health. `input` is already sanitized by the service:
 *   { profile:{crewId,name,missionRole}, baseline:{metric:number|null}, summaries:{metric:[…]},
 *     alerts:[{number,title,severity,status,ruleId,ruleVersion}], counts:{checkins:{total?,shared}, simulationRuns, messages},
 *     provenance:{ status:"ok"|"error", counts:{seed,simulation,manual,notRecorded}, suspect, invalid } | null,
 *     sections:{ summaries, alerts, counts, provenance } (status per section) }
 */
export function buildHealthReport(rawInput, range, generatedAt, viewer) {
  if (!isTime(generatedAt)) throw new RangeError("buildHealthReport: generatedAt must be a finite number");
  const input = structuredClone(rawInput); // never freeze or alter the caller's objects
  const provStart = Math.max(range.fromTs, startOfUtcDay(generatedAt) - (PROVENANCE_DAYS - 1) * DAY_MS);
  const metrics = REPORT_METRICS.map((m) => {
    const list = input.summaries[m.key];
    if (list === null) return { key: m.key, label: m.label, unit: METRIC_UNITS[m.key], status: "error" };
    return { status: "ok", ...summarizeMetric(m, list, range.dates, input.baseline[m.key]) };
  });
  return deepFreeze({
    type: "astronaut_health",
    title: `Health summary · ${input.profile.crewId}`,
    viewer,
    generatedAt,
    period: { days: range.days, from: range.from, to: range.to },
    subject: { ...input.profile },
    metrics,
    alerts: input.alerts === null
      ? { status: "error", items: [] }
      : { status: "ok", items: [...input.alerts].sort((a, b) => b.detectedAt - a.detectedAt || String(a.number).localeCompare(String(b.number))).map((a) => ({ ...a, limitation: THRESHOLD_LIMITATION })) },
    activity: input.counts,
    provenance: {
      window: { from: toDateKey(provStart), to: range.to },
      olderUnavailable: provStart > range.fromTs ? { from: range.from, to: toDateKey(provStart - DAY_MS), text: PROVENANCE_UNAVAILABLE } : null,
      ...(input.provenance || { status: "error" }),
    },
    disclaimer: REPORT_DISCLAIMER,
    excluded: [...REPORT_EXCLUSIONS],
  });
}

/** PURE builder for crew_summary. */
export function buildCrewSummary(rawMembers, range, generatedAt) {
  if (!isTime(generatedAt)) throw new RangeError("buildCrewSummary: generatedAt must be a finite number");
  const members = structuredClone(rawMembers);
  return deepFreeze({
    type: "crew_summary",
    title: "Crew summary",
    viewer: "officer",
    generatedAt,
    period: { days: range.days, from: range.from, to: range.to },
    members: [...members].sort((a, b) => a.crewId.localeCompare(b.crewId)).map((m) => ({ ...m })),
    disclaimer: REPORT_DISCLAIMER,
    excluded: [...REPORT_EXCLUSIONS],
  });
}

/** TEST SEAM. Pages use the exported functions below. */
export function createReportsService({ repos }) {
  const nowOf = (options) => (options && options.now !== undefined ? options.now : Date.now());
  const daysOf = (input) => (input && input.days !== undefined ? input.days : DEFAULT_REPORT_RANGE);
  const settled = async (fn) => {
    try {
      return await fn();
    } catch {
      return null;
    }
  };

  async function gatherHealth(astronaut, viewer, range, now) {
    const aid = astronaut.id;
    const own = (list) => (Array.isArray(list) ? list.filter((x) => x && x.astronautId === aid) : []);
    const summaries = {};
    await Promise.all(REPORT_METRICS.map(async (m) => {
      summaries[m.key] = await settled(async () => own(await repos.dailySummariesRepo.getRange(aid, m.key, range.from, range.to)));
    }));
    const alerts = await settled(async () =>
      own(await repos.alertsRepo.query({ astronautId: aid, fromTs: range.fromTs, toTs: range.toTs }))
        .filter((a) => isText(a.number) && isTime(a.detectedAt) && a.detectedAt >= range.fromTs && a.detectedAt <= range.toTs)
        .map((a) => ({
          number: a.number,
          title: isText(a.title) ? a.title.trim() : isText(a.type) ? a.type.replace(/[_-]+/g, " ") : "Alert",
          severity: SEVERITIES.includes(a.severity) ? a.severity : "info",
          status: ["new", "acknowledged", "resolved"].includes(a.status) ? a.status : "unknown",
          detectedAt: a.detectedAt,
          ruleId: isText(a.ruleId) ? a.ruleId : "",
          ruleVersion: a.rule && Number.isInteger(a.rule.version) ? a.rule.version : null,
        })));
    // Activity counts (no scores, no text).
    const checkins = await settled(async () => {
      if (viewer === "astronaut") {
        const list = own(await repos.wellbeingRepo.getRange(aid, range.fromTs, range.toTs));
        return { status: "ok", total: list.length, shared: list.filter((w) => w.sharedWithMedical === 1).length };
      }
      const list = own(await repos.wellbeingRepo.getSharedRange(range.fromTs, range.toTs)).filter((w) => w.sharedWithMedical === 1);
      return { status: "ok", shared: list.length }; // officers never learn about private check-ins
    });
    const runs = await settled(async () => own(await repos.simulationRunsRepo.getByAstronaut(aid)).filter((r) => isTime(r.startedAt) && r.startedAt >= range.fromTs && r.startedAt <= range.toTs).length);
    const messages = await settled(async () => own(await repos.messagesRepo.getByAstronaut(aid)).filter((m) => isTime(m.sentAt) && m.sentAt >= range.fromTs && m.sentAt <= range.toTs).length);
    // Provenance: verified sources from raw retained measurements only.
    const provFrom = Math.max(range.fromTs, startOfUtcDay(now) - (PROVENANCE_DAYS - 1) * DAY_MS);
    const provenance = await settled(async () => {
      const counts = { seed: 0, simulation: 0, manual: 0, notRecorded: 0 };
      let suspect = 0;
      let invalid = 0;
      for (const m of REPORT_METRICS) {
        for (const r of own(await repos.measurementsRepo.getRange(aid, m.key, provFrom, range.toTs))) {
          if (!isTime(r.timestamp) || r.timestamp < provFrom || r.timestamp > range.toTs) continue;
          if (SOURCES.includes(r.source)) counts[r.source] += 1;
          else counts.notRecorded += 1;
          if (r.quality === "suspect") suspect += 1;
          else if (r.quality === "invalid") invalid += 1;
        }
      }
      return { status: "ok", counts, suspect, invalid };
    });
    return {
      profile: { crewId: astronaut.crewId, name: astronaut.name, missionRole: astronaut.missionRole },
      baseline: { ...astronaut.baseline },
      summaries,
      alerts,
      counts: {
        checkins: checkins || { status: "error" },
        simulationRuns: runs === null ? { status: "error" } : { status: "ok", count: runs },
        messages: messages === null ? { status: "error" } : { status: "ok", count: messages },
      },
      provenance,
    };
  }

  async function health(astronaut, viewer, input, now) {
    const days = daysOf(input);
    if (!REPORT_RANGES.includes(days)) return result("invalid", "invalid_range", now);
    const range = reportRange(days, now);
    const data = await gatherHealth(astronaut, viewer, range, now);
    const failed = REPORT_METRICS.every((m) => data.summaries[m.key] === null) && data.alerts === null;
    if (failed) return result("unavailable", "database_error", now);
    return result("ready", "", now, { report: buildHealthReport(data, range, now, viewer) });
  }

  return {
    async getOwnHealthReport(session, input = {}, options = {}) {
      const now = nowOf(options);
      if (!isTime(now)) return result("invalid", "invalid_time", Date.now());
      const who = await verifyAstronaut(session, repos, now);
      if (!who.ok) return who.refusal;
      return health(who.astronaut, "astronaut", input, now);
    },
    async getCrewMemberHealthReport(session, crewId, input = {}, options = {}) {
      const now = nowOf(options);
      if (!isTime(now)) return result("invalid", "invalid_time", Date.now());
      const officer = await verifyMedicalOfficer(session, repos, now);
      if (!officer.ok) return officer.refusal;
      const member = await resolveCrewMember(repos, crewId, now);
      if (!member.ok) return member.refusal;
      return health(member.astronaut, "officer", input, now);
    },
    async getCrewSummaryReport(session, input = {}, options = {}) {
      const now = nowOf(options);
      if (!isTime(now)) return result("invalid", "invalid_time", Date.now());
      const officer = await verifyMedicalOfficer(session, repos, now);
      if (!officer.ok) return officer.refusal;
      const days = daysOf(input);
      if (!REPORT_RANGES.includes(days)) return result("invalid", "invalid_range", now);
      const range = reportRange(days, now);
      let all;
      let openAlerts;
      let shared;
      try {
        [all, openAlerts, shared] = await Promise.all([
          repos.astronautsRepo.getAll(),
          repos.alertsRepo.query({ status: [...OPEN_ALERT_STATUSES] }),
          repos.wellbeingRepo.getSharedRange(range.fromTs, range.toTs),
        ]);
      } catch {
        return result("unavailable", "database_error", now);
      }
      const seen = new Set();
      const crew = (Array.isArray(all) ? all : []).filter((a) => a && isText(a.id) && typeof a.crewId === "string" && CREW_ID_PATTERN.test(a.crewId) && !seen.has(a.crewId) && seen.add(a.crewId));
      const members = [];
      for (const a of crew) {
        const open = (Array.isArray(openAlerts) ? openAlerts : []).filter((x) => x && x.astronautId === a.id && OPEN_ALERT_STATUSES.includes(x.status));
        const latest = await settled(async () => {
          let best = 0;
          for (const metric of VITALS) {
            for (const r of await repos.measurementsRepo.getRecent(a.id, metric, 12)) {
              if (r && r.astronautId === a.id && r.quality !== "invalid" && isTime(r.timestamp) && r.timestamp <= now && r.timestamp > best) best = r.timestamp;
            }
          }
          return best;
        });
        const days = await settled(async () => {
          const set = new Set();
          for (const m of REPORT_METRICS) {
            for (const s of await repos.dailySummariesRepo.getRange(a.id, m.key, range.from, range.to)) if (s && s.astronautId === a.id && Number.isInteger(s.count) && s.count > 0 && range.dates.includes(s.date)) set.add(s.date);
          }
          return set.size;
        });
        members.push({
          crewId: a.crewId,
          name: isText(a.name) ? a.name : a.crewId,
          openAlerts: Object.fromEntries(SEVERITIES.map((sev) => [sev, open.filter((x) => x.severity === sev).length])),
          openTotal: open.length,
          latestVitalAt: latest === null ? { status: "error" } : { status: "ok", at: latest || 0 },
          daysWithData: days === null ? { status: "error" } : { status: "ok", count: days, of: range.days },
          sharedCheckins: (Array.isArray(shared) ? shared : []).filter((w) => w && w.astronautId === a.id && w.sharedWithMedical === 1 && isTime(w.timestamp) && w.timestamp >= range.fromTs && w.timestamp <= range.toTs).length,
        });
      }
      return result("ready", "", now, { report: buildCrewSummary(members, range, now) });
    },
    async listCrewForReportSelection(session, options = {}) {
      return listCrewForSelection(session, repos, nowOf(options));
    },
  };
}

const production = createReportsService({
  repos: Object.freeze({ usersRepo, astronautsRepo, measurementsRepo, dailySummariesRepo, alertsRepo, wellbeingRepo, simulationRunsRepo, messagesRepo }),
});
export const getOwnHealthReport = (session, input, options) => production.getOwnHealthReport(session, input, options);
export const getCrewMemberHealthReport = (session, crewId, input, options) => production.getCrewMemberHealthReport(session, crewId, input, options);
export const getCrewSummaryReport = (session, input, options) => production.getCrewSummaryReport(session, input, options);
export const listCrewForReportSelection = (session, options) => production.listCrewForReportSelection(session, options);
