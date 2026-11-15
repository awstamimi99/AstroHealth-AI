// js/db/seed-supplement.js — demo data added in SEED VERSION 2 (no schema change):
//
//   • bodyTemperature  every 2 h (skin/body temperature sensor)
//   • cabinCo2, cabinPressure, cabinHumidity  every 2 h from each crew
//     member's personal cabin-environment monitor
//   • exercise countermeasure sessions for the last 14 days
//     (missionEvents type "exercise_logged")
//
// Pure and deterministic: its OWN random generator (seed 149) and its OWN id
// series ("…_sx_00001"), so every value of seed version 1 stays identical.
// Used by buildSeedData() (fresh data / reset) and by upgradeDemoData()
// (browsers that were seeded with version 1). Everything is SYNTHETIC.
//
// Story:
//   all crew — cabin CO₂ rose for a few hours 4 days ago (below the warning
//              limit; shows the crew-wide air check)
//   a-02 Karim — skipped exercise 3 days ago (a single missed day)
//   a-03 Chen  — partial resistance session yesterday
//   a-04 Reyes — lighter sessions after the short nights; nothing logged today yet

import { createRng, clamp, round } from "./random.js";
import { summarize, applyToLatest, startOfUtcDay } from "./summaries.js";
import { DAY_MS, HOUR_MS, METRIC_UNITS, SYSTEM_USER } from "./constants.js";

export const SUPPLEMENT_SEED = 149;
export const SUPPLEMENT_METRICS = Object.freeze(["bodyTemperature", "cabinCo2", "cabinPressure", "cabinHumidity"]);
const RAW_DAYS = 7;
const HISTORY_DAYS = 30;
const EXERCISE_DAYS = 14;
const SAMPLE_MS = 2 * HOUR_MS;
const TEMP_BASE = Object.freeze({ "a-01": 36.7, "a-02": 36.6, "a-03": 36.8, "a-04": 36.7 });
/** Personal body-temperature baselines added to astronauts.baseline in seed version 2. */
export const TEMPERATURE_BASELINES = TEMP_BASE;

/** Standard daily plan used for the seeded history (demonstration, not a prescription). */
const PLAN = Object.freeze([
  { hour: 9, type: "aerobic", device: "Cycle ergometer", plannedMin: 60, intensity: "moderate" },
  { hour: 16, type: "resistance", device: "Resistance exercise device", plannedMin: 60, intensity: "moderate" },
  { hour: 20, type: "mobility", device: "Mobility mat", plannedMin: 15, intensity: "light" },
]);

const sid = (prefix, n) => `${prefix}_sx_${String(n).padStart(5, "0")}`;

/**
 * @param {{ now: number, astronauts: Array<{id: string, userId: string, name: string}> }} options
 * @returns {{ measurements: object[], allReadings: object[], dailySummaries: object[], missionEvents: object[],
 *             latest: Record<string, object>, baselines: Record<string, {bodyTemperature: number}> }}
 */
export function buildSeedSupplement({ now, astronauts }) {
  const rng = createRng(SUPPLEMENT_SEED);
  const counters = {};
  const nextId = (prefix) => sid(prefix, (counters[prefix] = (counters[prefix] || 0) + 1));
  const anchor = Math.floor(now / SAMPLE_MS) * SAMPLE_MS;
  const today = startOfUtcDay(now);
  const measurements = [];
  const allReadings = [];
  const missionEvents = [];

  const reading = (astronautId, metric, value, timestamp, sampleId) => ({
    id: nextId("msr"), astronautId, metric, value, unit: METRIC_UNITS[metric], timestamp,
    source: "seed", quality: "ok", sampleId, simulationRunId: "",
    createdAt: timestamp, updatedAt: timestamp, createdBy: SYSTEM_USER,
  });

  // ---- Body temperature + cabin environment every 2 h for 30 days (raw kept for 7) ----
  const total = HISTORY_DAYS * (DAY_MS / SAMPLE_MS);
  for (const a of astronauts) {
    const base = TEMP_BASE[a.id] ?? 36.7;
    for (let i = total - 1; i >= 0; i--) {
      const t = anchor - i * SAMPLE_MS;
      const ago = anchor - t;
      const hour = new Date(t).getUTCHours();
      const asleep = hour >= 22 || hour < 6;
      const n = { temp: rng.normal(0, 0.08), co2: rng.normal(0, 0.15), press: rng.normal(0, 0.08), hum: rng.normal(0, 2.5) };
      const afterExercise = hour === 10 || hour === 18; // sample right after a session
      const temperature = clamp(round(base + (asleep ? -0.25 : 0) + (afterExercise ? 0.3 : 0) + n.temp, 1), 36.2, 37.3);
      let co2 = clamp(round(2.5 + (asleep ? -0.3 : 0.3) + n.co2, 1), 1.8, 3.9);
      const daysAgo = Math.floor(ago / DAY_MS);
      if (daysAgo === 4 && hour >= 14 && hour <= 18) co2 = round(3.6 + Math.abs(n.co2) / 2, 1); // crew-wide CO₂ rise, below the warning limit
      const pressure = clamp(round(101.3 + n.press, 1), 100.9, 101.7);
      const humidity = clamp(round(47 + (asleep ? 3 : 0) + n.hum), 38, 60);
      const sampleId = nextId("smp");
      const rows = [
        reading(a.id, "bodyTemperature", temperature, t, sampleId),
        reading(a.id, "cabinCo2", co2, t, sampleId),
        reading(a.id, "cabinPressure", pressure, t, sampleId),
        reading(a.id, "cabinHumidity", humidity, t, sampleId),
      ];
      allReadings.push(...rows);
      if (ago < RAW_DAYS * DAY_MS) measurements.push(...rows);
    }
  }

  // ---- Exercise sessions: the last 14 days (today: only sessions already past) ----
  for (const a of astronauts) {
    for (let k = EXERCISE_DAYS - 1; k >= 0; k--) {
      for (const p of PLAN) {
        const t = today - k * DAY_MS + p.hour * HOUR_MS + 30 * 60 * 1000; // logged at the end of the hour
        const n = rng.normal(0, 1);
        if (t > now) continue;
        if (a.id === "a-04" && k === 0) continue; // Reyes: nothing logged today yet → daily reminder
        let completion = "completed";
        let minutes = p.plannedMin;
        let intensity = p.intensity;
        let stopReason = "";
        let rpe = clamp(Math.round((p.type === "mobility" ? 3 : 6) + n), 1, 10);
        if (a.id === "a-02" && k === 3) { completion = "skipped"; minutes = 0; stopReason = "Schedule conflict (mission task overran)"; rpe = 0; }
        if (a.id === "a-03" && k === 1 && p.type === "resistance") { completion = "partial"; minutes = 35; stopReason = "Felt fatigued"; }
        if (a.id === "a-04" && k >= 1 && k <= 3 && p.type !== "mobility") { intensity = "light"; minutes = 40; rpe = Math.min(rpe, 5); }
        const peakHeartRate = completion === "skipped" ? null : Math.round((p.type === "aerobic" ? 138 : p.type === "resistance" ? 118 : 88) + (intensity === "light" ? -15 : 0) + 4 * n);
        const recoveryHeartRate = peakHeartRate === null ? null : Math.round(peakHeartRate - (p.type === "mobility" ? 8 : 28) + 2 * n);
        const id = nextId("evt");
        const label = { aerobic: "Aerobic", resistance: "Resistance", mobility: "Mobility" }[p.type];
        missionEvents.push({
          id, timestamp: t, type: "exercise_logged", astronautId: a.id, actorUserId: a.userId, refStore: "", refId: "",
          summary: completion === "skipped" ? `${label} session skipped` : `${label} session ${completion}: ${minutes} min`,
          data: {
            sessionType: p.type, device: p.device, plannedMin: p.plannedMin, minutes, intensity, completion, rpe,
            stopReason, peakHeartRate, recoveryHeartRate, postFatigue: completion === "skipped" ? null : clamp(Math.round(3 + (p.type === "mobility" ? -1 : 1) + n), 0, 10),
            symptoms: [], source: "seed",
          },
          createdAt: t, updatedAt: t, createdBy: a.userId,
        });
      }
    }
  }

  const latest = {};
  for (const a of astronauts) {
    let l = {};
    for (const m of measurements) if (m.astronautId === a.id) l = applyToLatest(l, m).latest;
    latest[a.id] = l;
  }
  return {
    measurements,
    allReadings,
    dailySummaries: summarize(allReadings, now),
    missionEvents,
    latest,
    baselines: Object.fromEntries(astronauts.map((a) => [a.id, { bodyTemperature: TEMP_BASE[a.id] ?? 36.7 }])),
  };
}
