// js/services/crew-monitor-service.js — crew-wide data for the Medical Officer (Sprint 5)
//
//   import { getCrewSnapshot, getCrewMemberDetail } from "../services/crew-monitor-service.js";
//   const snapshot = await getCrewSnapshot(session);           // #/overview + #/crew
//   const detail = await getCrewMemberDetail(session, "AH-03"); // #/crew/AH-03
//
// WHAT IT DOES
//   Read-only views of the whole crew for a VERIFIED Medical Officer: who has
//   open alerts (ranked), each astronaut's latest usable readings, the date of
//   their last SHARED wellbeing check-in, and message status. All records are
//   SYNTHETIC demo data. No writes, no alert actions, no risk evaluation.
//
// AUTHORIZATION (enforced here — repositories don't check callers)
//   Before ANY crew read: session.role === "medical_officer", and
//   usersRepo.getById(session.userId) must return that same user with role
//   "medical_officer" and astronautId "". A crew ID is accepted only after
//   that, only in the form "AH-01", and only if astronautsRepo.getByCrewId
//   finds it.
//
// PRIVACY
//   • The private journal is never read (journalRepo is not imported).
//   • Wellbeing comes only from getSharedRange() and is re-filtered to
//     sharedWithMedical === 1. Lists show only the last shared date; the
//     detail view shows up to 7 explicitly shared assessments.
//   • Mission events are not read in Sprint 5 (no reliable privacy flag yet).
//   • Message senders are verified against stored users; unknown senders are
//     skipped. No user id (sender, officer, astronaut) is ever returned.
//
// NOT A HEALTH ASSESSMENT
//   Crew status comes ONLY from stored open alerts (new/acknowledged), plus a
//   separate "Data needs review" note for stale/suspect/missing readings —
//   a data-quality note, never a medical conclusion. No thresholds here.
//
// ERRORS
//   Expected repository failures become explicit states: "unavailable"
//   (nothing to show) or a per-section "error" (the rest still shows).
//   Bugs in this file's own logic are NOT swallowed — they throw.
//
// TEST SEAM
//   createCrewMonitorService({ repos, getMissionContext }) lets unit tests use
//   the in-memory mock. Pages use getCrewSnapshot / getCrewMemberDetail, bound
//   to the real database. Injection can't change who is asking: the officer
//   is always verified against usersRepo inside each call.

import {
  usersRepo,
  astronautsRepo,
  measurementsRepo,
  dailySummariesRepo,
  alertsRepo,
  messagesRepo,
  wellbeingRepo,
  cognitiveRepo,
  ROLES,
  METRIC_UNITS,
  SEVERITIES,
  OPEN_ALERT_STATUSES,
  WELLBEING_SCALES,
  DAY_MS,
  toDateKey,
} from "../db/index.js";
import { getMissionContext, MISSION_UNAVAILABLE } from "./mission-service.js";
// Pure, already-exported Sprint 4 helpers (no side effects, no cycle).
import {
  selectLatestUsable,
  pairBloodPressure,
  summarizeSleep,
  describeCognitive,
  lastUtcDates,
  VITALS_STALE_MS,
  SLEEP_STALE_MS,
  RECENT_READINGS_LIMIT,
  SLEEP_NIGHTS,
} from "./astronaut-overview-service.js";

// ---- Rules ---------------------------------------------------------------------

export const CREW_STATUS_NOTE = "Based on stored open alerts only. This is not a health assessment.";
/** D8: public crew IDs only, e.g. "AH-01". */
export const CREW_ID_PATTERN = /^AH-\d{2}$/;
/** How far back shared check-ins are read (list: last shared date; detail: up to 7). */
export const SHARED_WELLBEING_WINDOW_MS = 30 * DAY_MS;
export const MAX_SHARED_ASSESSMENTS = 7;
export const MAX_DETAIL_MESSAGES = 3;
export const MAX_CREW_ALERTS = 10;

/** D2: crew states in rank order (1 = review first). Every state has icon, text, tone, explanation. */
export const CREW_STATES = Object.freeze({
  critical: Object.freeze({ rank: 1, level: "critical", label: "Critical alert", icon: "circle-alert", tone: "critical", explanation: "At least one open critical alert." }),
  watch: Object.freeze({ rank: 2, level: "watch", label: "Watch", icon: "triangle-alert", tone: "warning", explanation: "At least one open warning alert." }),
  info: Object.freeze({ rank: 3, level: "info", label: "Info", icon: "info", tone: "info", explanation: "Only open info alerts." }),
  unavailable: Object.freeze({ rank: 4, level: "unavailable", label: "Status unavailable", icon: "eye-off", tone: "neutral", explanation: "Alerts couldn't be loaded, so no alert status is shown." }),
  review: Object.freeze({ rank: 5, level: "review", label: "Data needs review", icon: "clock", tone: "neutral", explanation: "No open alerts, but some readings are stale, suspect, missing or couldn't be loaded. This is a data-quality note, not a medical warning." }),
  clear: Object.freeze({ rank: 6, level: "clear", label: "No open alerts", icon: "circle-check", tone: "ok", explanation: "No stored alert is open (new or acknowledged)." }),
});

const SEVERITY_RANK = { info: 1, warning: 2, critical: 3 };
const LIST_VITALS = Object.freeze([
  { key: "heartRate", label: "Heart rate", metric: "heartRate", staleMs: VITALS_STALE_MS },
  { key: "spo2", label: "SpO₂", metric: "spo2", staleMs: VITALS_STALE_MS },
  { key: "sleepDuration", label: "Sleep duration", metric: "sleepDuration", staleMs: SLEEP_STALE_MS },
]);
const WELLBEING_FIELDS = Object.freeze(["mood", "stress", "sleepQuality", "fatigue", "isolation", "wellbeing"]);
/** Days shown in the Crew Monitor 7-day trend charts (UTC days, oldest first). */
export const TREND_DAYS = 7;

/**
 * Daily averages for one metric over `dates` (stored dailySummaries; null = no data
 * that day, never zero). Pure; ERROR → { status: "error" }.
 */
export function buildTrend(list, astronautId, metric, dates) {
  if (list === ERROR) return { status: "error", points: [] };
  const byDate = new Map((Array.isArray(list) ? list : [])
    .filter((s) => s && s.astronautId === astronautId && s.metric === metric && typeof s.avg === "number" && Number.isFinite(s.avg))
    .map((s) => [s.date, s.avg]));
  return { status: "ok", points: dates.map((date) => ({ date, value: byDate.has(date) ? Math.round(byDate.get(date) * 10) / 10 : null })) };
}

// ---- Small pure helpers ------------------------------------------------------------

const isText = (v) => typeof v === "string" && v.trim() !== "";
const isTime = (v) => typeof v === "number" && Number.isFinite(v);
const ERROR = Symbol("error");
const valueOf = (settled) => (settled.status === "fulfilled" ? settled.value : ERROR);
const attempt = (fn) => Promise.resolve().then(fn); // a synchronous repository throw becomes a rejection
const refusal = (status, reason, now) => ({ status, reason, generatedAt: now });
const isOpen = (a) => Boolean(a) && OPEN_ALERT_STATUSES.includes(a.status);

/** Title for display: stored title, else the type made readable, else "Alert". */
function alertTitle(alert) {
  if (isText(alert.title)) return alert.title.trim();
  if (isText(alert.type)) {
    const words = alert.type.replace(/[_-]+/g, " ").trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return "Alert";
}

/** Most severe first, then unacknowledged ("new") first, then newest, then number. */
export function compareAlerts(a, b) {
  return (
    (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0) ||
    (a.status === "new" ? 0 : 1) - (b.status === "new" ? 0 : 1) ||
    (b.detectedAt || 0) - (a.detectedAt || 0) ||
    String(a.number).localeCompare(String(b.number))
  );
}

/** Presentation-safe alert (no ids, no raw record). */
function presentAlert(a, member) {
  return {
    ...(member ? { crewId: member.crewId, name: member.name } : {}),
    number: isText(a.number) ? a.number : "",
    title: alertTitle(a),
    severity: SEVERITIES.includes(a.severity) ? a.severity : "info",
    status: a.status,
    category: isText(a.category) ? a.category : "",
    ruleId: isText(a.ruleId) ? a.ruleId : "", // public rule id (shown on #/alerts); places the body-scan pin
    detectedAt: isTime(a.detectedAt) ? a.detectedAt : 0,
    explanation: isText(a.explanation) ? a.explanation : "",
    synthetic: true, // every record in this prototype is synthetic
  };
}

/** Data-quality issues among a member's readings (never a medical conclusion). */
export function describeDataIssues(vitalItems) {
  const issues = [];
  for (const item of vitalItems) {
    if (item.state === "error") issues.push(`${item.label} couldn't be loaded`);
    else if (item.state !== "ok") issues.push(`No recent ${item.label.toLowerCase()} reading`);
    else {
      if (item.quality === "suspect") issues.push(`${item.label} reading is marked suspect`);
      if (item.stale) issues.push(`${item.label} reading is stale`);
    }
  }
  return issues;
}

/**
 * D2: one crew member's state from their OPEN alerts (null = alert query
 * failed) and data issues. Acknowledged alerts keep their severity.
 */
export function deriveCrewState(openAlerts, dataIssues) {
  if (!Array.isArray(openAlerts)) return { ...CREW_STATES.unavailable, reason: CREW_STATES.unavailable.explanation, note: CREW_STATUS_NOTE };
  const open = openAlerts.filter(isOpen).sort(compareAlerts);
  if (open.length) {
    const top = open[0];
    const state = top.severity === "critical" ? CREW_STATES.critical : top.severity === "warning" ? CREW_STATES.watch : CREW_STATES.info;
    const label = [top.number, alertTitle(top)].filter(Boolean).join(" ");
    const more = open.length > 1 ? ` · ${open.length - 1} more open` : "";
    return { ...state, reason: `${label} (${top.severity}, ${top.status})${more}`, note: CREW_STATUS_NOTE };
  }
  if (dataIssues.length) return { ...CREW_STATES.review, reason: `${dataIssues.join("; ")}.`, note: CREW_STATUS_NOTE };
  return { ...CREW_STATES.clear, reason: CREW_STATES.clear.explanation, note: CREW_STATUS_NOTE };
}

/**
 * D2 ordering: state rank; then (open-alert states) any "new" alert first,
 * newest open alert first, more open alerts first; finally crew ID ascending.
 */
export function compareCrew(a, b) {
  return (
    a.state.rank - b.state.rank ||
    (b.sort.hasNew ? 1 : 0) - (a.sort.hasNew ? 1 : 0) ||
    b.sort.newestAt - a.sort.newestAt ||
    b.sort.openCount - a.sort.openCount ||
    a.crewId.localeCompare(b.crewId)
  );
}

/** Latest usable heart rate / SpO₂ / sleep — same rules as the astronaut Overview. */
function buildListVitals(lists, astronaut, now) {
  const baseline = astronaut.baseline || {};
  return LIST_VITALS.map((v) => {
    const base = { key: v.key, label: v.label, unit: METRIC_UNITS[v.metric] };
    const b = baseline[v.metric];
    const withBaseline = { ...base, baseline: typeof b === "number" && Number.isFinite(b) ? b : null };
    const list = lists[v.metric];
    if (list === ERROR) return { ...withBaseline, state: "error" };
    const own = Array.isArray(list) ? list.filter((r) => r && r.astronautId === astronaut.id) : [];
    return { ...withBaseline, ...selectLatestUsable(own, { now, staleMs: v.staleMs }) };
  });
}

function sectionStatus(items) {
  const failed = items.filter((i) => i.state === "error").length;
  return failed === 0 ? "ok" : failed === items.length ? "error" : "partial";
}

/** Profile fields that are safe to show (no `latest` cache, no base fields). */
function presentProfile(a) {
  return { crewId: a.crewId, name: a.name, missionRole: a.missionRole, initials: a.initials };
}

/** Shared check-ins only — re-filtered here even though the query is "shared". */
function sharedOnly(list, astronautIds, now) {
  if (!Array.isArray(list)) return [];
  return list.filter(
    (w) => w && w.sharedWithMedical === 1 && astronautIds.has(w.astronautId) && isTime(w.timestamp) && w.timestamp <= now
  );
}

/** A stored score within its documented scale, else null. */
function score(record, field) {
  const v = record[field];
  const [min, max] = WELLBEING_SCALES[field];
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;
}

// ---- Officer + message-sender verification -------------------------------------------

async function verifyOfficer(session, repos, now) {
  if (!session || typeof session !== "object") return refusal("forbidden", "no_session", now);
  if (session.role !== ROLES.MEDICAL_OFFICER) return refusal("forbidden", "not_medical_officer", now);
  if (!isText(session.userId) || session.astronautId !== "") return refusal("forbidden", "invalid_session", now);
  let user;
  try {
    user = await repos.usersRepo.getById(session.userId);
  } catch {
    return refusal("unavailable", "database_error", now);
  }
  if (!user || user.id !== session.userId || user.role !== ROLES.MEDICAL_OFFICER || user.astronautId !== "") {
    return refusal("forbidden", "account_mismatch", now);
  }
  return { status: "ok", officer: user };
}

/**
 * Look up each distinct sender once (concurrently). Result per id:
 * { kind: "officer" } | { kind: "astronaut", astronautId } | { kind: "unknown" } | ERROR.
 */
async function resolveSenders(senderIds, repos) {
  const settled = await Promise.allSettled(senderIds.map((id) => attempt(() => repos.usersRepo.getById(id))));
  const out = new Map();
  senderIds.forEach((id, i) => {
    const s = settled[i];
    if (s.status === "rejected") return out.set(id, ERROR);
    const u = s.value;
    if (u && u.id === id && u.role === ROLES.MEDICAL_OFFICER && u.astronautId === "") out.set(id, { kind: "officer" });
    else if (u && u.id === id && u.role === ROLES.ASTRONAUT && isText(u.astronautId)) out.set(id, { kind: "astronaut", astronautId: u.astronautId });
    else out.set(id, { kind: "unknown" });
  });
  return out;
}

/** Messages that can be checked: this astronaut's, a valid time and a sender id. */
const checkableMessages = (list, astronautId) =>
  (Array.isArray(list) ? list : [])
    .filter((m) => m && m.astronautId === astronautId && isTime(m.sentAt) && isText(m.fromUserId))
    .sort((a, b) => b.sentAt - a.sentAt);

/**
 * Classify one astronaut's messages with verified senders. A message from an
 * astronaut counts only if the sender is THIS astronaut. Unknown → skipped.
 * Any failed sender lookup that this astronaut needs → { status: "error" }.
 */
function classifyMessages(messages, senders) {
  const out = [];
  for (const m of messages) {
    const sender = senders.get(m.fromUserId);
    if (sender === ERROR) return { status: "error" };
    if (!sender || sender.kind === "unknown") continue;
    if (sender.kind === "astronaut" && sender.astronautId !== m.astronautId) continue;
    const fromOfficer = sender.kind === "officer";
    const reply =
      fromOfficer && m.response && typeof m.response === "object" && typeof m.response.text === "string"
        ? { text: m.response.text, at: isTime(m.response.at) ? m.response.at : 0 }
        : null;
    out.push({
      direction: fromOfficer ? "from_officer" : "from_astronaut",
      sentAt: m.sentAt,
      body: typeof m.body === "string" ? m.body : "",
      status: fromOfficer ? (reply ? "replied" : m.acknowledgedAt === 0 ? "awaiting_acknowledgement" : "acknowledged") : "sent",
      reply,
    });
  }
  return { status: "ok", items: out };
}

// ---- Service ----------------------------------------------------------------------------

/**
 * TEST SEAM — see the header. Production code uses getCrewSnapshot / getCrewMemberDetail.
 * @param {{ repos: object, getMissionContext: (session) => Promise<object> }} deps
 */
export function createCrewMonitorService({ repos, getMissionContext: loadMission }) {
  const missionOf = (settled) => {
    const m = valueOf(settled);
    return m === ERROR || !m ? MISSION_UNAVAILABLE : { available: Boolean(m.available), name: m.name, missionDay: m.missionDay };
  };

  /** Crew-wide snapshot for #/overview (Medical Officer) and #/crew. */
  async function getCrewSnapshot(session, options = {}) {
    const now = options && Number.isFinite(options.now) ? options.now : Date.now();
    const check = await verifyOfficer(session, repos, now);
    if (check.status !== "ok") return check;

    // Wave 1 — crew-wide reads.
    const [crewS, alertsS, sharedS, missionS] = await Promise.allSettled([
      attempt(() => repos.astronautsRepo.getAll()),
      attempt(() => repos.alertsRepo.query({ status: [...OPEN_ALERT_STATUSES] })),
      attempt(() => repos.wellbeingRepo.getSharedRange(now - SHARED_WELLBEING_WINDOW_MS, now)),
      attempt(() => loadMission(session)),
    ]);
    const crewRaw = valueOf(crewS);
    if (crewRaw === ERROR) return refusal("unavailable", "database_error", now);

    const seen = new Set();
    const crew = (Array.isArray(crewRaw) ? crewRaw : [])
      .filter((a) => a && isText(a.id) && typeof a.crewId === "string" && CREW_ID_PATTERN.test(a.crewId) && !seen.has(a.id) && seen.add(a.id))
      .sort((a, b) => a.crewId.localeCompare(b.crewId));
    const crewIds = new Set(crew.map((a) => a.id));

    // Wave 2 — per astronaut (4 crew → 28 small indexed reads, all concurrent).
    const trendDates = lastUtcDates(toDateKey(now), TREND_DAYS);
    const perMember = await Promise.all(
      crew.map(async (a) => {
        const [hr, spo2, sleep, msgs, tHr, tSpo2, tSleep] = await Promise.allSettled([
          attempt(() => repos.measurementsRepo.getRecent(a.id, "heartRate", RECENT_READINGS_LIMIT)),
          attempt(() => repos.measurementsRepo.getRecent(a.id, "spo2", RECENT_READINGS_LIMIT)),
          attempt(() => repos.measurementsRepo.getRecent(a.id, "sleepDuration", RECENT_READINGS_LIMIT)),
          attempt(() => repos.messagesRepo.getByAstronaut(a.id)),
          attempt(() => repos.dailySummariesRepo.getRange(a.id, "heartRate", trendDates[0], trendDates[trendDates.length - 1])),
          attempt(() => repos.dailySummariesRepo.getRange(a.id, "spo2", trendDates[0], trendDates[trendDates.length - 1])),
          attempt(() => repos.dailySummariesRepo.getRange(a.id, "sleepDuration", trendDates[0], trendDates[trendDates.length - 1])),
        ]);
        return {
          lists: { heartRate: valueOf(hr), spo2: valueOf(spo2), sleepDuration: valueOf(sleep) },
          messages: valueOf(msgs),
          trends: {
            heartRate: buildTrend(valueOf(tHr), a.id, "heartRate", trendDates),
            spo2: buildTrend(valueOf(tSpo2), a.id, "spo2", trendDates),
            sleepDuration: buildTrend(valueOf(tSleep), a.id, "sleepDuration", trendDates),
          },
        };
      })
    );

    // Wave 3 — verify every distinct message sender once.
    const checkable = perMember.map((p, i) => (p.messages === ERROR ? ERROR : checkableMessages(p.messages, crew[i].id)));
    const senderIds = [...new Set(checkable.filter((c) => c !== ERROR).flatMap((list) => list.map((m) => m.fromUserId)))];
    const senders = await resolveSenders(senderIds, repos);

    const alertsRaw = valueOf(alertsS);
    const openByMember = new Map(crew.map((a) => [a.id, []]));
    if (alertsRaw !== ERROR) {
      for (const alert of Array.isArray(alertsRaw) ? alertsRaw : []) {
        if (isOpen(alert) && openByMember.has(alert.astronautId)) openByMember.get(alert.astronautId).push(alert);
      }
    }
    const sharedRaw = valueOf(sharedS);
    const shared = sharedRaw === ERROR ? null : sharedOnly(sharedRaw, crewIds, now);

    const members = crew.map((a, i) => {
      const vitals = buildListVitals(perMember[i].lists, a, now);
      const open = alertsRaw === ERROR ? null : [...openByMember.get(a.id)].sort(compareAlerts);
      const state = deriveCrewState(open, describeDataIssues(vitals));
      const msgs = checkable[i] === ERROR ? { status: "error" } : classifyMessages(checkable[i], senders);
      const ownShared = shared ? shared.filter((w) => w.astronautId === a.id) : [];
      const lastShared = ownShared.reduce((max, w) => Math.max(max, w.timestamp), 0);
      return {
        ...presentProfile(a),
        state,
        alerts: open === null
          ? { status: "error", openCount: null, top: null }
          : {
              status: "ok",
              openCount: open.length,
              top: open.length ? presentAlert(open[0]) : null,
              // Rule + severity of every open alert, so cards can colour each vital ring.
              rules: open.map((x) => ({
                ruleId: isText(x.ruleId) ? x.ruleId : "",
                severity: SEVERITIES.includes(x.severity) ? x.severity : "info",
                category: isText(x.category) ? x.category : "",
              })),
            },
        vitals: { status: sectionStatus(vitals), items: vitals },
        sharedWellbeing: shared ? { status: "ok", lastSharedAt: lastShared, count30d: ownShared.length } : { status: "error", lastSharedAt: 0, count30d: null },
        trends: perMember[i].trends, // 7-day daily averages (dates are public UTC day keys; no record ids)
        messages: msgs.status === "error"
          ? { status: "error", awaitingAcknowledgement: 0, replied: 0 }
          : {
              status: "ok",
              awaitingAcknowledgement: msgs.items.filter((m) => m.status === "awaiting_acknowledgement").length,
              replied: msgs.items.filter((m) => m.status === "replied").length,
            },
        sort: {
          hasNew: Boolean(open && open.some((x) => x.status === "new")),
          newestAt: open && open.length ? Math.max(...open.map((x) => x.detectedAt || 0)) : 0,
          openCount: open ? open.length : 0,
        },
      };
    });
    members.sort(compareCrew);

    const crewAlerts =
      alertsRaw === ERROR
        ? { status: "error", items: [], moreCount: 0 }
        : (() => {
            const byId = new Map(crew.map((a) => [a.id, a]));
            const all = [...openByMember.values()].flat().sort(compareAlerts);
            return {
              status: "ok",
              items: all.slice(0, MAX_CREW_ALERTS).map((x) => presentAlert(x, byId.get(x.astronautId))),
              moreCount: Math.max(0, all.length - MAX_CREW_ALERTS),
            };
          })();

    const count = (level) => members.filter((m) => m.state.level === level).length;
    return {
      status: "ready",
      reason: "",
      generatedAt: now,
      today: toDateKey(now),
      officer: { displayName: isText(check.officer.displayName) ? check.officer.displayName : "Medical Officer" },
      mission: missionOf(missionS),
      summary: {
        crewCount: members.length,
        withOpenAlerts: alertsRaw === ERROR ? null : members.filter((m) => m.alerts.openCount > 0).length,
        critical: count("critical"),
        watch: count("watch"),
        info: count("info"),
        unavailable: count("unavailable"),
        dataNeedsReview: count("review"),
        noOpenAlerts: count("clear"),
        // Open alerts across the crew by severity (Crew Monitor chart).
        alertsBySeverity: alertsRaw === ERROR ? null : (() => {
          const open = [...openByMember.values()].flat();
          return Object.fromEntries(SEVERITIES.map((s) => [s, open.filter((x) => (SEVERITIES.includes(x.severity) ? x.severity : "info") === s).length]));
        })(),
      },
      trendDates,
      crew: members.map(({ sort, ...m }) => m),
      alerts: crewAlerts,
    };
  }

  /** One crew member, read-only, for #/crew/AH-0n. */
  async function getCrewMemberDetail(session, crewId, options = {}) {
    const now = options && Number.isFinite(options.now) ? options.now : Date.now();
    const check = await verifyOfficer(session, repos, now);
    if (check.status !== "ok") return check;
    if (typeof crewId !== "string" || !CREW_ID_PATTERN.test(crewId)) return refusal("not_found", "invalid_crew_id", now);

    let astronaut;
    try {
      astronaut = await repos.astronautsRepo.getByCrewId(crewId);
    } catch {
      return refusal("unavailable", "database_error", now);
    }
    if (!astronaut || astronaut.crewId !== crewId || !isText(astronaut.id)) return refusal("not_found", "unknown_crew_id", now);
    const aid = astronaut.id;
    const sleepDates = lastUtcDates(toDateKey(now), SLEEP_NIGHTS);

    const keys = ["heartRate", "spo2", "bpSystolic", "bpDiastolic", "sleepDuration", "alerts", "shared", "messages", "cognitive", "sleepSummaries", "mission"];
    const settled = await Promise.allSettled([
      attempt(() => repos.measurementsRepo.getRecent(aid, "heartRate", RECENT_READINGS_LIMIT)),
      attempt(() => repos.measurementsRepo.getRecent(aid, "spo2", RECENT_READINGS_LIMIT)),
      attempt(() => repos.measurementsRepo.getRecent(aid, "bpSystolic", RECENT_READINGS_LIMIT)),
      attempt(() => repos.measurementsRepo.getRecent(aid, "bpDiastolic", RECENT_READINGS_LIMIT)),
      attempt(() => repos.measurementsRepo.getRecent(aid, "sleepDuration", RECENT_READINGS_LIMIT)),
      attempt(() => repos.alertsRepo.query({ astronautId: aid, status: [...OPEN_ALERT_STATUSES] })),
      attempt(() => repos.wellbeingRepo.getSharedRange(now - SHARED_WELLBEING_WINDOW_MS, now)),
      attempt(() => repos.messagesRepo.getByAstronaut(aid)),
      attempt(() => repos.cognitiveRepo.getRange(aid, undefined, now)),
      attempt(() => repos.dailySummariesRepo.getRange(aid, "sleepDuration", sleepDates[0], sleepDates[sleepDates.length - 1])),
      attempt(() => loadMission(session)),
    ]);
    const r = Object.fromEntries(keys.map((k, i) => [k, valueOf(settled[i])]));
    const own = (list) => (Array.isArray(list) ? list.filter((x) => x && x.astronautId === aid) : []);

    // Vitals: the list's three + blood pressure (D3: BP only in detail).
    const listVitals = buildListVitals({ heartRate: r.heartRate, spo2: r.spo2, sleepDuration: r.sleepDuration }, astronaut, now);
    const baseline = astronaut.baseline || {};
    const bpBaseline =
      Number.isFinite(baseline.bpSystolic) && Number.isFinite(baseline.bpDiastolic) ? { systolic: baseline.bpSystolic, diastolic: baseline.bpDiastolic } : null;
    const bp =
      r.bpSystolic === ERROR || r.bpDiastolic === ERROR
        ? { key: "bloodPressure", label: "Blood pressure", unit: METRIC_UNITS.bpSystolic, baseline: bpBaseline, state: "error" }
        : { key: "bloodPressure", label: "Blood pressure", unit: METRIC_UNITS.bpSystolic, baseline: bpBaseline, ...pairBloodPressure(own(r.bpSystolic), own(r.bpDiastolic), { now, staleMs: VITALS_STALE_MS }) };
    const vitals = [listVitals[0], listVitals[1], bp, listVitals[2]];

    // Status uses the same three readings as the crew list, so list and detail agree.
    const open = r.alerts === ERROR ? null : own(r.alerts).filter(isOpen).sort(compareAlerts);
    const state = deriveCrewState(open, describeDataIssues(listVitals));

    // Shared wellbeing: up to 7, newest first, scores only from shared records.
    const sharedWellbeing =
      r.shared === ERROR
        ? { status: "error", items: [] }
        : {
            status: "ok",
            items: sharedOnly(r.shared, new Set([aid]), now)
              .sort((a, b) => b.timestamp - a.timestamp)
              .slice(0, MAX_SHARED_ASSESSMENTS)
              .map((w) => ({ timestamp: w.timestamp, ...Object.fromEntries(WELLBEING_FIELDS.map((f) => [f, score(w, f)])) })),
          };

    // Messages: verified senders only, newest 3.
    let messages;
    if (r.messages === ERROR) messages = { status: "error", items: [], moreCount: 0 };
    else {
      const list = checkableMessages(r.messages, aid);
      const senders = await resolveSenders([...new Set(list.map((m) => m.fromUserId))], repos);
      const classified = classifyMessages(list, senders);
      messages =
        classified.status === "error"
          ? { status: "error", items: [], moreCount: 0 }
          : { status: "ok", items: classified.items.slice(0, MAX_DETAIL_MESSAGES), moreCount: Math.max(0, classified.items.length - MAX_DETAIL_MESSAGES) };
    }

    return {
      status: "ready",
      reason: "",
      generatedAt: now,
      today: toDateKey(now),
      mission: missionOf(settled[keys.indexOf("mission")]),
      profile: {
        ...presentProfile(astronaut),
        baseline: Object.fromEntries(
          ["heartRate", "spo2", "bpSystolic", "bpDiastolic", "sleepDuration"].map((k) => [k, Number.isFinite(baseline[k]) ? baseline[k] : null])
        ),
      },
      state,
      alerts: open === null ? { status: "error", items: [], openCount: null } : { status: "ok", items: open.map((x) => presentAlert(x)), openCount: open.length },
      vitals: { status: sectionStatus(vitals), items: vitals },
      sharedWellbeing,
      sleep: r.sleepSummaries === ERROR ? { status: "error" } : { status: "ok", ...summarizeSleep(own(r.sleepSummaries), baseline.sleepDuration, now) },
      cognitive: r.cognitive === ERROR ? { status: "error", lastAt: 0 } : { status: "ok", lastAt: describeCognitive(own(r.cognitive)).lastAt },
      messages,
    };
  }

  return { getCrewSnapshot, getCrewMemberDetail };
}

const productionService = createCrewMonitorService({
  repos: Object.freeze({ usersRepo, astronautsRepo, measurementsRepo, dailySummariesRepo, alertsRepo, messagesRepo, wellbeingRepo, cognitiveRepo }),
  getMissionContext,
});

/** Crew-wide snapshot for the signed-in Medical Officer (real database). */
export function getCrewSnapshot(session, options) {
  return productionService.getCrewSnapshot(session, options);
}

/** One crew member's read-only detail for the signed-in Medical Officer (real database). */
export function getCrewMemberDetail(session, crewId, options) {
  return productionService.getCrewMemberDetail(session, crewId, options);
}
