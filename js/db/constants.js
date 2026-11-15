// js/db/constants.js
// Names, units and allowed values used by the database. Pure module.
// Import these instead of typing strings by hand — a typo then becomes an
// undefined variable instead of a silent bug.

/** User id used for things the app does by itself. */
export const SYSTEM_USER = "system";

/** astronautId used for crew-wide events and reports. */
export const CREW = "crew";

export const ROLES = Object.freeze({
  ASTRONAUT: "astronaut",
  MEDICAL_OFFICER: "medical_officer",
});

// ---- Measurements --------------------------------------------------------

/** Every metric that can be stored in the measurements store. */
export const METRICS = Object.freeze([
  "heartRate", "spo2", "bpSystolic", "bpDiastolic", "sleepDuration", "activity", "fatigue",
  // Added in seed version 2 (no schema change — `metric` is not an index key on its own):
  "bodyTemperature",                                  // skin/body temperature sensor
  "cabinCo2", "cabinPressure", "cabinHumidity",       // the crew member's personal cabin-environment monitor
]);

/** Canonical units. The DB stores ONLY these — convert in the UI. */
export const METRIC_UNITS = Object.freeze({
  heartRate: "bpm",
  spo2: "%",
  bpSystolic: "mmHg",
  bpDiastolic: "mmHg",
  sleepDuration: "h",      // hours, decimals allowed
  activity: "steps",       // cumulative steps since 00:00 UTC that day
  fatigue: "0-10",
  bodyTemperature: "°C",
  cabinCo2: "mmHg",        // partial pressure of CO₂ (ppCO₂) at the crew member's location
  cabinPressure: "kPa",    // total cabin pressure
  cabinHumidity: "%RH",    // relative humidity
});

/** Exercise countermeasure log (missionEvents type "exercise_logged", seed version 2). */
export const EXERCISE_TYPES = Object.freeze(["aerobic", "resistance", "mobility"]);
export const EXERCISE_INTENSITIES = Object.freeze(["light", "moderate", "vigorous"]);
export const EXERCISE_COMPLETIONS = Object.freeze(["completed", "partial", "skipped"]);

/** Scales used by wellbeing check-ins (inclusive min, max). */
export const WELLBEING_SCALES = Object.freeze({
  mood: [1, 5],
  stress: [0, 10],
  sleepQuality: [1, 5],
  fatigue: [0, 10],
  isolation: [0, 10],
  wellbeing: [1, 5],
});

export const SOURCES = Object.freeze(["seed", "simulation", "manual"]);
export const QUALITIES = Object.freeze(["ok", "suspect", "invalid"]);

// ---- Alerts --------------------------------------------------------------

export const SEVERITIES = Object.freeze(["info", "warning", "critical"]);
export const ALERT_STATUSES = Object.freeze(["new", "acknowledged", "resolved"]);
/** "Open" alerts = still need attention. */
export const OPEN_ALERT_STATUSES = Object.freeze(["new", "acknowledged"]);
export const ALERT_CATEGORIES = Object.freeze(["physical", "wellbeing", "environment"]);
export const ALERT_ACTIONS = Object.freeze([
  "created", "escalated", "acknowledged", "condition_cleared", "resolved",
]);

// ---- Simulation ----------------------------------------------------------

export const SIMULATION_STATUSES = Object.freeze(["running", "paused", "stopped", "completed"]);
export const ACTIVE_SIMULATION_STATUSES = Object.freeze(["running", "paused"]);

// ---- Timeline ------------------------------------------------------------

export const EVENT_TYPES = Object.freeze([
  "measurement_recorded", "risk_detected", "alert_generated", "alert_escalated",
  "alert_acknowledged", "alert_condition_cleared", "alert_resolved",
  "message_sent", "message_acknowledged", "astronaut_response",
  "checkin_completed", "cognitive_check_completed",
  "simulation_started", "simulation_paused", "simulation_stopped",
  "settings_changed", "report_generated", "data_reset", "data_imported",
  "exercise_logged",
]);

// ---- Settings & meta keys ------------------------------------------------

export const SETTINGS_KEYS = Object.freeze([
  "mission", "units", "notifications", "simulation", "display", "thresholds",
]);

export const META_KEYS = Object.freeze([
  "schemaVersion", "seededAt", "seedVersion", "alertCounter", "lastCompactedAt",
]);

/** Fields stored as 0/1 numbers (IndexedDB can't index booleans). */
export const FLAG_FIELDS = Object.freeze(["sharedWithMedical", "conditionCleared"]);

// ---- Time ----------------------------------------------------------------

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
