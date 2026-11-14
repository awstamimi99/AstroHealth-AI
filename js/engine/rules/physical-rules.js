// js/engine/rules/physical-rules.js — the Sprint 8 demonstration rule catalog.
//
// PURE and STATIC: no imports, no side effects, no clock, no randomness.
// Threshold VALUES are never defined here: they come from the stored
// settings.thresholds record (seeded "Demonstration thresholds — not
// clinically validated") and are passed in by the caller. The catalog only
// says which stored keys a rule uses and how they are compared.
//
// These are DEMONSTRATION rules for a research and educational prototype.
// They are not evidence-backed, not medical guidance, not clinical standards
// and not NASA thresholds. Every result carries DEMO_LIMITATION.
//
// Comparison kinds ("bound" = the stored threshold value):
//   below      — qualifies when value <  bound; clear when value >= warning bound
//   above      — qualifies when value >  bound; clear when value <= warning bound
//   atOrAbove  — qualifies when value >= bound; clear when value <  warning bound

export const DEMO_THRESHOLD_LABEL = "Demonstration threshold — not clinically validated.";
export const THRESHOLD_SOURCE = "settings.thresholds (demonstration values, not clinically validated)";
export const DEMO_LIMITATION =
  "Demonstration threshold — not clinically validated. Based on synthetic data only. " +
  "This is not a diagnosis and does not replace review by the Medical Officer.";
export const SUGGESTED_ACTION =
  "Medical officer review recommended. Follow approved crew medical protocol — this system does not prescribe treatment.";

/** Staleness windows (ms): readings older than this never trigger, escalate or clear. */
export const VITAL_STALE_MS = 24 * 60 * 60 * 1000;
export const SLEEP_STALE_MS = 36 * 60 * 60 * 1000;

export const PHYSICAL_RULES = Object.freeze([
  Object.freeze({
    id: "PHY-01",
    version: 2,
    kind: "consecutive",
    metric: "heartRate",
    label: "Heart rate",
    type: "elevated_heart_rate",
    title: "Elevated heart rate",
    category: "physical",
    compare: "above",
    keys: Object.freeze({ warning: "warningHigh", critical: "criticalHigh" }),
    count: 2,
    clearCount: 2,
    staleMs: VITAL_STALE_MS,
    description: "Heart rate above the stored demonstration threshold on 2 consecutive usable readings",
  }),
  Object.freeze({
    id: "PHY-02",
    version: 1,
    kind: "consecutive",
    metric: "spo2",
    label: "SpO₂",
    type: "low_spo2",
    title: "Low SpO₂",
    category: "physical",
    compare: "below",
    keys: Object.freeze({ warning: "warningLow", critical: "criticalLow" }),
    count: 2,
    clearCount: 2,
    staleMs: VITAL_STALE_MS,
    description: "SpO₂ below the stored demonstration threshold on 2 consecutive usable readings",
  }),
  Object.freeze({
    id: "PHY-03",
    version: 1,
    kind: "consecutive",
    metric: "bpSystolic",
    label: "Systolic blood pressure",
    type: "elevated_blood_pressure",
    title: "Elevated blood pressure",
    category: "physical",
    compare: "atOrAbove",
    keys: Object.freeze({ warning: "warningHigh", critical: "criticalHigh" }),
    count: 2,
    clearCount: 2,
    staleMs: VITAL_STALE_MS,
    description: "Systolic blood pressure at or above the stored demonstration threshold on 2 consecutive usable readings",
  }),
  Object.freeze({
    id: "PHY-05",
    version: 1,
    kind: "nightly",
    metric: "sleepDuration",
    label: "Sleep duration",
    type: "reduced_sleep",
    title: "Reduced sleep duration",
    category: "physical",
    compare: "below",
    keys: Object.freeze({ warning: "warningLow", critical: "criticalLow" }),
    count: 3,
    clearCount: 1,
    staleMs: SLEEP_STALE_MS,
    description: "Sleep below the stored demonstration threshold on 3 consecutive UTC nights",
  }),
]);

/** The rule with this id, or null. */
export function getRule(id, list = PHYSICAL_RULES) {
  return (Array.isArray(list) ? list : []).find((r) => r && r.id === id) || null;
}

/** Does `value` meet `bound` for this comparison kind? */
export function qualifies(compare, value, bound) {
  if (compare === "below") return value < bound;
  if (compare === "above") return value > bound;
  if (compare === "atOrAbove") return value >= bound;
  return false;
}

/** Is `value` in the clear range relative to the WARNING bound? */
export function inClearRange(compare, value, warningBound) {
  if (compare === "below") return value >= warningBound;
  if (compare === "above") return value <= warningBound;
  if (compare === "atOrAbove") return value < warningBound;
  return false;
}

const SYMBOL = { below: "<", above: ">", atOrAbove: "≥" };
/** "< 95 %" etc. */
export function boundText(compare, bound, unit) {
  return `${SYMBOL[compare] || "?"} ${bound} ${unit}`;
}
