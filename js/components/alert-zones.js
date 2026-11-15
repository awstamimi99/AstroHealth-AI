// js/components/alert-zones.js — presentation-only mapping from a demonstration
// rule id to a body-scan zone (js/components/body-scan.js). It decides only
// WHERE a pin is drawn; it never changes severity, wording or any data.

const RULE_ZONES = Object.freeze({
  "PHY-01": "heart",   // heart rate
  "PHY-02": "lungs",   // SpO₂
  "PHY-03": "arm",     // systolic blood pressure (cuff on the arm)
  "PHY-05": "head",    // sleep duration
  "WB-01": "head",     // wellbeing check-ins
  "PHY-06": "head",    // body temperature (forehead / skin sensor)
  "PHY-07": "head",
  "ENV-01": "lungs",   // cabin CO₂ — what the crew member breathes
  "ENV-02": "chest",   // cabin pressure
  "ENV-03": "chest",   // cabin humidity
  "EX-01": "legs",     // exercise countermeasure
});

/** Zone for a rule id; unknown rules use the chest so the pin is still visible. */
export function zoneForRule(ruleId) {
  return RULE_ZONES[ruleId] || "chest";
}

/** Readable body location for a zone. */
export const ZONE_LABELS = Object.freeze({
  head: "Head",
  chest: "Chest",
  heart: "Heart",
  lungs: "Chest (lungs)",
  arm: "Arm",
  abdomen: "Abdomen",
  "lower-back": "Lower back",
  legs: "Legs",
});

/** Which vital ring a zone belongs to (for the dashed connector lines). */
export const VITAL_ZONES = Object.freeze({
  heartRate: "heart",
  spo2: "lungs",
  bloodPressure: "arm",
  sleepDuration: "head",
});

/** Which vital ring a demonstration rule is about (rules without a ring map to nothing). */
export const RULE_VITALS = Object.freeze({
  "PHY-01": "heartRate",
  "PHY-02": "spo2",
  "PHY-03": "bloodPressure",
  "PHY-05": "sleepDuration",
});
const RANK = Object.freeze({ info: 1, warning: 2, critical: 3 });

/**
 * The most severe OPEN alert per vital ring, from alert items with { ruleId, severity }.
 * → { heartRate: "warning", … }. A ring without an entry has no open alert.
 * Deterministic and explainable: it only reads the rule id and stored severity.
 */
export function vitalSeverities(alerts) {
  const out = {};
  for (const a of Array.isArray(alerts) ? alerts : []) {
    if (a && a.status && a.status !== "new" && a.status !== "acknowledged") continue;
    const key = a && RULE_VITALS[a.ruleId];
    if (!key || !RANK[a.severity]) continue;
    if (!out[key] || RANK[a.severity] > RANK[out[key]]) out[key] = a.severity;
  }
  return out;
}
