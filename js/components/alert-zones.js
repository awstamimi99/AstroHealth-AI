// js/components/alert-zones.js — presentation-only mapping from a demonstration
// rule id to a body-scan zone (js/components/body-scan.js). It decides only
// WHERE a pin is drawn; it never changes severity, wording or any data.

const RULE_ZONES = Object.freeze({
  "PHY-01": "heart",   // heart rate
  "PHY-02": "lungs",   // SpO₂
  "PHY-03": "arm",     // systolic blood pressure (cuff on the arm)
  "PHY-05": "head",    // sleep duration
  "WB-01": "head",     // wellbeing check-ins
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
