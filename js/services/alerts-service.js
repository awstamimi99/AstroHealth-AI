// js/services/alerts-service.js — #/alerts (Sprint 8): role-scoped alert list,
// detail by PUBLIC alert number, and the Medical Officer lifecycle actions.
//
//   listAlerts(session, { status?, severity?, crewId? }, options)
//   getAlertDetail(session, "ALT-0191", options)
//   acknowledgeAlert(session, "ALT-0191", { note? }, options)          Medical Officer
//   resolveAlert(session, "ALT-0191", { note, confirmConditionPresent?, notifyAstronaut? }, options)  Medical Officer
//
// SCOPE
//   Astronaut: verified first; only alerts whose astronautId is their own —
//     open alerts plus alerts resolved in the last 30 days (list); any of their
//     own alerts (detail). Another astronaut's number is "not found", exactly
//     like an unknown number. Read-only.
//   Medical Officer: verified first; crew-wide; filters validated; crew IDs
//     resolved only after verification.
//
// LIFECYCLE (one transaction each over alerts + alertActions + missionEvents;
// the alert is re-read inside it, so a repeat is "unchanged" and a stale
// state is a "conflict" — nothing is written in either case):
//   acknowledge: new → acknowledged (optional note ≤ 500)
//   resolve:     acknowledged → resolved (trimmed note 1…500 characters;
//                if conditionCleared is 0, confirmConditionPresent: true).
//                notifyAstronaut: true ALSO sends the note to the crew member as a
//                message (messages + message_sent event) in the same transaction —
//                the officer's explicit choice; without it the note stays internal.
//
// PRIVACY: outputs never contain alert/astronaut/user/measurement ids or raw
// records. Lifecycle notes (resolutionNote, acknowledgement / action notes)
// are internal Medical Officer notes: astronaut results omit those keys
// entirely (the stored records are unchanged). Evidence of wellbeing alerts is shown without score values. No
// journal, wellbeing, message or password reads.
//
// Test seam: createAlertsService({ repos, withTransaction }).

import {
  usersRepo,
  astronautsRepo,
  alertsRepo,
  alertActionsRepo,
  eventsRepo,
  messagesRepo,
  withTransaction,
  SEVERITIES,
  OPEN_ALERT_STATUSES,
  METRIC_UNITS,
  DAY_MS,
} from "../db/index.js";
import { verifyAstronaut, verifyMedicalOfficer, resolveCrewMember } from "./access-control.js";
import { compareAlerts } from "./crew-monitor-service.js";
import { DEMO_THRESHOLD_LABEL, DEMO_LIMITATION } from "../engine/rules/physical-rules.js";

export { DEMO_THRESHOLD_LABEL };
export const ALERT_NUMBER_PATTERN = /^ALT-\d{4,6}$/;
export const RESOLVED_WINDOW_MS = 30 * DAY_MS;
export const NOTE_MAX = 500;
export const STATUS_FILTERS = Object.freeze(["open", "new", "acknowledged", "resolved", "all"]);
export const ACTION_STORES = Object.freeze(["alerts", "alertActions", "missionEvents"]);
export const NOTIFY_STORES = Object.freeze([...ACTION_STORES, "messages"]);

const METRIC_LABELS = { heartRate: "Heart rate", spo2: "SpO₂", bpSystolic: "Systolic blood pressure", bpDiastolic: "Diastolic blood pressure", sleepDuration: "Sleep duration", activity: "Activity", fatigue: "Fatigue", mood: "Mood", stress: "Stress" };
const ACTION_LABELS = { created: "Created", escalated: "Escalated", acknowledged: "Acknowledged", condition_cleared: "Condition cleared", resolved: "Resolved" };

const isText = (v) => typeof v === "string" && v.trim() !== "";
const isTime = (v) => typeof v === "number" && Number.isFinite(v);
const result = (status, reason, now, extra = {}) => ({ status, reason, generatedAt: now, ...extra });
const isOpen = (a) => OPEN_ALERT_STATUSES.includes(a.status);

function title(a) {
  if (isText(a.title)) return a.title.trim();
  if (isText(a.type)) return a.type.replace(/[_-]+/g, " ");
  return "Alert";
}

/** Presentation-safe summary row. */
function presentRow(a, member) {
  return {
    number: a.number,
    title: title(a),
    severity: SEVERITIES.includes(a.severity) ? a.severity : "info",
    status: a.status,
    category: isText(a.category) ? a.category : "",
    crewId: member ? member.crewId : "",
    name: member ? member.name : "",
    detectedAt: isTime(a.detectedAt) ? a.detectedAt : 0,
    lastTriggeredAt: isTime(a.lastTriggeredAt) ? a.lastTriggeredAt : 0,
    conditionCleared: a.conditionCleared === 1,
    ruleId: isText(a.ruleId) ? a.ruleId : "",
    explanation: isText(a.explanation) ? a.explanation : "",
    fromSimulation: evidenceList(a).some((e) => e.source === "simulation"),
    synthetic: true, // every record in this prototype is synthetic
  };
}

function evidenceList(a) {
  return Array.isArray(a.triggeringMeasurements) ? a.triggeringMeasurements.filter((e) => e && typeof e === "object") : [];
}

/** Evidence without measurement ids; wellbeing evidence without score values. */
function presentEvidence(a) {
  const wellbeing = a.category === "wellbeing";
  return evidenceList(a)
    .map((e) => ({
      metric: isText(e.metric) ? e.metric : "",
      label: METRIC_LABELS[e.metric] || (isText(e.metric) ? e.metric : "Reading"),
      value: wellbeing || !isTime(e.value) ? null : e.value,
      unit: wellbeing ? "" : isText(e.unit) ? e.unit : METRIC_UNITS[e.metric] || "",
      timestamp: isTime(e.timestamp) ? e.timestamp : 0,
      // Alerts created before Sprint 8 (the seeded history) didn't record these.
      source: ["seed", "simulation", "manual"].includes(e.source) ? e.source : e.source === undefined ? "not_recorded" : "unknown",
      quality: ["ok", "suspect", "invalid"].includes(e.quality) ? e.quality : e.quality === undefined ? "not_recorded" : "unknown",
      valueHidden: wellbeing,
    }))
    .sort((x, y) => x.timestamp - y.timestamp);
}

/** TEST SEAM. Pages use the exported functions below. */
export function createAlertsService({ repos, withTransaction: runTransaction }) {
  const locks = new Set();
  const nowOf = (options) => (options && options.now !== undefined ? options.now : Date.now());

  /** Verify either role. → { role, user, astronaut? } | { refusal } */
  async function who(session, now) {
    if (session && session.role === "astronaut") {
      const v = await verifyAstronaut(session, repos, now);
      return v.ok ? { role: "astronaut", user: v.user, astronaut: v.astronaut } : { refusal: v.refusal };
    }
    const v = await verifyMedicalOfficer(session, repos, now);
    return v.ok ? { role: "officer", user: v.officer } : { refusal: v.refusal };
  }

  async function crewMap() {
    const all = await repos.astronautsRepo.getAll();
    const map = new Map();
    for (const a of Array.isArray(all) ? all : []) if (a && isText(a.id) && isText(a.crewId)) map.set(a.id, { crewId: a.crewId, name: isText(a.name) ? a.name : a.crewId });
    return map;
  }

  /** Find a stored alert by public number within the caller's scope (null when not visible). */
  async function findScoped(viewer, number) {
    const list = viewer.role === "astronaut" ? await repos.alertsRepo.query({ astronautId: viewer.astronaut.id }) : await repos.alertsRepo.query({});
    const found = (Array.isArray(list) ? list : []).find((a) => a && a.number === number) || null;
    if (!found) return null;
    if (viewer.role === "astronaut" && found.astronautId !== viewer.astronaut.id) return null;
    return found;
  }

  async function nameOf(userId, cache) {
    if (!isText(userId)) return "";
    if (userId === "system") return "System";
    if (cache.has(userId)) return cache.get(userId);
    let name = "Medical Officer";
    try {
      const u = await repos.usersRepo.getById(userId);
      if (u && u.id === userId && isText(u.displayName)) name = u.displayName;
    } catch {
      /* keep the generic label */
    }
    cache.set(userId, name);
    return name;
  }

  async function lifecycle(session, number, options, kind, input) {
    const now = nowOf(options);
    if (!isTime(now)) return result("invalid", "invalid_time", Date.now());
    const officer = await verifyMedicalOfficer(session, repos, now);
    if (!officer.ok) return officer.refusal;
    if (typeof number !== "string" || !ALERT_NUMBER_PATTERN.test(number)) return result("not_found", "unknown_alert", now);
    const src = input && typeof input === "object" ? input : {};
    const note = typeof src.note === "string" ? src.note.trim() : "";
    if (src.note !== undefined && typeof src.note !== "string") return result("invalid", "invalid_note", now);
    if (note.length > NOTE_MAX) return result("invalid", "note_too_long", now);
    if (kind === "resolve" && !note) return result("invalid", "note_required", now);
    if (src.notifyAstronaut !== undefined && typeof src.notifyAstronaut !== "boolean") return result("invalid", "invalid_notify", now);
    const notify = kind === "resolve" && src.notifyAstronaut === true;
    if (notify && !repos.messagesRepo) return result("unavailable", "database_error", now);
    const viewer = { role: "officer", user: officer.officer };

    if (locks.has(number)) return result("busy", "operation_in_progress", now);
    locks.add(number);
    try {
      let target;
      try {
        target = await findScoped(viewer, number);
      } catch {
        return result("unavailable", "database_error", now);
      }
      if (!target) return result("not_found", "unknown_alert", now);
      let outcome;
      try {
        outcome = await runTransaction(notify ? NOTIFY_STORES : ACTION_STORES, "readwrite", async (tx) => {
          const cur = await repos.alertsRepo.getById(target.id, { tx });
          if (!cur || cur.number !== number) return { status: "not_found" };
          if (kind === "acknowledge") {
            if (cur.status === "acknowledged") return { status: "unchanged", alertStatus: cur.status };
            if (cur.status !== "new") return { status: "conflict", reason: "invalid_transition", alertStatus: cur.status };
            await repos.alertsRepo.update(cur.id, { status: "acknowledged", acknowledgedAt: now, acknowledgedBy: officer.officer.id }, { tx });
            await repos.alertActionsRepo.add({ alertId: cur.id, action: "acknowledged", userId: officer.officer.id, timestamp: now, note }, { tx });
            await repos.eventsRepo.add({ type: "alert_acknowledged", timestamp: now, astronautId: cur.astronautId, actorUserId: officer.officer.id, refStore: "alerts", refId: cur.id, summary: `${cur.number} acknowledged by ${officer.officer.displayName}`, data: { ruleId: cur.ruleId, severity: cur.severity } }, { tx });
            return { status: "acknowledged", alertStatus: "acknowledged" };
          }
          // resolve
          if (cur.status === "resolved") return { status: "unchanged", alertStatus: cur.status };
          if (cur.status !== "acknowledged") return { status: "conflict", reason: "not_acknowledged", alertStatus: cur.status };
          if (cur.conditionCleared !== 1 && src.confirmConditionPresent !== true) return { status: "confirm_required", reason: "condition_present", alertStatus: cur.status };
          await repos.alertsRepo.update(cur.id, { status: "resolved", resolvedAt: now, resolvedBy: officer.officer.id, resolutionNote: note }, { tx });
          await repos.alertActionsRepo.add({ alertId: cur.id, action: "resolved", userId: officer.officer.id, timestamp: now, note }, { tx });
          await repos.eventsRepo.add({ type: "alert_resolved", timestamp: now, astronautId: cur.astronautId, actorUserId: officer.officer.id, refStore: "alerts", refId: cur.id, summary: `${cur.number} resolved by ${officer.officer.displayName}`, data: { ruleId: cur.ruleId, severity: cur.severity, conditionCleared: cur.conditionCleared === 1 ? 1 : 0 } }, { tx });
          if (notify) {
            const msg = await repos.messagesRepo.add({ astronautId: cur.astronautId, fromUserId: officer.officer.id, templateId: "", body: note, relatedAlertId: cur.id, sentAt: now, acknowledgedAt: 0, response: null, createdBy: officer.officer.id }, { tx });
            await repos.eventsRepo.add({ type: "message_sent", timestamp: now, astronautId: cur.astronautId, actorUserId: officer.officer.id, refStore: "messages", refId: msg.id, summary: `Message sent about ${cur.number}`, data: { templateId: "", alertNumber: cur.number } }, { tx });
          }
          return { status: "resolved", alertStatus: "resolved", notified: notify };
        });
      } catch {
        return result("unavailable", "database_error", now);
      }
      if (outcome.status === "not_found") return result("not_found", "unknown_alert", now);
      return result(outcome.status, outcome.reason || "", now, { number, alertStatus: outcome.alertStatus, ...(kind === "resolve" ? { notified: outcome.notified === true } : {}) });
    } finally {
      locks.delete(number);
    }
  }

  return {
    /**
     * Astronaut: own open alerts + own alerts resolved in the last 30 days.
     * Medical Officer: crew-wide, filtered (status default "open").
     */
    async listAlerts(session, filters = {}, options = {}) {
      const now = nowOf(options);
      const viewer = await who(session, now);
      if (viewer.refusal) return viewer.refusal;
      const f = filters && typeof filters === "object" ? filters : {};

      if (viewer.role === "astronaut") {
        let raw;
        try {
          raw = await repos.alertsRepo.query({ astronautId: viewer.astronaut.id });
        } catch {
          return result("unavailable", "database_error", now);
        }
        const me = { crewId: viewer.astronaut.crewId, name: viewer.astronaut.name };
        const items = (Array.isArray(raw) ? raw : [])
          .filter((a) => a && a.astronautId === viewer.astronaut.id && isText(a.number))
          .filter((a) => isOpen(a) || (a.status === "resolved" && isTime(a.resolvedAt) && now - a.resolvedAt <= RESOLVED_WINDOW_MS))
          .sort(compareAlerts)
          .map((a) => presentRow(a, me));
        return result("ready", "", now, { viewer: "astronaut", items, filters: { status: "visible", severity: "all", crewId: "" }, crew: [], thresholdLabel: DEMO_THRESHOLD_LABEL });
      }

      const status = f.status === undefined ? "open" : f.status;
      const severity = f.severity === undefined ? "all" : f.severity;
      if (!STATUS_FILTERS.includes(status)) return result("invalid", "invalid_filter", now);
      if (severity !== "all" && !SEVERITIES.includes(severity)) return result("invalid", "invalid_filter", now);
      let member = null;
      if (f.crewId !== undefined && f.crewId !== "") {
        const m = await resolveCrewMember(repos, f.crewId, now);
        if (!m.ok) return m.refusal;
        member = m.astronaut;
      }
      let raw;
      let crew;
      try {
        [raw, crew] = await Promise.all([repos.alertsRepo.query(member ? { astronautId: member.id } : {}), crewMap()]);
      } catch {
        return result("unavailable", "database_error", now);
      }
      const items = (Array.isArray(raw) ? raw : [])
        .filter((a) => a && isText(a.number) && (!member || a.astronautId === member.id))
        .filter((a) => (status === "all" ? true : status === "open" ? isOpen(a) : a.status === status))
        .filter((a) => severity === "all" || a.severity === severity)
        .sort(compareAlerts)
        .map((a) => presentRow(a, crew.get(a.astronautId)));
      const crewList = [...crew.values()].sort((a, b) => a.crewId.localeCompare(b.crewId));
      return result("ready", "", now, { viewer: "officer", items, filters: { status, severity, crewId: member ? member.crewId : "" }, crew: crewList, thresholdLabel: DEMO_THRESHOLD_LABEL });
    },

    /** One alert by public number, with evidence and its audit trail. */
    async getAlertDetail(session, number, options = {}) {
      const now = nowOf(options);
      const viewer = await who(session, now);
      if (viewer.refusal) return viewer.refusal;
      if (typeof number !== "string" || !ALERT_NUMBER_PATTERN.test(number)) return result("not_found", "unknown_alert", now);
      let a;
      try {
        a = await findScoped(viewer, number);
      } catch {
        return result("unavailable", "database_error", now);
      }
      if (!a) return result("not_found", "unknown_alert", now);

      const names = new Map();
      const [crewS, actionsS] = await Promise.allSettled([
        viewer.role === "astronaut" ? Promise.resolve(null) : crewMap(),
        repos.alertActionsRepo.getByAlert(a.id),
      ]);
      const member = viewer.role === "astronaut" ? { crewId: viewer.astronaut.crewId, name: viewer.astronaut.name } : crewS.status === "fulfilled" ? crewS.value.get(a.astronautId) || null : null;
      let timeline;
      if (actionsS.status !== "fulfilled") timeline = { status: "error", items: [] };
      else {
        const items = [];
        for (const x of (Array.isArray(actionsS.value) ? actionsS.value : []).filter((x) => x && x.alertId === a.id && ACTION_LABELS[x.action])) {
          const item = { action: x.action, label: ACTION_LABELS[x.action], timestamp: isTime(x.timestamp) ? x.timestamp : 0, by: await nameOf(x.userId, names) };
          // Lifecycle notes are internal Medical Officer notes: astronauts never receive the key.
          if (viewer.role === "officer") item.note = isText(x.note) ? x.note : "";
          items.push(item);
        }
        timeline = { status: "ok", items };
      }
      const rule = a.rule && typeof a.rule === "object" ? a.rule : {};
      const evaluation = a.evaluation && typeof a.evaluation === "object" ? a.evaluation : null;
      const ex = evaluation && evaluation.excluded && typeof evaluation.excluded === "object" ? evaluation.excluded : null;
      return result("ready", "", now, {
        viewer: viewer.role,
        alert: {
          ...presentRow(a, member),
          occurrenceCount: Number.isInteger(a.occurrenceCount) ? a.occurrenceCount : 1,
          suggestedAction: isText(a.suggestedAction) ? a.suggestedAction : "",
          acknowledgedAt: isTime(a.acknowledgedAt) ? a.acknowledgedAt : 0,
          acknowledgedBy: await nameOf(a.acknowledgedBy, names),
          resolvedAt: isTime(a.resolvedAt) ? a.resolvedAt : 0,
          resolvedBy: await nameOf(a.resolvedBy, names),
          // resolutionNote: Medical Officer only (added below); omitted entirely for astronauts.
          rule: {
            id: isText(rule.id) ? rule.id : a.ruleId || "",
            version: Number.isInteger(rule.version) ? rule.version : null,
            description: isText(rule.description) ? rule.description : "",
            thresholdUsed: isText(rule.thresholdUsed) ? rule.thresholdUsed : "",
            thresholdSource: isText(rule.thresholdSource) ? rule.thresholdSource : "",
          },
          evidence: presentEvidence(a),
          evaluation: evaluation
            ? {
                evaluatedAt: isTime(evaluation.evaluatedAt) ? evaluation.evaluatedAt : 0,
                considered: Number.isInteger(evaluation.considered) ? evaluation.considered : null,
                excluded: { suspect: ex && Number.isInteger(ex.suspect) ? ex.suspect : 0, invalid: ex && Number.isInteger(ex.invalid) ? ex.invalid : 0, stale: ex && Number.isInteger(ex.stale) ? ex.stale : 0 },
                limitation: isText(evaluation.limitation) ? evaluation.limitation : DEMO_LIMITATION,
              }
            : null,
          limitation: evaluation && isText(evaluation.limitation) ? evaluation.limitation : DEMO_LIMITATION,
          ...(viewer.role === "officer" ? { resolutionNote: isText(a.resolutionNote) ? a.resolutionNote : "" } : {}),
        },
        timeline,
        actions: viewer.role === "officer" ? { canAcknowledge: a.status === "new", canResolve: a.status === "acknowledged", needsConfirmation: a.status === "acknowledged" && a.conditionCleared !== 1 } : { canAcknowledge: false, canResolve: false, needsConfirmation: false },
        thresholdLabel: DEMO_THRESHOLD_LABEL,
      });
    },

    /**
     * How many OPEN alerts the viewer can see (top-bar bell badge).
     * Astronaut: own alerts only. Medical Officer: the whole crew.
     * → { open, unacknowledged, topSeverity } — counts only, no alert content.
     */
    async countOpenAlerts(session, options = {}) {
      const r = await this.listAlerts(session, { status: "open" }, options);
      if (!r || r.status !== "ready") return result((r && r.status) || "unavailable", (r && r.reason) || "unexpected_error", nowOf(options));
      const open = r.items.filter((a) => a && (a.status === "new" || a.status === "acknowledged"));
      const rank = { info: 1, warning: 2, critical: 3 };
      const top = open.reduce((best, a) => (rank[a.severity] > (rank[best] || 0) ? a.severity : best), null);
      return result("ready", "", r.generatedAt, { viewer: r.viewer, open: open.length, unacknowledged: open.filter((a) => a.status === "new").length, topSeverity: top });
    },

    /** Medical Officer: new → acknowledged. */
    async acknowledgeAlert(session, number, input, options = {}) {
      return lifecycle(session, number, options, "acknowledge", input);
    },

    /** Medical Officer: acknowledged → resolved (note required; confirmation if the condition hasn't cleared). */
    async resolveAlert(session, number, input, options = {}) {
      return lifecycle(session, number, options, "resolve", input);
    },
  };
}

const production = createAlertsService({
  repos: Object.freeze({ usersRepo, astronautsRepo, alertsRepo, alertActionsRepo, eventsRepo, messagesRepo }),
  withTransaction,
});
export const listAlerts = (session, filters, options) => production.listAlerts(session, filters, options);
export const getAlertDetail = (session, number, options) => production.getAlertDetail(session, number, options);
export const countOpenAlerts = (session, options) => production.countOpenAlerts(session, options);
export const acknowledgeAlert = (session, number, input, options) => production.acknowledgeAlert(session, number, input, options);
export const resolveAlert = (session, number, input, options) => production.resolveAlert(session, number, input, options);
