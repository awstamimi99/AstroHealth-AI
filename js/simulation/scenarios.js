// js/simulation/scenarios.js — the reviewed Simulation Center catalog (Sprint 7).
//
// PURE and STATIC: no imports, no side effects, no randomness, no clock.
// Every value is a deterministic function of (scenario, start value, step),
// so the same run always produces the same synthetic readings.
//
// Each scenario has 12 steps: 5 ramp steps from the start value to the
// target, 2 hold steps at the target, 5 recovery steps back to the start
// value. Values are whole numbers; the final value equals the start value.
//
//   step n (1…12), R = 5 ramp steps, H = 2 hold steps
//     n ≤ R          start + (target − start) · n / R
//     R < n ≤ R + H  target
//     n > R + H      target + (start − target) · (n − R − H) / R
//   rounded with Math.round (fractions are multiples of 0.2, never .5)
//
// Synthetic demonstration data only. These curves are not physiological
// models and make no clinical claim. No risk rule is evaluated in Sprint 7;
// a later Risk Engine sprint may evaluate low SpO₂ (low_oxygen) and
// elevated heart rate (elevated_heart_rate) readings.
//
// Metric names and units match the database's canonical units
// (METRIC_UNITS in js/db/constants.js); a unit test checks this.

export const CATALOG_VERSION = 1;

/** Real time between two steps at 1× speed. Interval = BASE_STEP_MS / speed. */
export const BASE_STEP_MS = 8000;

/** Allowed demo speeds (simulationRuns.speed). Fixed when a run starts. */
export const SIMULATION_SPEEDS = Object.freeze([1, 2, 4, 8]);
export const DEFAULT_SPEED = 1;

export const SCENARIO_DISCLAIMER =
  "Synthetic demonstration data for research and education. Not a medical device, " +
  "not clinically validated, and not affiliated with or endorsed by NASA.";

const PHASES = Object.freeze({ ramp: 5, hold: 2, recovery: 5 });
const TOTAL_STEPS = PHASES.ramp + PHASES.hold + PHASES.recovery;

export const SCENARIOS = Object.freeze([
  Object.freeze({
    id: "low_oxygen",
    name: "Low oxygen saturation demonstration",
    description:
      "A synthetic SpO₂ reading falls step by step to 88 %, holds for two steps, then returns to its starting value. " +
      "For demonstrating monitoring displays only.",
    metric: "spo2",
    metricLabel: "SpO₂",
    unit: "%",
    target: 88,
    defaultStart: 98,
    startRange: Object.freeze({ min: 94, max: 100 }),
    phases: PHASES,
    totalSteps: TOTAL_STEPS,
    disclaimer: SCENARIO_DISCLAIMER,
  }),
  Object.freeze({
    id: "elevated_heart_rate",
    name: "Elevated heart rate demonstration",
    description:
      "A synthetic heart-rate reading rises step by step to 128 bpm, holds for two steps, then returns to its starting value. " +
      "For demonstrating monitoring displays only.",
    metric: "heartRate",
    metricLabel: "Heart rate",
    unit: "bpm",
    target: 128,
    defaultStart: 72,
    startRange: Object.freeze({ min: 50, max: 95 }),
    phases: PHASES,
    totalSteps: TOTAL_STEPS,
    disclaimer: SCENARIO_DISCLAIMER,
  }),
]);

/** The scenario with this id, or null. */
export function getScenario(id, list = SCENARIOS) {
  return (Array.isArray(list) ? list : []).find((s) => s && s.id === id) || null;
}

/** "ramp" | "hold" | "recovery" for a step (1…totalSteps), or "" if out of range. */
export function scenarioPhase(scenario, step) {
  if (!scenario || !Number.isInteger(step) || step < 1 || step > scenario.totalSteps) return "";
  if (step <= scenario.phases.ramp) return "ramp";
  if (step <= scenario.phases.ramp + scenario.phases.hold) return "hold";
  return "recovery";
}

/**
 * The whole-number value of one step. Throws RangeError for a step outside
 * 1…totalSteps or a non-integer start value (programming errors).
 */
export function scenarioValue(scenario, startValue, step) {
  if (!scenario || typeof scenario !== "object") throw new RangeError("scenarioValue: unknown scenario");
  if (!Number.isInteger(startValue)) throw new RangeError("scenarioValue: start value must be a whole number");
  if (!Number.isInteger(step) || step < 1 || step > scenario.totalSteps) throw new RangeError(`scenarioValue: step must be 1…${scenario.totalSteps}`);
  const { ramp, hold } = scenario.phases;
  const { target } = scenario;
  if (step <= ramp) return Math.round(startValue + ((target - startValue) * step) / ramp);
  if (step <= ramp + hold) return target;
  return Math.round(target + ((startValue - target) * (step - ramp - hold)) / ramp);
}

/** All steps: a frozen array of { step, value, phase }, oldest first. */
export function scenarioSequence(scenario, startValue) {
  const steps = [];
  for (let step = 1; step <= scenario.totalSteps; step += 1) {
    steps.push(Object.freeze({ step, value: scenarioValue(scenario, startValue, step), phase: scenarioPhase(scenario, step) }));
  }
  return Object.freeze(steps);
}

/**
 * Start value: the stored personal baseline for the scenario's metric when
 * it is a finite number inside the scenario's start range (rounded to a
 * whole number); otherwise the catalog default.
 * @returns {{ value: number, source: "baseline" | "default" }}
 */
export function resolveScenarioStartValue(scenario, astronautBaseline) {
  const raw = astronautBaseline && typeof astronautBaseline === "object" ? astronautBaseline[scenario.metric] : undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const rounded = Math.round(raw);
    if (rounded >= scenario.startRange.min && rounded <= scenario.startRange.max) return { value: rounded, source: "baseline" };
  }
  return { value: scenario.defaultStart, source: "default" };
}

/** Real milliseconds between steps at a speed. */
export function stepIntervalMs(speed) {
  return BASE_STEP_MS / speed;
}
