// js/services/history-service.js — #/history (Sprint 9), read-only.
//
//   getOwnHistory(session, { days }, options)                astronaut: own history
//   getCrewMemberHistory(session, "AH-03", { days }, options) Medical Officer
//   listCrewForHistorySelection(session, options)             Medical Officer picker
//
// The timeline is built from missionEvents, but stored `summary` and `data`
// are NEVER returned or rendered. Every visible line is written here by an
// explicit allow-list (describeEvent) that reads only narrowly validated
// fields. Unknown and excluded event types are omitted.
//
// Never output: wellbeing scores, cognitive scores / reaction times, message
// bodies, astronaut response text, alert explanations, Medical Officer notes,
// internal record ids, user ids, session data or arbitrary event data.
//
// Snapshot: one deterministic, sanitized snapshot per request — eligible
// events in the UTC range, sorted (timestamp desc, category rank, internal
// id), capped at HISTORY_LIMIT; internal ids are dropped before returning.
// The page reveals PAGE_SIZE entries at a time from that snapshot.
//
// Provenance (never inferred): "simulation" only when the event references a
// stored simulation run of this astronaut; otherwise "not_recorded" for
// reading entries. Other categories carry no provenance label.
//
// Writes nothing. Test seam: createHistoryService({ repos, scenarios }).

import {
  usersRepo,
  astronautsRepo,
  eventsRepo,
  alertsRepo,
  simulationRunsRepo,
  METRICS,
  METRIC_UNITS,
  SEVERITIES,
  DAY_MS,
  toDateKey,
  startOfUtcDay,
} from "../db/index.js";
import { verifyAstronaut, verifyMedicalOfficer, resolveCrewMember, listCrewForSelection } from "./access-control.js";
import { SCENARIOS } from "../simulation/scenarios.js";

export const HISTORY_RANGES = Object.freeze([7, 14, 30]);
export const DEFAULT_RANGE = 7;
export const HISTORY_LIMIT = 500;
export const PAGE_SIZE = 100;
export const CATEGORIES = Object.freeze(["readings", "wellbeing", "alerts", "messages", "simulation"]);
export const CATEGORY_LABELS = Object.freeze({ readings: "Readings", wellbeing: "Wellbeing activity", alerts: "Alerts", messages: "Messages", simulation: "Simulation" });
const CATEGORY_RANK = Object.freeze({ alerts: 0, simulation: 1, readings: 2, wellbeing: 3, messages: 4 });

export const MESSAGE_TEMPLATES = Object.freeze({ rest_and_reassess: "Rest and reassess", check_vital_signs: "Check vital signs" });
const METRIC_LABELS = Object.freeze({ heartRate: "Heart rate", spo2: "SpO₂", bpSystolic: "Systolic blood pressure", bpDiastolic: "Diastolic blood pressure", sleepDuration: "Sleep duration", activity: "Activity", fatigue: "Fatigue" });

const isText = (v) => typeof v === "string" && v.trim() !== "";
const isTime = (v) => typeof v === "number" && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const fmt = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10));
const result = (status, reason, now, extra = {}) => ({ status, reason, generatedAt: now, ...extra });

/** Whole UTC days, inclusive: the last `days` days ending today. */
export function historyRange(days, now) {
  const start = startOfUtcDay(now) - (days - 1) * DAY_MS;
  const end = startOfUtcDay(now) + DAY_MS - 1;
  return { days, fromTs: start, toTs: end, from: toDateKey(start), to: toDateKey(end) };
}

/** A validated reading { metric, value, unit } from event data, or null. */
function readingFrom(data) {
  if (!isObj(data) || !METRICS.includes(data.metric) || !isTime(data.value)) return null;
  const unit = METRIC_UNITS[data.metric];
  if (data.unit !== undefined && data.unit !== unit) return null;
  return { metric: data.metric, value: data.value, unit };
}

/**
 * The allow-list. Returns a sanitized entry (no ids) or null to omit the event.
 * @param {object} e        a stored missionEvents record
 * @param {object} ctx      { viewer: "astronaut"|"officer", alertsById: Map|null, runsById: Map|null, scenarioName }
 */
export function describeEvent(e, ctx) {
  if (!isObj(e) || !isText(e.type) || !isTime(e.timestamp)) return null;
  const d = isObj(e.data) ? e.data : {};
  const base = (category, text, extra = {}) => ({ timestamp: e.timestamp, day: toDateKey(e.timestamp), category, kind: e.type, text, alertNumber: "", provenance: null, ...extra });
  const run = () => (e.refStore === "simulationRuns" && ctx.runsById && isText(e.refId) ? ctx.runsById.get(e.refId) || null : null);
  const alertRef = () => {
    if (e.refStore !== "alerts" || !ctx.alertsById || !isText(e.refId)) return null;
    const a = ctx.alertsById.get(e.refId);
    return a && isText(a.number) ? a : null;
  };

  switch (e.type) {
    case "measurement_recorded": {
      const r = run();
      if (r) {
        const reading = readingFrom(d);
        const step = Number.isInteger(d.step) && d.step > 0 ? d.step : null;
        const text = reading ? `Simulated reading: ${METRIC_LABELS[reading.metric]} ${fmt(reading.value)} ${reading.unit}${step ? ` (step ${step})` : ""}` : "Simulated reading recorded";
        return base("readings", text, { provenance: "simulation" });
      }
      if (Number.isInteger(d.samples) && d.samples > 0) return base("readings", `${d.samples} vital-sign sample${d.samples === 1 ? "" : "s"} recorded`, { provenance: "not_recorded" });
      const reading = readingFrom(d);
      if (reading) return base("readings", `${METRIC_LABELS[reading.metric]} recorded: ${fmt(reading.value)} ${reading.unit}`, { provenance: "not_recorded" });
      return base("readings", "Reading recorded", { provenance: "not_recorded" });
    }
    case "checkin_completed": {
      if (d.shared === 1) return base("wellbeing", "Daily check-in completed · shared");
      if (d.shared === 0 && ctx.viewer === "astronaut") return base("wellbeing", "Daily check-in completed · private");
      return null; // officers never learn that a private check-in exists; unknown share state → omitted
    }
    case "cognitive_check_completed":
      return base("wellbeing", "Cognitive check completed");
    case "risk_detected":
    case "alert_generated":
    case "alert_escalated":
    case "alert_condition_cleared":
    case "alert_acknowledged":
    case "alert_resolved": {
      const a = alertRef();
      const name = a ? `${a.number}${isText(a.title) ? ` ${a.title.trim()}` : ""}` : "an alert";
      const sev = SEVERITIES.includes(d.severity) ? d.severity : null;
      const text = {
        risk_detected: `Demonstration rule matched for ${name}`,
        alert_generated: `${name} opened${sev ? ` (${sev})` : ""}`,
        alert_escalated: `${name} escalated${sev ? ` to ${sev}` : ""}`,
        alert_condition_cleared: `${name}: condition cleared`,
        alert_acknowledged: `${name} acknowledged by the Medical Officer`,
        alert_resolved: `${name} resolved by the Medical Officer`,
      }[e.type];
      return base("alerts", text.charAt(0).toUpperCase() + text.slice(1), { alertNumber: a ? a.number : "" });
    }
    case "message_sent": {
      const label = MESSAGE_TEMPLATES[d.templateId];
      return base("messages", label ? `Message from the Medical Officer: ${label}` : "Message from the Medical Officer");
    }
    case "message_acknowledged":
      return base("messages", "Message acknowledged");
    case "astronaut_response":
      return base("messages", "Response sent");
    case "simulation_started":
    case "simulation_paused":
    case "simulation_stopped": {
      const r = run();
      const scenario = r ? ctx.scenarioName(r.scenarioId) : "";
      const verb =
        e.type === "simulation_paused" ? "paused"
        : e.type === "simulation_started" ? (d.phase === "resumed" ? "resumed" : "started")
        : d.outcome === "completed" ? "completed" : "stopped";
      return base("simulation", `Simulation ${verb}${scenario ? `: ${scenario}` : ""}`, { provenance: r ? "simulation" : "not_recorded" });
    }
    default:
      return null; // settings_changed, report_generated, data_reset, data_imported, unknown types
  }
}

/** Deterministic order: newest first, then category rank, then the internal tie-breaker. */
function compareRaw(a, b) {
  return b.entry.timestamp - a.entry.timestamp || CATEGORY_RANK[a.entry.category] - CATEGORY_RANK[b.entry.category] || (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0);
}

/** TEST SEAM. Pages use the exported functions below. */
export function createHistoryService({ repos, scenarios = SCENARIOS }) {
  const nowOf = (options) => (options && options.now !== undefined ? options.now : Date.now());
  const scenarioName = (id) => (scenarios.find((s) => s.id === id) || {}).name || "";

  async function build(astronaut, viewer, filters, now) {
    const days = filters && filters.days !== undefined ? filters.days : DEFAULT_RANGE;
    if (!HISTORY_RANGES.includes(days)) return result("invalid", "invalid_range", now);
    const range = historyRange(days, now);
    const aid = astronaut.id;
    let events;
    try {
      events = await repos.eventsRepo.getRange({ astronautId: aid, fromTs: range.fromTs, toTs: range.toTs });
    } catch {
      return result("unavailable", "database_error", now);
    }
    const [alertsS, runsS] = await Promise.allSettled([repos.alertsRepo.query({ astronautId: aid }), repos.simulationRunsRepo.getByAstronaut(aid)]);
    const alertsById = alertsS.status === "fulfilled" ? new Map((Array.isArray(alertsS.value) ? alertsS.value : []).filter((a) => a && a.astronautId === aid && isText(a.id)).map((a) => [a.id, a])) : null;
    const runsById = runsS.status === "fulfilled" ? new Map((Array.isArray(runsS.value) ? runsS.value : []).filter((r) => r && r.astronautId === aid && isText(r.id)).map((r) => [r.id, r])) : null;
    const ctx = { viewer, alertsById, runsById, scenarioName };

    const raw = [];
    for (const e of Array.isArray(events) ? events : []) {
      if (!e || e.astronautId !== aid || e.timestamp < range.fromTs || e.timestamp > range.toTs) continue;
      const entry = describeEvent(e, ctx);
      if (entry) raw.push({ entry, tie: String(e.id) });
    }
    raw.sort(compareRaw);
    const entries = raw.slice(0, HISTORY_LIMIT).map((x) => Object.freeze({ ...x.entry }));
    return result("ready", "", now, {
      viewer,
      profile: { crewId: astronaut.crewId, name: astronaut.name, missionRole: astronaut.missionRole },
      range: { days: range.days, from: range.from, to: range.to, fromTs: range.fromTs, toTs: range.toTs },
      ranges: [...HISTORY_RANGES],
      categories: CATEGORIES.map((c) => ({ id: c, label: CATEGORY_LABELS[c] })),
      entries,
      totalAvailable: raw.length,
      returnedCount: entries.length,
      truncated: raw.length > HISTORY_LIMIT,
      pageSize: PAGE_SIZE,
      partial: { alerts: alertsById === null, simulation: runsById === null },
    });
  }

  return {
    async getOwnHistory(session, filters = {}, options = {}) {
      const now = nowOf(options);
      const who = await verifyAstronaut(session, repos, now);
      if (!who.ok) return who.refusal;
      return build(who.astronaut, "astronaut", filters, now);
    },
    async getCrewMemberHistory(session, crewId, filters = {}, options = {}) {
      const now = nowOf(options);
      const officer = await verifyMedicalOfficer(session, repos, now);
      if (!officer.ok) return officer.refusal;
      const member = await resolveCrewMember(repos, crewId, now);
      if (!member.ok) return member.refusal;
      return build(member.astronaut, "officer", filters, now);
    },
    async listCrewForHistorySelection(session, options = {}) {
      return listCrewForSelection(session, repos, nowOf(options));
    },
  };
}

const production = createHistoryService({ repos: Object.freeze({ usersRepo, astronautsRepo, eventsRepo, alertsRepo, simulationRunsRepo }) });
export const getOwnHistory = (session, filters, options) => production.getOwnHistory(session, filters, options);
export const getCrewMemberHistory = (session, crewId, filters, options) => production.getCrewMemberHistory(session, crewId, filters, options);
export const listCrewForHistorySelection = (session, options) => production.listCrewForHistorySelection(session, options);
