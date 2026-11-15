// Demonstration wellbeing rule evaluated after an astronaut explicitly shares
// a daily check-in. Private check-ins never reach this rule (the astronaut
// still sees checkinConcerns() for their own private check-in on screen).
//
// WB-01 v3 — deterministic, explainable, self-reported scores only:
//   concern in the latest shared check-in: mood ≤ 2/5, overall wellbeing ≤ 2/5,
//     sleep quality ≤ 2/5, stress ≥ 7/10, isolation ≥ 7/10, fatigue ≥ 8/10
//   trend: mood falling on each of the last 3 shared check-ins
//   info     → one concern (or the falling-mood trend)
//   warning  → 2+ concerns, a severe combination (mood or wellbeing 1/5 with
//              stress or isolation ≥ 8/10), or a concern in each of the last
//              3 shared check-ins (sustained)
//   critical → mood 1–2/5 in each of the last 3 shared check-ins on 3
//              different UTC days ("1–2 for 3+ days" in the project KPIs)
//   clear    → 2 consecutive stable shared check-ins (condition cleared; the
//              Medical Officer still resolves the alert)

export const WELLBEING_LIMITATION =
  "Demonstration wellbeing pattern based only on self-reported, shared check-ins. " +
  "This is not a diagnosis, crisis assessment, or clinical recommendation.";

export const WELLBEING_RULE = Object.freeze({
  id: "WB-01",
  version: 3,
  type: "supportive_checkin",
  title: "Supportive check-in recommended",
  category: "wellbeing",
  description: "A shared daily check-in reports a concerning wellbeing pattern",
  thresholdSource: "shared self-reported daily check-ins (demonstration rule, not clinically validated)",
  suggestedAction:
    "Medical officer review recommended. Use approved crew-support protocol; this system does not diagnose or prescribe treatment.",
});

const isNumber = (v) => typeof v === "number" && Number.isFinite(v);
const freeze = (value) => Object.freeze(value);

function usable(record) {
  return Boolean(
    record && record.sharedWithMedical === 1 && typeof record.id === "string" &&
    isNumber(record.timestamp) && isNumber(record.mood) && isNumber(record.stress) &&
    isNumber(record.fatigue) && isNumber(record.isolation) && isNumber(record.wellbeing)
  );
}

/** Concerns in ONE check-in (any record with the six scores). Pure; used on screen too. */
export function checkinConcerns(c) {
  const reasons = [];
  if (!c) return reasons;
  if (isNumber(c.mood) && c.mood <= 2) reasons.push(`low mood (${c.mood}/5)`);
  if (isNumber(c.wellbeing) && c.wellbeing <= 2) reasons.push(`low overall wellbeing (${c.wellbeing}/5)`);
  if (isNumber(c.sleepQuality) && c.sleepQuality <= 2) reasons.push(`poor sleep quality (${c.sleepQuality}/5)`);
  if (isNumber(c.stress) && c.stress >= 7) reasons.push(`high stress (${c.stress}/10)`);
  if (isNumber(c.isolation) && c.isolation >= 7) reasons.push(`high isolation (${c.isolation}/10)`);
  if (isNumber(c.fatigue) && c.fatigue >= 8) reasons.push(`high fatigue (${c.fatigue}/10)`);
  return reasons;
}
const concernOf = checkinConcerns;

function stable(c) {
  return checkinConcerns(c).length === 0;
}

function evidenceOf(c) {
  return freeze({
    metric: "wellbeing",
    value: c.wellbeing,
    unit: "/5",
    timestamp: c.timestamp,
    measurementId: c.id,
    source: typeof c.source === "string" ? c.source : "manual",
  });
}

/** Pure evaluation of WB-01. Records may be in any order. */
export function evaluateWellbeingRule(records, now) {
  const shared = (Array.isArray(records) ? records : [])
    .filter((c) => usable(c) && c.timestamp <= now)
    .sort((a, b) => b.timestamp - a.timestamp);
  const newest = shared[0];
  const excluded = freeze({ private: (Array.isArray(records) ? records : []).filter((c) => c && c.sharedWithMedical !== 1).length, invalid: 0, suspect: 0, stale: 0 });
  const base = { ruleVersion: WELLBEING_RULE.version, evaluatedAt: now, considered: shared.length, excluded, limitation: WELLBEING_LIMITATION };

  if (!newest) return freeze({ ...base, outcome: "insufficient", severity: null, reason: "no_shared_checkin", evidence: freeze([]), explanation: "No shared check-in is available for this demonstration rule.", thresholdUsed: "Shared daily check-in pattern" });

  const reasons = concernOf(newest);
  const last3 = shared.slice(0, 3);
  const three = last3.length === 3;
  const falling = three && last3[0].mood < last3[1].mood && last3[1].mood < last3[2].mood;
  const sustained = three && last3.every((c) => concernOf(c).length > 0);
  const days = new Set(last3.map((c) => Math.floor(c.timestamp / 86400000))).size;
  const lowMood3Days = three && days === 3 && last3.every((c) => c.mood <= 2);
  if (reasons.length || falling) {
    const all = [...reasons, ...(falling ? [`mood falling on 3 shared check-ins in a row (${[...last3].reverse().map((c) => c.mood).join(" → ")}/5)`] : [])];
    const severe = (newest.mood <= 1 || newest.wellbeing <= 1) && (newest.stress >= 8 || newest.isolation >= 8);
    const severity = lowMood3Days ? "critical" : severe || reasons.length >= 2 || sustained ? "warning" : "info";
    const why = lowMood3Days ? " Mood was 1–2/5 in each of the last 3 shared check-ins on 3 different days."
      : sustained ? " A concern was reported in each of the last 3 shared check-ins." : "";
    return freeze({
      ...base,
      outcome: "triggered",
      severity,
      reason: "shared_checkin_pattern",
      evidence: freeze((sustained || falling || lowMood3Days ? [...last3].reverse() : [newest]).map(evidenceOf)),
      explanation: `The latest shared check-in reports ${all.join(", ")}.${why} A supportive review is recommended; this is not a diagnosis.`,
      thresholdUsed: "Info: mood/wellbeing/sleep quality ≤ 2/5, stress/isolation ≥ 7/10, fatigue ≥ 8/10, or mood falling over 3 check-ins · Warning: 2+ concerns, a severe combination, or concerns in 3 check-ins in a row · Critical: mood 1–2/5 in 3 check-ins on 3 days",
    });
  }

  if (shared.length >= 2 && shared.slice(0, 2).every(stable)) {
    return freeze({
      ...base,
      outcome: "clear",
      severity: null,
      reason: "two_stable_shared_checkins",
      evidence: freeze(shared.slice(0, 2).reverse().map(evidenceOf)),
      explanation: "The two latest shared check-ins do not meet the demonstration concern pattern. The condition is marked cleared pending Medical Officer review.",
      thresholdUsed: "Two consecutive shared check-ins outside the demonstration concern pattern",
    });
  }

  return freeze({
    ...base,
    outcome: "insufficient",
    severity: null,
    reason: "monitoring",
    evidence: freeze([evidenceOf(newest)]),
    explanation: "The latest shared check-in does not meet the concern pattern; another stable shared check-in is needed before an existing condition is marked cleared.",
    thresholdUsed: "Two consecutive shared check-ins outside the demonstration concern pattern",
  });
}
