// js/services/astronaut-overview-service.js — data for the astronaut Overview (#/overview)
//
//   import { getAstronautOverview } from "../services/astronaut-overview-service.js";
//   const overview = await getAstronautOverview(session);
//
// WHAT IT DOES
//   Reads (never writes) the signed-in astronaut's OWN records and turns them
//   into presentation-safe data: open alerts, latest vital signs, today's
//   routine, the last 7 nights of sleep and any unacknowledged message from
//   the Medical Officer. All records are SYNTHETIC demo data.
//
// PRIVACY & AUTHORIZATION (enforced here — repositories don't check callers)
//   • Identity comes ONLY from session.userId + session.astronautId. Any
//     astronautId passed in `options` is ignored.
//   • role must be "astronaut"; usersRepo must confirm the same user and
//     astronautId; the astronaut profile must exist. Only then is health data read.
//   • Every returned record is re-checked to belong to that astronaut.
//   • The private journal is never read. Wellbeing scores are never returned
//     (only "completed today" and shared/private).
//   • A message is shown as "from the Medical Officer" only after its sender
//     is verified in usersRepo (role medical_officer, astronautId ""). Sender
//     ids are never returned.
//
// NOT A HEALTH ASSESSMENT
//   The overall status is derived ONLY from stored open alerts (status "new"
//   or "acknowledged"). Readings are never compared with thresholds here.
//   "No open alerts" means exactly that — never "healthy" or "safe".
//
// ERRORS
//   Never throws. Identity/profile/database problems → { status: "forbidden" |
//   "unavailable", reason }. After identity checks, each section loads on its
//   own (Promise.allSettled), so one failed section never hides the others.
//
// TEST SEAM
//   createAstronautOverviewService({ repos, getMissionContext }) exists ONLY so
//   unit tests can use the in-memory mock repositories. Pages must use
//   getAstronautOverview(), which is bound to the real database. Injection
//   can't change WHO is asking: identity always comes from the session and is
//   verified against usersRepo inside the same function.

import {
  usersRepo,
  astronautsRepo,
  measurementsRepo,
  dailySummariesRepo,
  alertsRepo,
  messagesRepo,
  wellbeingRepo,
  cognitiveRepo,
  toDateKey,
  dateKeyToStart,
  ROLES,
  METRIC_UNITS,
  SEVERITIES,
  OPEN_ALERT_STATUSES,
  HOUR_MS,
  DAY_MS,
} from "../db/index.js";
import { getMissionContext, MISSION_UNAVAILABLE } from "./mission-service.js";

// ---- Rules (approved Sprint 4 decisions) ------------------------------------

/** D5: vital signs older than this are shown as stale ("no newer reading"). */
export const VITALS_STALE_MS = 24 * HOUR_MS;
/** D5: a sleep reading older than this is stale (sleep is recorded once a day). */
export const SLEEP_STALE_MS = 36 * HOUR_MS;
/** How many recent raw readings to look through for the newest usable one. */
export const RECENT_READINGS_LIMIT = 12;
/** D9: number of UTC dates in the sleep trend. */
export const SLEEP_NIGHTS = 7;
/** Maximum open alerts listed on the Overview (the rest are counted). */
export const MAX_LISTED_ALERTS = 3;
/** Shown under the overall status. */
export const STATUS_NOTE = "Based on your open alerts only. This is not a health assessment.";

const SOURCES_SIMULATED = ["seed", "simulation"];
const QUALITY_RANK = { ok: 0, suspect: 1 }; // invalid readings are never used
const SEVERITY_RANK = { info: 1, warning: 2, critical: 3 };

/** D2: overall alert states (colour token + icon + text are all set by the page). */
export const OVERALL_STATES = Object.freeze({
  critical: Object.freeze({ level: "critical", label: "Critical", icon: "circle-alert", tone: "critical" }),
  watch: Object.freeze({ level: "watch", label: "Watch", icon: "triangle-alert", tone: "warning" }),
  info: Object.freeze({ level: "info", label: "Info", icon: "info", tone: "info" }),
  clear: Object.freeze({ level: "clear", label: "No open alerts", icon: "circle-check", tone: "ok" }),
  unavailable: Object.freeze({ level: "unavailable", label: "Status unavailable", icon: "eye-off", tone: "neutral" }),
});

const VITALS = Object.freeze([
  { key: "heartRate", label: "Heart rate", metric: "heartRate", staleMs: VITALS_STALE_MS },
  { key: "spo2", label: "SpO₂", metric: "spo2", staleMs: VITALS_STALE_MS },
  { key: "bloodPressure", label: "Blood pressure", metric: null, staleMs: VITALS_STALE_MS },
  { key: "sleepDuration", label: "Sleep duration", metric: "sleepDuration", staleMs: SLEEP_STALE_MS },
]);

// ---- Small pure helpers -----------------------------------------------------

const isText = (value) => typeof value === "string" && value.trim() !== "";
const isTime = (value) => typeof value === "number" && Number.isFinite(value);
const isUsable = (reading) =>
  Boolean(reading) && reading.quality !== "invalid" && reading.quality in QUALITY_RANK &&
  typeof reading.value === "number" && Number.isFinite(reading.value) && isTime(reading.timestamp);

/** "YYYY-MM-DD" (UTC) for a timestamp. */
export function utcDateKey(timestamp) {
  return toDateKey(timestamp);
}

/** True when both timestamps fall on the same UTC calendar day. */
export function isSameUtcDay(a, b) {
  return isTime(a) && isTime(b) && toDateKey(a) === toDateKey(b);
}

/** The `count` UTC dates ending with `todayKey`, oldest first. */
export function lastUtcDates(todayKey, count = SLEEP_NIGHTS) {
  const end = dateKeyToStart(todayKey);
  return Array.from({ length: count }, (_, i) => toDateKey(end - (count - 1 - i) * DAY_MS));
}

/** Age of a reading in ms and whether it is stale. Future timestamps are not stale. */
export function describeAge(timestamp, now, staleMs) {
  const ageMs = now - timestamp;
  return { ageMs, stale: ageMs > staleMs };
}

const provenance = (source) => ({
  source: SOURCES_SIMULATED.includes(source) || source === "manual" ? source : "unknown",
  simulated: SOURCES_SIMULATED.includes(source),
});

/**
 * Newest usable reading (quality ok/suspect) from a list sorted oldest → newest.
 * @returns {{state:"ok", value, unit, timestamp, ageMs, stale, quality, source, simulated}
 *          | {state:"empty", invalidOnly:boolean}}
 */
export function selectLatestUsable(readings, { now, staleMs }) {
  const list = Array.isArray(readings) ? readings : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (!isUsable(r)) continue;
    return {
      state: "ok",
      value: r.value,
      unit: isText(r.unit) ? r.unit : METRIC_UNITS[r.metric] || "",
      timestamp: r.timestamp,
      ...describeAge(r.timestamp, now, staleMs),
      quality: r.quality,
      ...provenance(r.source),
    };
  }
  return { state: "empty", invalidOnly: list.length > 0 };
}

/**
 * Newest COMPLETE blood-pressure reading: systolic + diastolic with the SAME
 * sampleId. Never combines readings from different samples.
 * @returns {{state:"ok", systolic, diastolic, unit, timestamp, ageMs, stale, quality, source, simulated}
 *          | {state:"incomplete"} | {state:"empty", invalidOnly:boolean}}
 */
export function pairBloodPressure(systolicReadings, diastolicReadings, { now, staleMs }) {
  const sys = Array.isArray(systolicReadings) ? systolicReadings : [];
  const dia = Array.isArray(diastolicReadings) ? diastolicReadings : [];
  const diastolicBySample = new Map();
  for (const d of dia) {
    if (isUsable(d) && isText(d.sampleId)) diastolicBySample.set(d.sampleId, d);
  }
  for (let i = sys.length - 1; i >= 0; i--) {
    const s = sys[i];
    if (!isUsable(s) || !isText(s.sampleId)) continue;
    const d = diastolicBySample.get(s.sampleId);
    if (!d) continue;
    const quality = QUALITY_RANK[d.quality] > QUALITY_RANK[s.quality] ? d.quality : s.quality;
    const sources = [s.source, d.source];
    return {
      state: "ok",
      systolic: s.value,
      diastolic: d.value,
      unit: isText(s.unit) ? s.unit : METRIC_UNITS.bpSystolic,
      timestamp: s.timestamp,
      ...describeAge(s.timestamp, now, staleMs),
      quality,
      source: provenance(s.source).source,
      simulated: sources.some((src) => SOURCES_SIMULATED.includes(src)),
    };
  }
  const anyUsable = sys.some(isUsable) || dia.some(isUsable);
  if (anyUsable) return { state: "incomplete" };
  return { state: "empty", invalidOnly: sys.length + dia.length > 0 };
}

/** Sort: most severe first, then newest, then alert number (deterministic). */
function bySeverityThenNewest(a, b) {
  return (
    (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0) ||
    b.detectedAt - a.detectedAt ||
    String(a.number).localeCompare(String(b.number))
  );
}

/** Title for display: the stored title, else the type made readable, else "Alert". */
function alertTitle(alert) {
  if (isText(alert.title)) return alert.title.trim();
  if (isText(alert.type)) {
    const words = alert.type.replace(/[_-]+/g, " ").trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return "Alert";
}

/**
 * Overall alert state from the astronaut's OPEN alerts.
 * critical > warning > info > none. Acknowledging does not lower severity.
 * `openAlerts === null` means the alert query failed → "Status unavailable".
 */
export function deriveOverallStatus(openAlerts) {
  if (!Array.isArray(openAlerts)) {
    return { ...OVERALL_STATES.unavailable, openAlertCount: null, summary: "Your alerts couldn't be loaded, so no alert status is shown.", note: STATUS_NOTE };
  }
  const open = openAlerts.filter((a) => a && OPEN_ALERT_STATUSES.includes(a.status));
  if (!open.length) {
    return {
      ...OVERALL_STATES.clear,
      openAlertCount: 0,
      summary: "None of your stored alerts is open (new or acknowledged).",
      note: STATUS_NOTE,
    };
  }
  const top = Math.max(...open.map((a) => SEVERITY_RANK[a.severity] || SEVERITY_RANK.info));
  const state = top === 3 ? OVERALL_STATES.critical : top === 2 ? OVERALL_STATES.watch : OVERALL_STATES.info;
  const highest = SEVERITIES[top - 1];
  return {
    ...state,
    openAlertCount: open.length,
    summary: `${open.length} open alert${open.length === 1 ? "" : "s"} · highest severity: ${highest}.`,
    note: STATUS_NOTE,
  };
}

/** Wellbeing check-in: completed today (UTC) or not, and shared/private. No scores. */
export function describeCheckin(latestCheckin, now) {
  if (!latestCheckin || !isTime(latestCheckin.timestamp)) {
    return { state: "not_done", completedAt: 0, lastAt: 0, shared: null };
  }
  const shared = latestCheckin.sharedWithMedical === 1;
  if (isSameUtcDay(latestCheckin.timestamp, now) && latestCheckin.timestamp <= now) {
    return { state: "done", completedAt: latestCheckin.timestamp, lastAt: latestCheckin.timestamp, shared };
  }
  return { state: "not_done", completedAt: 0, lastAt: latestCheckin.timestamp, shared: null };
}

/** Latest vital-sign time: recorded today (UTC), earlier, or none. */
export function describeVitalsRoutine(lastVitalAt, now) {
  if (!isTime(lastVitalAt) || lastVitalAt <= 0) return { state: "none", lastAt: 0 };
  return { state: isSameUtcDay(lastVitalAt, now) ? "today" : "earlier", lastAt: lastVitalAt };
}

/** D8: last completed cognitive check only — never "due" or "overdue". */
export function describeCognitive(checks) {
  const times = (Array.isArray(checks) ? checks : []).map((c) => c && c.timestamp).filter(isTime);
  if (!times.length) return { state: "none", lastAt: 0 };
  return { state: "recorded", lastAt: Math.max(...times) };
}

/**
 * D9: the last 7 UTC dates of sleep. Missing nights stay `null` (never 0).
 * No judgement — only counts and averages.
 */
export function summarizeSleep(summaries, baselineHours, now) {
  const dates = lastUtcDates(toDateKey(now), SLEEP_NIGHTS);
  const byDate = new Map();
  for (const s of Array.isArray(summaries) ? summaries : []) {
    if (s && dates.includes(s.date) && typeof s.avg === "number" && Number.isFinite(s.avg) && s.count > 0) {
      byDate.set(s.date, s.avg);
    }
  }
  const nights = dates.map((date) => ({ date, hours: byDate.has(date) ? byDate.get(date) : null }));
  const values = nights.map((n) => n.hours).filter((h) => h !== null);
  const baseline = typeof baselineHours === "number" && Number.isFinite(baselineHours) ? baselineHours : null;
  return {
    nights,
    recorded: values.length,
    average: values.length ? values.reduce((sum, h) => sum + h, 0) / values.length : null,
    baseline,
    belowBaseline: baseline === null ? null : values.filter((h) => h < baseline).length,
  };
}

// ---- Identity -----------------------------------------------------------------

const refusal = (status, reason, now) => ({ status, reason, generatedAt: now });

/** Check the session, then confirm it against the stored user and astronaut. */
async function resolveIdentity(session, repos, now) {
  if (!session || typeof session !== "object") return refusal("forbidden", "no_session", now);
  if (session.role !== ROLES.ASTRONAUT) return refusal("forbidden", "not_astronaut", now);
  if (!isText(session.userId) || !isText(session.astronautId)) return refusal("forbidden", "invalid_session", now);

  let user;
  try {
    user = await repos.usersRepo.getById(session.userId);
  } catch {
    return refusal("unavailable", "database_error", now);
  }
  if (!user || user.id !== session.userId || user.role !== ROLES.ASTRONAUT || user.astronautId !== session.astronautId) {
    return refusal("forbidden", "account_mismatch", now);
  }

  let astronaut;
  try {
    astronaut = await repos.astronautsRepo.getById(session.astronautId);
  } catch {
    return refusal("unavailable", "database_error", now);
  }
  if (!astronaut || astronaut.id !== session.astronautId) return refusal("unavailable", "profile_missing", now);
  return { status: "ok", user, astronaut };
}

// ---- Section builders -----------------------------------------------------------

/** Settled promise → value, or the marker ERROR. */
const ERROR = Symbol("error");
const valueOf = (settled) => (settled.status === "fulfilled" ? settled.value : ERROR);

/** Keep only records that belong to this astronaut (defence in depth). */
const own = (list, astronautId) => (Array.isArray(list) ? list.filter((r) => r && r.astronautId === astronautId) : []);

function buildAlerts(result, astronautId) {
  if (result === ERROR) return { section: { status: "error", items: [], openCount: null, moreCount: 0 }, open: null };
  const open = own(result, astronautId)
    .filter((a) => OPEN_ALERT_STATUSES.includes(a.status))
    .sort(bySeverityThenNewest);
  const items = open.slice(0, MAX_LISTED_ALERTS).map((a) => ({
    number: isText(a.number) ? a.number : "",
    title: alertTitle(a),
    severity: SEVERITIES.includes(a.severity) ? a.severity : "info",
    status: a.status,
    category: isText(a.category) ? a.category : "",
    detectedAt: isTime(a.detectedAt) ? a.detectedAt : 0,
    explanation: isText(a.explanation) ? a.explanation : "",
    synthetic: true, // every record in this prototype is synthetic
  }));
  return {
    section: { status: "ok", items, openCount: open.length, moreCount: Math.max(0, open.length - items.length) },
    open,
  };
}

function buildVitals(lists, astronaut, now) {
  const baseline = astronaut.baseline || {};
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const items = VITALS.map((v) => {
    const base = { key: v.key, label: v.label };
    if (v.key === "bloodPressure") {
      const sys = lists.bpSystolic;
      const dia = lists.bpDiastolic;
      const bpBaseline =
        num(baseline.bpSystolic) !== null && num(baseline.bpDiastolic) !== null
          ? { systolic: baseline.bpSystolic, diastolic: baseline.bpDiastolic }
          : null;
      if (sys === ERROR || dia === ERROR) return { ...base, unit: METRIC_UNITS.bpSystolic, state: "error", baseline: bpBaseline };
      return {
        ...base,
        unit: METRIC_UNITS.bpSystolic,
        baseline: bpBaseline,
        ...pairBloodPressure(own(sys, astronaut.id), own(dia, astronaut.id), { now, staleMs: v.staleMs }),
      };
    }
    const list = lists[v.metric];
    const metricBaseline = num(baseline[v.metric]);
    if (list === ERROR) return { ...base, unit: METRIC_UNITS[v.metric], state: "error", baseline: metricBaseline };
    return {
      ...base,
      unit: METRIC_UNITS[v.metric],
      baseline: metricBaseline,
      ...selectLatestUsable(own(list, astronaut.id), { now, staleMs: v.staleMs }),
    };
  });
  const failed = items.filter((i) => i.state === "error").length;
  return { status: failed === 0 ? "ok" : failed === items.length ? "error" : "partial", items };
}

/** A stored account that may be shown as "the Medical Officer". */
const isMedicalOfficer = (user, userId) =>
  Boolean(user) && user.id === userId && user.role === ROLES.MEDICAL_OFFICER && user.astronautId === "";

/**
 * Unacknowledged messages FROM A VERIFIED MEDICAL OFFICER, newest first.
 * The sender is never assumed: each distinct fromUserId is looked up once
 * (concurrently) and only accounts with role "medical_officer" and
 * astronautId "" count. Unknown, astronaut-authored or malformed senders are
 * skipped. If a sender lookup fails, only this section reports an error.
 * Sender ids are never returned.
 */
async function buildMessages(result, astronautId, usersRepository) {
  if (result === ERROR) return { status: "error", latest: null, moreCount: 0 };
  // Cheap checks first — rejected messages never cause an account lookup.
  const candidates = own(result, astronautId)
    .filter((m) => m.acknowledgedAt === 0 && isTime(m.sentAt) && isText(m.fromUserId))
    .sort((a, b) => b.sentAt - a.sentAt);
  if (!candidates.length) return { status: "ok", latest: null, moreCount: 0 };

  const senderIds = [...new Set(candidates.map((m) => m.fromUserId))];
  let senders;
  try {
    senders = await Promise.all(senderIds.map((id) => Promise.resolve().then(() => usersRepository.getById(id))));
  } catch {
    return { status: "error", latest: null, moreCount: 0 };
  }
  const verified = new Set(senderIds.filter((id, i) => isMedicalOfficer(senders[i], id)));
  const fromOfficer = candidates.filter((m) => verified.has(m.fromUserId));
  if (!fromOfficer.length) return { status: "ok", latest: null, moreCount: 0 };
  const [m] = fromOfficer;
  return {
    status: "ok",
    latest: { sentAt: m.sentAt, body: typeof m.body === "string" ? m.body : "", from: "Medical Officer" },
    moreCount: fromOfficer.length - 1,
  };
}

function buildRoutine({ checkin, cognitive, vitalLists }, astronautId, now) {
  // Wellbeing: completion + shared/private only (no scores leave this function).
  const checkinPart =
    checkin === ERROR
      ? { status: "error" }
      : { status: "ok", ...describeCheckin(checkin && checkin.astronautId === astronautId ? checkin : null, now) };

  // Vitals: newest usable reading among HR, SpO₂ and blood pressure.
  const sources = ["heartRate", "spo2", "bpSystolic", "bpDiastolic"].map((m) => vitalLists[m]);
  const loaded = sources.filter((l) => l !== ERROR);
  let vitalsPart;
  if (!loaded.length) {
    vitalsPart = { status: "error" };
  } else {
    const times = loaded.flatMap((l) => own(l, astronautId).filter(isUsable).map((r) => r.timestamp));
    vitalsPart = {
      status: "ok",
      partial: loaded.length < sources.length,
      ...describeVitalsRoutine(times.length ? Math.max(...times) : 0, now),
    };
  }

  const cognitivePart =
    cognitive === ERROR ? { status: "error" } : { status: "ok", ...describeCognitive(own(cognitive, astronautId)) };

  const parts = [checkinPart, vitalsPart, cognitivePart];
  const failed = parts.filter((p) => p.status === "error").length;
  return {
    status: failed === 0 ? "ok" : failed === parts.length ? "error" : "partial",
    today: toDateKey(now),
    checkin: checkinPart,
    vitals: vitalsPart,
    cognitive: cognitivePart,
  };
}

function buildSleep(result, astronaut, now) {
  if (result === ERROR) return { status: "error" };
  const summaries = Array.isArray(result) ? result.filter((s) => s && s.astronautId === astronaut.id) : [];
  const baseline = astronaut.baseline ? astronaut.baseline.sleepDuration : null;
  return { status: "ok", ...summarizeSleep(summaries, baseline, now) };
}

// ---- Service ---------------------------------------------------------------------

/**
 * TEST SEAM — see the header. Production code uses getAstronautOverview().
 * @param {{ repos: object, getMissionContext: (session) => Promise<object> }} deps
 */
export function createAstronautOverviewService({ repos, getMissionContext: loadMission }) {
  /**
   * @param {object} session  the signed-in session (getSession())
   * @param {{ now?: number }} [options]  only `now` is read; nothing else can
   *   change which astronaut is loaded.
   */
  async function getOverview(session, options = {}) {
    const now = options && Number.isFinite(options.now) ? options.now : Date.now();
    const identity = await resolveIdentity(session, repos, now);
    if (identity.status !== "ok") return identity;

    const { user, astronaut } = identity;
    const aid = astronaut.id; // == session.astronautId, verified above
    const today = toDateKey(now);
    const sleepDates = lastUtcDates(today, SLEEP_NIGHTS);
    const attempt = (fn) => Promise.resolve().then(fn); // a synchronous throw becomes a rejection

    // Independent reads, all at once. One failure only affects its own section.
    const keys = ["heartRate", "spo2", "bpSystolic", "bpDiastolic", "sleepDuration", "sleepSummaries", "alerts", "messages", "checkin", "cognitive", "mission"];
    const settled = await Promise.allSettled([
      attempt(() => repos.measurementsRepo.getRecent(aid, "heartRate", RECENT_READINGS_LIMIT)),
      attempt(() => repos.measurementsRepo.getRecent(aid, "spo2", RECENT_READINGS_LIMIT)),
      attempt(() => repos.measurementsRepo.getRecent(aid, "bpSystolic", RECENT_READINGS_LIMIT)),
      attempt(() => repos.measurementsRepo.getRecent(aid, "bpDiastolic", RECENT_READINGS_LIMIT)),
      attempt(() => repos.measurementsRepo.getRecent(aid, "sleepDuration", RECENT_READINGS_LIMIT)),
      attempt(() => repos.dailySummariesRepo.getRange(aid, "sleepDuration", sleepDates[0], sleepDates[sleepDates.length - 1])),
      attempt(() => repos.alertsRepo.query({ astronautId: aid, status: [...OPEN_ALERT_STATUSES] })),
      attempt(() => repos.messagesRepo.getUnacknowledged(aid)),
      attempt(() => repos.wellbeingRepo.getLatest(aid)),
      attempt(() => repos.cognitiveRepo.getRange(aid, undefined, now)),
      attempt(() => loadMission(session)),
    ]);
    const r = Object.fromEntries(keys.map((k, i) => [k, valueOf(settled[i])]));

    const vitalLists = {
      heartRate: r.heartRate,
      spo2: r.spo2,
      bpSystolic: r.bpSystolic,
      bpDiastolic: r.bpDiastolic,
      sleepDuration: r.sleepDuration,
    };
    const alerts = buildAlerts(r.alerts, aid);
    const mission = r.mission === ERROR || !r.mission ? MISSION_UNAVAILABLE : r.mission;

    return {
      status: "ready",
      reason: "",
      generatedAt: now,
      today,
      astronaut: {
        displayName: isText(user.displayName) ? user.displayName : astronaut.name,
        name: astronaut.name,
        crewId: astronaut.crewId,
        missionRole: astronaut.missionRole,
        initials: astronaut.initials,
      },
      mission: { available: Boolean(mission.available), name: mission.name, missionDay: mission.missionDay },
      overall: deriveOverallStatus(alerts.open),
      alerts: alerts.section,
      vitals: buildVitals(vitalLists, astronaut, now),
      messages: await buildMessages(r.messages, aid, repos.usersRepo),
      routine: buildRoutine({ checkin: r.checkin, cognitive: r.cognitive, vitalLists }, aid, now),
      sleep: buildSleep(r.sleepSummaries, astronaut, now),
    };
  }

  return { getAstronautOverview: getOverview };
}

const productionService = createAstronautOverviewService({
  repos: Object.freeze({
    usersRepo,
    astronautsRepo,
    measurementsRepo,
    dailySummariesRepo,
    alertsRepo,
    messagesRepo,
    wellbeingRepo,
    cognitiveRepo,
  }),
  getMissionContext,
});

/**
 * The astronaut Overview for the signed-in session (real database).
 * @param {object} session
 * @param {{ now?: number }} [options]
 */
export function getAstronautOverview(session, options) {
  return productionService.getAstronautOverview(session, options);
}
