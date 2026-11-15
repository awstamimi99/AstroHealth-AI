// js/db/seed-data.js
// Builds the demo data set as plain arrays — NO database access, so Node
// tests and the mock repositories can use it too. seed.js writes it.
//
// Deterministic: all randomness comes from createRng(147), so the VALUES
// are identical every time. Timestamps are relative to `now`, so the data
// always ends at the moment of seeding. Everything here is SYNTHETIC.
//
// Story (matches the design mock-ups):
//   a-01 Haddad — elevated blood pressure 2 days ago  → ALT-0181 resolved
//   a-02 Karim  — elevated heart rate yesterday       → ALT-0184 resolved
//   a-03 Chen   — mood falling, stress rising         → ALT-0189 info, new
//   a-04 Reyes  — short sleep the last 3 nights       → ALT-0190 warning, acknowledged

import { createRng, clamp, round } from "./random.js";
import { seedId } from "./ids.js";
import { summarize, applyToLatest, startOfUtcDay, toDateKey } from "./summaries.js";
import { DAY_MS, HOUR_MS, METRIC_UNITS, MINUTE_MS, ROLES, SYSTEM_USER } from "./constants.js";
import { buildSeedSupplement } from "./seed-supplement.js";

/** 2 = body temperature, cabin environment and exercise sessions (js/db/seed-supplement.js). */
export const SEED_VERSION = 2;
export const DEMO_SEED = 147;
export const DEMO_PASSWORD = "demo";
export const SEED_ALERT_COUNTER = 190;
/** Mission Day shown on the day the data is seeded. */
export const SEED_MISSION_DAY = 147;

const RAW_DAYS = 7;        // raw vitals kept for the last 7 days
const HISTORY_DAYS = 30;   // summaries / sleep / check-ins cover 30 days
const SAMPLE_MS = 2 * HOUR_MS;
const MO = "u-medofficer";
const MO_NAME = "Dr. Lena Ortiz";

export const SEED_ASTRONAUTS = [
  { id: "a-01", crewId: "AH-01", name: "Sami Haddad", missionRole: "Commander", age: 41, initials: "SH",
    userId: "u-haddad", baseline: { heartRate: 72, spo2: 98, bpSystolic: 118, bpDiastolic: 76, sleepDuration: 7.0 } },
  { id: "a-02", crewId: "AH-02", name: "Aisha Karim", missionRole: "Flight Engineer", age: 36, initials: "AK",
    userId: "u-karim", baseline: { heartRate: 64, spo2: 98, bpSystolic: 112, bpDiastolic: 72, sleepDuration: 7.4 } },
  { id: "a-03", crewId: "AH-03", name: "Mei Chen", missionRole: "Mission Specialist", age: 33, initials: "MC",
    userId: "u-chen", baseline: { heartRate: 68, spo2: 97, bpSystolic: 110, bpDiastolic: 70, sleepDuration: 7.2 } },
  { id: "a-04", crewId: "AH-04", name: "Jonas Reyes", missionRole: "Payload Specialist", age: 38, initials: "JR",
    userId: "u-reyes", baseline: { heartRate: 70, spo2: 98, bpSystolic: 122, bpDiastolic: 80, sleepDuration: 7.1 } },
];

export const SEED_USERS = [
  { id: "u-medbackup", username: "medbackup", displayName: "Medical Officer Backup", role: ROLES.MEDICAL_OFFICER, astronautId: "" },
  { id: "u-medofficer", username: "medofficer", displayName: MO_NAME, role: ROLES.MEDICAL_OFFICER, astronautId: "" },
  { id: "u-haddad", username: "haddad", displayName: "Cmdr. Sami Haddad", role: ROLES.ASTRONAUT, astronautId: "a-01" },
  { id: "u-karim", username: "karim", displayName: "Dr. Aisha Karim", role: ROLES.ASTRONAUT, astronautId: "a-02" },
  { id: "u-chen", username: "chen", displayName: "Mei Chen", role: ROLES.ASTRONAUT, astronautId: "a-03" },
  { id: "u-reyes", username: "reyes", displayName: "Jonas Reyes", role: ROLES.ASTRONAUT, astronautId: "a-04" },
];

/** Demonstration thresholds — NOT clinically validated. */
export const DEMO_THRESHOLDS = {
  label: "Demonstration thresholds — not clinically validated",
  metrics: {
    heartRate: { warningLow: 50, criticalLow: 40, warningHigh: 100, criticalHigh: 120 },
    spo2: { infoLow: 95, warningLow: 93, criticalLow: 90 }, // 95–100 % none · 93–94 info · 90–92 warning · < 90 critical
    bpSystolic: { warningLow: 90, criticalLow: 80, warningHigh: 140, criticalHigh: 160 },
    bpDiastolic: { warningLow: 60, criticalLow: 50, warningHigh: 90, criticalHigh: 100 },
    sleepDuration: { warningLow: 6.5, criticalLow: 5 },
    fatigue: { warningHigh: 7, criticalHigh: 9 },
    // Seed version 2 (project KPI bands; demonstration values, not clinically validated):
    bodyTemperature: { warningHigh: 37.5, criticalHigh: 38.5, warningLow: 36.1, criticalLow: 35 },
    cabinCo2: { warningHigh: 4, criticalHigh: 6 },        // ppCO₂ mmHg
    cabinPressure: { warningLow: 98, criticalLow: 95 },   // kPa
    cabinHumidity: { warningHigh: 70, criticalHigh: 80 }, // %RH
  },
};

/**
 * Build every record of the demo data set.
 * @param {object} [options]
 * @param {number} [options.now]   "current time" in ms (default Date.now())
 * @param {number} [options.seed]  random seed (default 147)
 * @returns {Record<string, object[]>} one array per store name
 */
export function buildSeedData({ now = Date.now(), seed = DEMO_SEED } = {}) {
  const rng = createRng(seed);

  // Deterministic ids: "msr_seed_00001", "msr_seed_00002", …
  const counters = {};
  const nextId = (prefix) => seedId(prefix, (counters[prefix] = (counters[prefix] || 0) + 1));

  // Never create anything in the future.
  const soon = (t, delta) => Math.min(t + delta, now);

  const anchor = Math.floor(now / SAMPLE_MS) * SAMPLE_MS; // newest 2-hour mark ≤ now
  const today = startOfUtcDay(now);
  const lastAt = (hour) => (today + hour * HOUR_MS <= now ? today + hour * HOUR_MS : today + hour * HOUR_MS - DAY_MS);
  const wake0 = lastAt(6);    // newest 06:00 UTC ≤ now — sleep is recorded on waking
  const checkin0 = lastAt(8); // newest 08:00 UTC ≤ now — daily check-in

  const data = {
    users: [], astronauts: [], measurements: [], dailySummaries: [], wellbeingAssessments: [],
    privateJournal: [], cognitiveChecks: [], simulationRuns: [], alerts: [], alertActions: [],
    messages: [], missionEvents: [], reports: [], settings: [], meta: [],
  };
  const allReadings = []; // includes "already compacted" older readings, for summaries
  const userOf = Object.fromEntries(SEED_ASTRONAUTS.map((a) => [a.id, a.userId]));

  const measurement = (astronautId, metric, value, timestamp, sampleId, quality = "ok") => ({
    id: nextId("msr"), astronautId, metric, value, unit: METRIC_UNITS[metric], timestamp,
    source: "seed", quality, sampleId, simulationRunId: "",
    createdAt: timestamp, updatedAt: timestamp, createdBy: SYSTEM_USER,
  });

  const event = (type, timestamp, astronautId, actorUserId, refStore, refId, summary, extra) => {
    data.missionEvents.push({
      id: nextId("evt"), timestamp, type, astronautId, actorUserId, refStore, refId, summary,
      ...(extra ? { data: extra } : {}),
      createdAt: timestamp, updatedAt: timestamp, createdBy: actorUserId,
    });
  };

  // ---- Users & astronauts ------------------------------------------------
  for (const u of SEED_USERS) {
    data.users.push({ ...u, createdAt: now, updatedAt: now, createdBy: SYSTEM_USER });
  }

  // ---- Vital signs every 2 hours for 30 days (raw kept for 7) ------------
  const samplesPerDay = DAY_MS / SAMPLE_MS;
  const totalSamples = HISTORY_DAYS * samplesPerDay;
  const special = {}; // remember readings the alert story points to

  for (const a of SEED_ASTRONAUTS) {
    const b = a.baseline;
    let stepDay = "";
    let steps = 0;

    for (let i = totalSamples - 1; i >= 0; i--) {
      const t = anchor - i * SAMPLE_MS;
      const ago = anchor - t;
      const hour = new Date(t).getUTCHours();
      const asleep = hour >= 22 || hour < 6; // mission clock = UTC

      // Always draw the same number of random values per sample, so the
      // sequence never depends on the time of day.
      const n = {
        hr: rng.normal(0, 2.5), spo2: rng.normal(0, 0.6), sys: rng.normal(0, 4),
        dia: rng.normal(0, 3), steps: rng.int(250, 1100), fatigue: rng.normal(0, 0.6),
      };

      let hr = round(b.heartRate + (asleep ? -8 : 3) + n.hr);
      let spo2 = clamp(round(b.spo2 + n.spo2), 94, 100);
      let sys = round(b.bpSystolic + (asleep ? -6 : 0) + n.sys);
      let dia = round(b.bpDiastolic + (asleep ? -4 : 0) + n.dia);
      const hoursAwake = asleep ? 0 : hour - 6;
      const fatigue = clamp(round(1.5 + hoursAwake * 0.35 + n.fatigue), 0, 10);

      if (toDateKey(t) !== stepDay) { stepDay = toDateKey(t); steps = 0; }
      if (!asleep) steps += n.steps; // activity = cumulative steps since 00:00 UTC

      let hrQuality = "ok";
      let spo2Quality = "ok";

      // --- story anomalies ---
      if (a.id === "a-01") {                       // elevated BP, 2 days ago
        const bp = { [2 * DAY_MS + 4 * HOUR_MS]: [142, 91], [2 * DAY_MS + 2 * HOUR_MS]: [146, 93], [2 * DAY_MS]: [144, 92] }[ago];
        if (bp) [sys, dia] = bp;
      }
      if (a.id === "a-02") {                       // elevated heart rate, yesterday
        const v = { [DAY_MS + 4 * HOUR_MS]: 92, [DAY_MS + 2 * HOUR_MS]: 96, [DAY_MS]: 91 }[ago];
        if (v) hr = v;
      }
      if (a.id === "a-03" && ago === 3 * DAY_MS + 2 * HOUR_MS) { spo2 = 72; spo2Quality = "suspect"; } // sensor glitch
      if (a.id === "a-04" && ago === 5 * DAY_MS + 4 * HOUR_MS) { hr = 178; hrQuality = "suspect"; }   // motion artefact

      const sampleId = nextId("smp");
      const readings = [
        measurement(a.id, "heartRate", hr, t, sampleId, hrQuality),
        measurement(a.id, "spo2", spo2, t, sampleId, spo2Quality),
        measurement(a.id, "bpSystolic", sys, t, sampleId),
        measurement(a.id, "bpDiastolic", dia, t, sampleId),
        measurement(a.id, "activity", steps, t, sampleId),
        measurement(a.id, "fatigue", fatigue, t, sampleId),
      ];
      allReadings.push(...readings);
      if (ago < RAW_DAYS * DAY_MS) data.measurements.push(...readings);

      for (const r of readings) special[`${a.id}:${r.metric}:${ago}`] = r;
    }
  }

  // ---- Sleep: one reading per night for 30 days --------------------------
  const sleepByAstronaut = {};
  for (const a of SEED_ASTRONAUTS) {
    sleepByAstronaut[a.id] = [];
    for (let k = HISTORY_DAYS - 1; k >= 0; k--) {
      const t = wake0 - k * DAY_MS;
      let hours = clamp(round(a.baseline.sleepDuration + rng.normal(0, 0.35), 1), 5.5, 8.8);
      if (a.id === "a-04" && k <= 2) hours = [5.8, 5.3, 5.6][k]; // short nights → ALT-0190
      const r = measurement(a.id, "sleepDuration", hours, t, nextId("smp"));
      data.measurements.push(r);
      allReadings.push(r);
      sleepByAstronaut[a.id][k] = r;
      event("measurement_recorded", t, a.id, SYSTEM_USER, "measurements", r.id, `Sleep ${hours} h recorded`,
        { metric: "sleepDuration", value: hours });
    }
  }

  // One timeline event per astronaut per day for the raw vital-sign batches.
  const batches = new Map();
  for (const m of data.measurements) {
    if (m.metric !== "heartRate") continue; // one per sample is enough to count
    const key = `${m.astronautId}|${toDateKey(m.timestamp)}`;
    const batch = batches.get(key) || { astronautId: m.astronautId, count: 0, from: m.timestamp, to: m.timestamp };
    batch.count += 1;
    batch.from = Math.min(batch.from, m.timestamp);
    batch.to = Math.max(batch.to, m.timestamp);
    batches.set(key, batch);
  }
  for (const b of batches.values()) {
    event("measurement_recorded", b.to, b.astronautId, SYSTEM_USER, "measurements", "",
      `${b.count} vital-sign samples recorded`, { samples: b.count, from: b.from, to: b.to });
  }

  // ---- Daily summaries for 30 days ---------------------------------------
  data.dailySummaries = summarize(allReadings, now);

  // ---- Astronauts with their "latest" cache ------------------------------
  for (const a of SEED_ASTRONAUTS) {
    let latest = {};
    for (const m of data.measurements) {
      if (m.astronautId === a.id) latest = applyToLatest(latest, m).latest;
    }
    const { userId, ...profile } = a;
    data.astronauts.push({ ...profile, baseline: { ...a.baseline }, latest, createdAt: now, updatedAt: now, createdBy: SYSTEM_USER });
  }

  // ---- Daily wellbeing check-ins (30 days) -------------------------------
  const checkins = {};
  const score = (v, [min, max]) => clamp(round(v), min, max);
  for (const a of SEED_ASTRONAUTS) {
    checkins[a.id] = [];
    for (let k = HISTORY_DAYS - 1; k >= 0; k--) {
      const t = checkin0 - k * DAY_MS;
      const p = (HISTORY_DAYS - 1 - k) / (HISTORY_DAYS - 1); // 0 = oldest … 1 = today
      const n = [0, 1, 2, 3, 4, 5].map(() => rng.normal(0, 0.5));
      let v;
      if (a.id === "a-03") {
        v = { mood: 4.2 - 1.8 * p, stress: 3 + 4 * p, sleepQuality: 3.8 - 0.8 * p, fatigue: 3 + 2 * p, isolation: 3 + 4 * p, wellbeing: 4 - 1.8 * p };
      } else if (a.id === "a-02") {
        v = { mood: 4.3, stress: 2.5, sleepQuality: 4.2, fatigue: 2.5, isolation: 2, wellbeing: 4.3 };
      } else {
        v = { mood: 4, stress: 3.5, sleepQuality: 4, fatigue: 3, isolation: 2.5, wellbeing: 4 };
      }
      const record = {
        mood: score(v.mood + n[0], [1, 5]),
        stress: score(v.stress + 1.5 * n[1], [0, 10]),
        sleepQuality: score(v.sleepQuality + n[2], [1, 5]),
        fatigue: score(v.fatigue + 1.5 * n[3], [0, 10]),
        isolation: score(v.isolation + 1.5 * n[4], [0, 10]),
        wellbeing: score(v.wellbeing + n[5], [1, 5]),
      };
      if (a.id === "a-03" && k <= 3) {           // low mood on 3 of the last 4, stress rising
        record.mood = [2, 2, 3, 2][k];
        record.stress = [7, 7, 6, 6][k];
      }
      if (a.id === "a-04" && k <= 2) {           // short nights show up in the check-in too
        record.sleepQuality = 2;
        record.fatigue = [7, 7, 6][k];
      }
      const shared = a.id === "a-01" && [4, 11, 19].includes(k) ? 0 : 1;
      const wba = {
        id: nextId("wba"), astronautId: a.id, timestamp: t, ...record, sharedWithMedical: shared, source: "seed",
        createdAt: t, updatedAt: t, createdBy: a.userId,
      };
      data.wellbeingAssessments.push(wba);
      checkins[a.id][k] = wba;
      // Privacy: no scores in the timeline when the check-in isn't shared.
      if (shared) {
        event("checkin_completed", t, a.id, a.userId, "wellbeingAssessments", wba.id,
          `Daily check-in · mood ${wba.mood}/5 · stress ${wba.stress}/10`, { mood: wba.mood, stress: wba.stress, shared: 1 });
      } else {
        event("checkin_completed", t, a.id, a.userId, "wellbeingAssessments", wba.id,
          "Daily check-in completed (not shared with the medical officer)", { shared: 0 });
      }
    }
  }

  // ---- Private journal (never in the timeline) ---------------------------
  const journal = (astronautId, t, text) => {
    data.privateJournal.push({ id: nextId("jnl"), astronautId, timestamp: t, text,
      createdAt: t, updatedAt: t, createdBy: userOf[astronautId] });
  };
  journal("a-01", checkin0 - DAY_MS + 50 * MINUTE_MS, "Good EVA prep session today. Slept a little better.");
  journal("a-03", checkin0 - 2 * DAY_MS + 45 * MINUTE_MS, "Long day in the lab module. Missing home more than usual.");
  journal("a-03", soon(checkin0, 45 * MINUTE_MS), "Harder to switch off at night. Will try the evening routine again.");

  // ---- Cognitive checks ---------------------------------------------------
  const cognitive = { "a-01": [[301, 0], [296, 0]], "a-02": [[284, 0], [279, 0]], "a-03": [[309, 0], [336, 1]], "a-04": [[305, 0], [342, 1]] };
  for (const a of SEED_ASTRONAUTS) {
    [6, 1].forEach((k, i) => {
      const t = checkin0 - k * DAY_MS + 30 * MINUTE_MS;
      const [meanReactionMs, misses] = cognitive[a.id][i];
      const c = { id: nextId("cog"), astronautId: a.id, timestamp: t, meanReactionMs, trials: 10, misses,
        createdAt: t, updatedAt: t, createdBy: a.userId };
      data.cognitiveChecks.push(c);
      event("cognitive_check_completed", t, a.id, a.userId, "cognitiveChecks", c.id,
        `Cognitive check · ${meanReactionMs} ms mean reaction`, { meanReactionMs, misses });
    });
  }

  // ---- Alerts with full history ------------------------------------------
  const trig = (m) => ({ metric: m.metric, value: m.value, unit: m.unit, timestamp: m.timestamp, measurementId: m.id });
  const suggested = "Medical officer review recommended. Follow approved crew medical protocol — this system does not prescribe treatment.";

  function addAlert(a) {
    const id = nextId("alr");
    const last = Math.max(a.detectedAt, a.acknowledgedAt || 0, a.clearedAt || 0, a.resolvedAt || 0);
    const alert = {
      id, number: a.number, astronautId: a.astronautId, ruleId: a.rule.id, dedupeKey: `${a.astronautId}:${a.rule.id}`,
      type: a.type, category: a.category, severity: a.severity, status: a.status, title: a.title,
      detectedAt: a.detectedAt, lastTriggeredAt: a.lastTriggeredAt ?? a.detectedAt, occurrenceCount: a.occurrenceCount ?? 1,
      triggeringMeasurements: a.triggering, rule: a.rule, explanation: a.explanation, suggestedAction: a.suggestedAction,
      conditionCleared: a.clearedAt ? 1 : 0,
      acknowledgedAt: a.acknowledgedAt || 0, acknowledgedBy: a.acknowledgedAt ? MO : "",
      resolvedAt: a.resolvedAt || 0, resolvedBy: a.resolvedAt ? MO : "", resolutionNote: a.resolutionNote || "",
      createdAt: a.detectedAt, updatedAt: last, createdBy: SYSTEM_USER,
    };
    data.alerts.push(alert);

    const action = (name, t, userId, note = "") =>
      data.alertActions.push({ id: nextId("act"), alertId: id, action: name, userId, timestamp: t, note,
        createdAt: t, updatedAt: t, createdBy: userId });

    action("created", a.detectedAt, SYSTEM_USER);
    event("risk_detected", a.detectedAt, a.astronautId, SYSTEM_USER, "alerts", id, `${a.rule.id}: ${a.explanation}`,
      { ruleId: a.rule.id });
    event("alert_generated", a.detectedAt, a.astronautId, SYSTEM_USER, "alerts", id,
      `${a.number} ${a.title} (${a.severity})`, { severity: a.severity, ruleId: a.rule.id });
    if (a.acknowledgedAt) {
      action("acknowledged", a.acknowledgedAt, MO);
      event("alert_acknowledged", a.acknowledgedAt, a.astronautId, MO, "alerts", id, `${a.number} acknowledged by ${MO_NAME}`);
    }
    if (a.clearedAt) {
      action("condition_cleared", a.clearedAt, SYSTEM_USER);
      event("alert_condition_cleared", a.clearedAt, a.astronautId, SYSTEM_USER, "alerts", id, `${a.number} condition cleared`);
    }
    if (a.resolvedAt) {
      action("resolved", a.resolvedAt, MO, a.resolutionNote);
      event("alert_resolved", a.resolvedAt, a.astronautId, MO, "alerts", id, `${a.number} resolved by ${MO_NAME}`);
    }
    return alert;
  }

  const r = (astronautId, metric, ago) => special[`${astronautId}:${metric}:${ago}`];

  // ALT-0181 — a-01 elevated blood pressure, 2 days ago (resolved)
  {
    const readings = [4, 2, 0].map((h) => r("a-01", "bpSystolic", 2 * DAY_MS + h * HOUR_MS));
    const detectedAt = readings[1].timestamp + MINUTE_MS;
    const clearedAt = r("a-01", "bpSystolic", 2 * DAY_MS - 2 * HOUR_MS).timestamp + MINUTE_MS;
    addAlert({
      number: "ALT-0181", astronautId: "a-01", type: "elevated_blood_pressure", category: "physical", severity: "warning",
      status: "resolved", title: "Elevated blood pressure", detectedAt,
      lastTriggeredAt: readings[2].timestamp + MINUTE_MS, occurrenceCount: 2, triggering: readings.map(trig),
      rule: { id: "PHY-03", description: "Systolic blood pressure at or above threshold on 2 consecutive readings", thresholdUsed: "≥ 140 mmHg × 2 readings" },
      explanation: "Systolic pressure 142–146 mmHg on 3 consecutive readings (baseline 118 mmHg).",
      suggestedAction: `Repeat the measurement at rest. ${suggested}`,
      acknowledgedAt: detectedAt + 12 * MINUTE_MS, clearedAt, resolvedAt: clearedAt + 30 * MINUTE_MS,
      resolutionNote: "Readings returned toward the stored baseline after rest. Demo alert closed.",
    });
  }

  // ALT-0184 — a-02 elevated heart rate, yesterday (resolved)
  {
    const readings = [4, 2, 0].map((h) => r("a-02", "heartRate", DAY_MS + h * HOUR_MS));
    const detectedAt = readings[1].timestamp + MINUTE_MS;
    const clearedAt = r("a-02", "heartRate", DAY_MS - 2 * HOUR_MS).timestamp + MINUTE_MS;
    addAlert({
      number: "ALT-0184", astronautId: "a-02", type: "elevated_heart_rate", category: "physical", severity: "warning",
      status: "resolved", title: "Elevated heart rate", detectedAt,
      lastTriggeredAt: readings[2].timestamp + MINUTE_MS, occurrenceCount: 2, triggering: readings.map(trig),
      rule: { id: "PHY-01", description: "Heart rate above personal baseline + 20 bpm on 2 consecutive readings", thresholdUsed: "> 84 bpm (baseline 64 + 20) × 2 readings" },
      explanation: "Heart rate 91–96 bpm, up to +32 bpm above personal baseline (64 bpm).",
      suggestedAction: `Re-check at rest. ${suggested}`,
      acknowledgedAt: detectedAt + 9 * MINUTE_MS, clearedAt, resolvedAt: clearedAt + 25 * MINUTE_MS,
      resolutionNote: "Elevated readings followed an exercise session; back to baseline.",
    });
  }

  // ALT-0189 — a-03 supportive check-in recommended (info, new)
  {
    const recent = [3, 2, 1, 0].map((k) => checkins["a-03"][k]);
    addAlert({
      number: "ALT-0189", astronautId: "a-03", type: "supportive_checkin", category: "wellbeing", severity: "info",
      status: "new", title: "Supportive check-in recommended", detectedAt: soon(checkins["a-03"][0].timestamp, 3 * MINUTE_MS),
      triggering: recent.map((c) => ({ metric: "mood", value: c.mood, unit: "1-5", timestamp: c.timestamp, measurementId: c.id })),
      rule: { id: "WB-01", description: "Low mood (≤ 2/5) on 3 of the last 4 shared check-ins with rising stress", thresholdUsed: "mood ≤ 2 on 3 of 4 · stress rising" },
      explanation: "Mood 2/5 on 3 of the last 4 check-ins while stress rose from 6 to 7.",
      suggestedAction: "Consider a supportive, private check-in conversation. Experimental wellbeing indicator — not a diagnosis.",
    });
  }

  // ALT-0190 — a-04 reduced sleep, last 3 nights (warning, acknowledged)
  let sleepAlert;
  {
    const nights = [2, 1, 0].map((k) => sleepByAstronaut["a-04"][k]);
    const detectedAt = soon(nights[2].timestamp, 2 * MINUTE_MS);
    sleepAlert = addAlert({
      number: "ALT-0190", astronautId: "a-04", type: "reduced_sleep", category: "physical", severity: "warning",
      status: "acknowledged", title: "Reduced sleep duration", detectedAt, triggering: nights.map(trig),
      rule: { id: "PHY-05", description: "Sleep below threshold on 3 consecutive nights", thresholdUsed: "< 6.5 h × 3 nights" },
      explanation: `Sleep ${nights.map((n) => `${n.value} h`).join(", ")} on the last 3 nights (below 6.5 h).`,
      suggestedAction: `Encourage a rest period and reassess sleep. ${suggested}`,
      acknowledgedAt: soon(detectedAt, 38 * MINUTE_MS),
    });
  }

  // ---- Messages -------------------------------------------------------------
  {
    const sentAt = soon(sleepAlert.acknowledgedAt, 2 * MINUTE_MS);
    const ackAt = soon(sentAt, 20 * MINUTE_MS);
    const m1 = {
      id: nextId("msg"), astronautId: "a-04", fromUserId: MO, templateId: "rest_and_reassess",
      body: "Please prioritise rest tonight and reassess your sleep tomorrow. Report any symptoms.",
      relatedAlertId: sleepAlert.id, sentAt, acknowledgedAt: ackAt,
      response: { templateId: "will_comply", text: "Understood — resting early tonight.", at: ackAt },
      createdAt: sentAt, updatedAt: ackAt, createdBy: MO,
    };
    data.messages.push(m1);
    event("message_sent", sentAt, "a-04", MO, "messages", m1.id, "Message sent: Rest and reassess", { templateId: m1.templateId });
    event("message_acknowledged", ackAt, "a-04", "u-reyes", "messages", m1.id, "Message acknowledged by Jonas Reyes");
    event("astronaut_response", ackAt, "a-04", "u-reyes", "messages", m1.id, `Response: ${m1.response.text}`);

    const sent2 = now - 40 * MINUTE_MS;
    const m2 = {
      id: nextId("msg"), astronautId: "a-01", fromUserId: MO, templateId: "check_vital_signs",
      body: "Routine request: please take a full vital-signs reading before your next work block.",
      relatedAlertId: "", sentAt: sent2, acknowledgedAt: 0, response: null,
      createdAt: sent2, updatedAt: sent2, createdBy: MO,
    };
    data.messages.push(m2);
    event("message_sent", sent2, "a-01", MO, "messages", m2.id, "Message sent: Check vital signs", { templateId: m2.templateId });
  }

  // ---- Seed version 2: body temperature, cabin environment, exercise sessions ----
  {
    const sup = buildSeedSupplement({ now, astronauts: SEED_ASTRONAUTS });
    data.measurements.push(...sup.measurements);
    data.dailySummaries = [...data.dailySummaries, ...sup.dailySummaries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    data.missionEvents.push(...sup.missionEvents);
    for (const a of data.astronauts) {
      a.latest = { ...a.latest, ...(sup.latest[a.id] || {}) };
      a.baseline = { ...a.baseline, ...(sup.baselines[a.id] || {}) };
    }
  }

  // ---- Settings & meta ------------------------------------------------------
  const setting = (key, value) => data.settings.push({ key, value, updatedAt: now, updatedBy: SYSTEM_USER });
  setting("mission", { name: "ODYSSEY-7", startDate: today - (SEED_MISSION_DAY - 1) * DAY_MS, missionDayOverride: 0 });
  setting("units", { ...METRIC_UNITS, mood: "1-5", stress: "0-10", sleepQuality: "1-5", isolation: "0-10", wellbeing: "1-5", reactionTime: "ms" });
  setting("notifications", { criticalBanner: 1, sound: 0 });
  setting("simulation", { speed: 1 });
  setting("display", { timeFormat: "24h", density: "comfortable" });
  setting("thresholds", structuredClone(DEMO_THRESHOLDS));

  data.meta.push(
    { key: "schemaVersion", value: 1 },
    { key: "seededAt", value: now },
    { key: "seedVersion", value: SEED_VERSION },
    { key: "alertCounter", value: SEED_ALERT_COUNTER },
    { key: "lastCompactedAt", value: 0 }
  );

  data.missionEvents.sort((x, y) => x.timestamp - y.timestamp);
  return data;
}
