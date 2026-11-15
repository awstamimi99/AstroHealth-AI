// js/engine/rules/exercise-rules.js — Daily Exercise Countermeasure: the
// demonstration readiness check, the daily plan and rule EX-01 (missed days).
//
// PURE and DETERMINISTIC: no database, page, clock or randomness. Threshold
// VALUES for readiness come from the stored settings.thresholds (passed in).
// This is a non-clinical DEMONSTRATION: the plan is not an exercise
// prescription, readiness is not a fitness-for-duty decision.
//
// EX-01 v1 (project KPI "Exercise: about 120 minutes a day · missed 1–2 days
// = be aware · missed 3+ days = danger"):
//   a day is MISSED when less than 30 min of aerobic + resistance exercise
//   was logged (completed or partial) on that UTC day; days are counted only
//   from the first day with any logged session (no history → not evaluated);
//   consecutive missed days ending YESTERDAY: 1–2 → warning, 3+ → critical;
//   clear → yesterday (or today so far) reached 30 min.

export const EXERCISE_TARGET_MIN = 120;
export const MISSED_DAY_MIN = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (t) => Math.floor(t / DAY_MS);
/** "YYYY-MM-DD" for a UTC day index — pure arithmetic (civil-from-days), no Date object. */
export function dayKeyOf(day) {
  const z = day + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const freeze = (o) => Object.freeze(o);

export const EXERCISE_LIMITATION =
  "Demonstration exercise rule based only on logged synthetic sessions. Not an exercise prescription, " +
  "not a fitness-for-duty decision, and it does not replace review by the Medical Officer.";

export const EXERCISE_RULE = Object.freeze({
  id: "EX-01",
  version: 1,
  type: "missed_exercise",
  title: "Missed exercise countermeasure",
  category: "physical",
  description: "Less than 30 minutes of aerobic + resistance exercise logged on consecutive UTC days",
  thresholdSource: "logged exercise sessions (demonstration rule, not clinically validated)",
  suggestedAction:
    "Medical officer review recommended. Follow the approved crew exercise protocol; this system does not prescribe exercise or treatment.",
});

export const DEVICES = Object.freeze({
  aerobic: Object.freeze(["Cycle ergometer", "Treadmill"]),
  resistance: Object.freeze(["Resistance exercise device"]),
  mobility: Object.freeze(["Mobility mat"]),
});
export const STOP_REASONS = Object.freeze(["Schedule conflict", "Felt fatigued", "Discomfort or pain", "Dizziness", "Equipment unavailable", "Medical Officer advised rest", "Other"]);
export const SYMPTOMS = Object.freeze(["dizziness", "pain", "shortness_of_breath", "nausea"]);

/** Countable minutes of one session (aerobic + resistance, completed or partial). */
export function countedMinutes(s) {
  if (!s || !["aerobic", "resistance"].includes(s.sessionType)) return 0;
  if (!["completed", "partial"].includes(s.completion)) return 0;
  return Number.isInteger(s.minutes) && s.minutes > 0 ? s.minutes : 0;
}

/** Minutes per UTC day index → { [day]: minutes } (aerobic + resistance only). */
export function minutesByDay(sessions) {
  const out = {};
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || !isNum(s.timestamp)) continue;
    const d = dayOf(s.timestamp);
    out[d] = (out[d] || 0) + countedMinutes(s);
  }
  return out;
}

/** Pure evaluation of EX-01. `sessions`: [{ timestamp, sessionType, minutes, completion }]. */
export function evaluateExerciseRule(sessions, now) {
  const list = (Array.isArray(sessions) ? sessions : []).filter((s) => s && isNum(s.timestamp) && s.timestamp <= now);
  const base = { ruleVersion: EXERCISE_RULE.version, evaluatedAt: now, considered: list.length, excluded: freeze({ suspect: 0, invalid: 0, stale: 0 }), limitation: EXERCISE_LIMITATION, thresholdUsed: `missed day = < ${MISSED_DAY_MIN} min aerobic + resistance · warning 1–2 missed days in a row · critical 3+` };
  if (!list.length) return freeze({ ...base, outcome: "insufficient", severity: null, reason: "no_exercise_history", evidence: freeze([]), explanation: "No exercise session has been logged yet, so this demonstration rule was not evaluated." });
  const byDay = minutesByDay(list);
  const today = dayOf(now);
  const first = Math.min(...list.map((s) => dayOf(s.timestamp)));
  const date = dayKeyOf;
  if ((byDay[today] || 0) >= MISSED_DAY_MIN || (today - 1 >= first && (byDay[today - 1] || 0) >= MISSED_DAY_MIN)) {
    const d = (byDay[today] || 0) >= MISSED_DAY_MIN ? today : today - 1;
    return freeze({ ...base, outcome: "clear", severity: null, reason: "", evidence: freeze([freeze({ metric: "exerciseMinutes", value: byDay[d], unit: "min", timestamp: d * DAY_MS, measurementId: "", source: "logged" })]), explanation: `${byDay[d]} min of aerobic + resistance exercise logged on ${date(d)} (at least ${MISSED_DAY_MIN} min).` });
  }
  let missed = 0;
  for (let d = today - 1; d >= first; d -= 1) {
    if ((byDay[d] || 0) >= MISSED_DAY_MIN) break;
    missed += 1;
  }
  if (!missed) return freeze({ ...base, outcome: "insufficient", severity: null, reason: "monitoring", evidence: freeze([]), explanation: "No completed UTC day to evaluate yet." });
  const days = Array.from({ length: missed }, (_, i) => today - missed + i);
  return freeze({
    ...base,
    outcome: "triggered",
    severity: missed >= 3 ? "critical" : "warning",
    reason: "missed_days",
    evidence: freeze(days.map((d) => freeze({ metric: "exerciseMinutes", value: byDay[d] || 0, unit: "min", timestamp: d * DAY_MS, measurementId: "", source: "logged" }))),
    explanation: `Less than ${MISSED_DAY_MIN} min of aerobic + resistance exercise on ${missed} UTC day${missed === 1 ? "" : "s"} in a row (${days.map((d) => `${date(d)}: ${byDay[d] || 0} min`).join(", ")}). Exercise is the main countermeasure for weightlessness; a review is recommended — this is not a diagnosis.`,
  });
}

/**
 * Readiness check from the latest stored values and the stored demonstration
 * thresholds (non-clinical). Each item: { key, label, value, unit, status: ok|caution|hold|unknown, note }.
 */
export function readinessCheck({ sleep, fatigue, heartRate, spo2, bpSystolic, bodyTemperature, openAlerts = [], yesterdayMinutes = 0 }, thresholds) {
  const t = (thresholds && thresholds.metrics) || {};
  const above = (v, m) => (isNum(v) && m ? (isNum(m.criticalHigh) && v >= m.criticalHigh ? "hold" : isNum(m.warningHigh) && v >= m.warningHigh ? "caution" : "ok") : "unknown");
  const below = (v, m) => (isNum(v) && m ? (isNum(m.criticalLow) && v < m.criticalLow ? "hold" : (isNum(m.warningLow) && v < m.warningLow) || (isNum(m.infoLow) && v < m.infoLow) ? "caution" : "ok") : "unknown");
  const worstAlert = openAlerts.some((a) => a.severity === "critical") ? "hold" : openAlerts.some((a) => a.severity === "warning") ? "caution" : "ok";
  const items = [
    { key: "sleep", label: "Last night's sleep", value: sleep, unit: "h", status: below(sleep, t.sleepDuration) },
    { key: "fatigue", label: "Fatigue (latest)", value: fatigue, unit: "/10", status: isNum(fatigue) ? (fatigue >= 9 ? "hold" : fatigue >= 7 ? "caution" : "ok") : "unknown" },
    { key: "heartRate", label: "Heart rate (latest)", value: heartRate, unit: "bpm", status: above(heartRate, t.heartRate) },
    { key: "spo2", label: "SpO₂ (latest)", value: spo2, unit: "%", status: below(spo2, t.spo2) },
    { key: "bpSystolic", label: "Systolic blood pressure (latest)", value: bpSystolic, unit: "mmHg", status: above(bpSystolic, t.bpSystolic) },
    { key: "bodyTemperature", label: "Body temperature (latest)", value: bodyTemperature, unit: "°C", status: above(bodyTemperature, t.bodyTemperature) === "ok" ? below(bodyTemperature, t.bodyTemperature) : above(bodyTemperature, t.bodyTemperature) },
    { key: "alerts", label: "Open physical alerts", value: openAlerts.length, unit: "", status: worstAlert },
    { key: "yesterday", label: "Yesterday's exercise", value: yesterdayMinutes, unit: "min", status: "ok" },
  ];
  const level = items.some((i) => i.status === "hold") ? "recovery" : items.some((i) => i.status === "caution") ? "reduced" : "standard";
  return { items, level };
}

/** Today's demonstration plan for a readiness level. `dayIndex` alternates the aerobic device. */
export function dailyPlan(level, readinessItems, dayIndex = 0) {
  const flagged = (readinessItems || []).filter((i) => i.status === "caution" || i.status === "hold").map((i) => i.label.toLowerCase());
  const why = flagged.length ? `Lower intensity because of: ${flagged.join(", ")}.` : "All readiness checks are in the usual range.";
  const aerobicDevice = DEVICES.aerobic[dayIndex % 2];
  if (level === "recovery") {
    return {
      level, targetMin: 0,
      headline: "Recovery day — talk to the Medical Officer before any aerobic or resistance session.",
      sessions: [
        { type: "mobility", device: "Mobility mat", plannedMin: 20, intensity: "light", reason: `Only gentle mobility today. ${why}` },
      ],
    };
  }
  const reduced = level === "reduced";
  return {
    level,
    targetMin: reduced ? 80 : EXERCISE_TARGET_MIN,
    headline: reduced ? "Reduced session today (lower duration and intensity)." : `Standard countermeasure: about ${EXERCISE_TARGET_MIN} min of aerobic + resistance exercise.`,
    sessions: [
      { type: "aerobic", device: aerobicDevice, plannedMin: reduced ? 40 : 60, intensity: reduced ? "light" : "moderate", reason: `Aerobic work supports heart and fluid regulation in weightlessness. ${why}` },
      { type: "resistance", device: "Resistance exercise device", plannedMin: reduced ? 40 : 60, intensity: reduced ? "light" : "moderate", reason: `Resistance work loads bones and muscles that weightlessness unloads. ${why}` },
      { type: "mobility", device: "Mobility mat", plannedMin: reduced ? 20 : 15, intensity: "light", reason: "Mobility and stretching for recovery (not counted toward the target)." },
    ],
  };
}
