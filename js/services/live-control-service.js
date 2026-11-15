// js/services/live-control-service.js — READ model for "Live control" in the
// Simulation Center (#/simulation). Medical Officer only.
//
//   getLiveControl(session, { crewId? }, options)
//
// Returns what the Live control tab draws:
//   • crew[]: every crew member with name, crew ID, mission role, open-alert
//     summary and latest stored values (picker + "Crew overview" strip);
//   • selected (only when a valid crewId is given): per stored metric the
//     recent readings, the personal baseline, the input limits, and the
//     demonstration rule that reads that metric with its stored limits;
//     plus that member's open alerts (for the body-scan pins).
//
// This service only READS. All writes are in simulation-service.js
// (recordManualReading, startCustomCurve, …). Rule limits come from the rule
// catalog (js/engine/rules/physical-rules.js) and the stored
// settings.thresholds through the risk engine's own helpers — never from
// numbers typed in a page. They are demonstration values, not clinically
// validated.
//
// The Medical Officer is verified FIRST, before any other read. The crew
// member is resolved here from the public crew ID. Outputs are
// presentation-safe: no user ids, no astronaut ids, no raw records.
//
// Test seam: createLiveControlService({ repos, rules }).

import { usersRepo, astronautsRepo, measurementsRepo, alertsRepo, settingsRepo, METRIC_UNITS, OPEN_ALERT_STATUSES, SEVERITIES } from "../db/index.js";
import { verifyMedicalOfficer, resolveCrewMember, CREW_ID_PATTERN } from "./access-control.js";
import { PHYSICAL_RULES, DEMO_THRESHOLD_LABEL } from "../engine/rules/physical-rules.js";
import { thresholdsFor, thresholdUsedText } from "../engine/risk-engine.js";
import { LIVE_METRICS, CURVE_MIN_POINTS, CURVE_MAX_POINTS, SCENARIO_DISCLAIMER } from "../simulation/scenarios.js";

export const LIVE_READINGS_LIMIT = 24;
export const LIVE_NOTES = Object.freeze({
  synthetic: "Synthetic demonstration data",
  disclaimer: SCENARIO_DISCLAIMER,
  limits: DEMO_THRESHOLD_LABEL,
  inputs: "Handles and number fields accept demonstration input limits only. They are not risk limits.",
});

const ERROR = Symbol("error");
const attempt = (fn) => Promise.resolve().then(fn);
const valueOf = (s) => (s.status === "fulfilled" ? s.value : ERROR);
const isText = (v) => typeof v === "string" && v.trim() !== "";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const result = (status, reason, now, extra = {}) => ({ status, reason, generatedAt: now, ...extra });
const RANK = { info: 1, warning: 2, critical: 3 };

function alertTitle(a) {
  if (isText(a.title)) return a.title.trim();
  if (isText(a.type)) {
    const words = a.type.replace(/[_-]+/g, " ").trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return "Alert";
}

/** Open alerts of one astronaut, most severe first then newest (public fields only). */
function presentAlerts(list, aid) {
  return (Array.isArray(list) ? list : [])
    .filter((a) => a && a.astronautId === aid && OPEN_ALERT_STATUSES.includes(a.status))
    .map((a) => ({
      number: isText(a.number) ? a.number : "",
      title: alertTitle(a),
      severity: SEVERITIES.includes(a.severity) ? a.severity : "info",
      status: a.status,
      ruleId: isText(a.ruleId) ? a.ruleId : "",
      detectedAt: isNum(a.detectedAt) ? a.detectedAt : 0,
    }))
    .sort((x, y) => RANK[y.severity] - RANK[x.severity] || y.detectedAt - x.detectedAt || x.number.localeCompare(y.number));
}

/** The rule (if any) that reads this metric, with its stored limits as the engine words them. */
function presentRule(metricKey, rules, thresholds, index = 0) {
  const rule = rules.filter((r) => r && r.metric === metricKey)[index];
  if (!rule) return null;
  const bounds = thresholdsFor(rule, thresholds);
  const unit = METRIC_UNITS[metricKey];
  return {
    id: rule.id,
    title: rule.title,
    kind: rule.kind,
    compare: rule.compare,
    count: rule.count,
    description: rule.description,
    info: bounds.info,
    warning: bounds.warning,
    critical: bounds.critical,
    limitsText: bounds.warning === null ? "" : thresholdUsedText(rule, bounds, unit),
    available: bounds.warning !== null,
  };
}

/** TEST SEAM. */
export function createLiveControlService({ repos, rules = PHYSICAL_RULES }) {
  const nowOf = (options) => (options && options.now !== undefined ? options.now : Date.now());

  return {
    async getLiveControl(session, input, options = {}) {
      const now = nowOf(options);
      const officer = await verifyMedicalOfficer(session, repos, now);
      if (!officer.ok) return officer.refusal;
      const src = input && typeof input === "object" ? input : {};

      let all;
      try {
        all = await repos.astronautsRepo.getAll();
      } catch {
        return result("unavailable", "database_error", now);
      }
      const seen = new Set();
      const crewRecords = (Array.isArray(all) ? all : [])
        .filter((a) => a && isText(a.id) && typeof a.crewId === "string" && CREW_ID_PATTERN.test(a.crewId) && !seen.has(a.crewId) && seen.add(a.crewId))
        .sort((x, y) => x.crewId.localeCompare(y.crewId));

      const alertLists = await Promise.allSettled(crewRecords.map((a) => attempt(() => repos.alertsRepo.query({ astronautId: a.id }))));
      const crew = crewRecords.map((a, i) => {
        const raw = valueOf(alertLists[i]);
        const open = raw === ERROR ? null : presentAlerts(raw, a.id);
        const latest = a.latest && typeof a.latest === "object" ? a.latest : {};
        return {
          crewId: a.crewId,
          name: isText(a.name) ? a.name : a.crewId,
          missionRole: isText(a.missionRole) ? a.missionRole : "",
          alerts: open === null ? { status: "error", openCount: null, topSeverity: null } : { status: "ok", openCount: open.length, topSeverity: open.length ? open[0].severity : null },
          latest: LIVE_METRICS.filter((m) => latest[m.key] && isNum(latest[m.key].value) && isNum(latest[m.key].timestamp)).map((m) => ({
            metric: m.key, label: m.label, value: latest[m.key].value, unit: METRIC_UNITS[m.key], timestamp: latest[m.key].timestamp,
          })),
        };
      });

      const base = {
        viewer: "officer",
        crew,
        selected: null,
        selection: "none",
        curve: { minPoints: CURVE_MIN_POINTS, maxPoints: CURVE_MAX_POINTS },
        notes: { ...LIVE_NOTES },
      };
      if (src.crewId === undefined || src.crewId === null || src.crewId === "") return result("ready", "", now, base);

      const member = await resolveCrewMember(repos, src.crewId, now);
      if (!member.ok) return result("ready", "", now, { ...base, selection: member.refusal.reason || "unknown_crew_id" });
      const astronaut = member.astronaut;
      const aid = astronaut.id;

      const [thresholdsS, alertsS, ...readingsS] = await Promise.allSettled([
        attempt(() => repos.settingsRepo.get("thresholds")),
        attempt(() => repos.alertsRepo.query({ astronautId: aid })),
        ...LIVE_METRICS.map((m) => attempt(() => repos.measurementsRepo.getRecent(aid, m.key, LIVE_READINGS_LIMIT))),
      ]);
      const stored = valueOf(thresholdsS);
      const thresholds = stored !== ERROR && stored && typeof stored === "object" && stored.metrics && typeof stored.metrics === "object" ? stored : null;
      const alertsRaw = valueOf(alertsS);

      const metrics = LIVE_METRICS.map((m, i) => {
        const raw = valueOf(readingsS[i]);
        const readings =
          raw === ERROR
            ? null
            : (Array.isArray(raw) ? raw : [])
                .filter((r) => r && r.astronautId === aid && r.metric === m.key && isNum(r.value) && isNum(r.timestamp) && r.timestamp <= now && r.quality !== "invalid")
                .sort((x, y) => x.timestamp - y.timestamp)
                .map((r) => ({ value: r.value, timestamp: r.timestamp, simulated: r.source === "seed" || r.source === "simulation", quality: r.quality === "suspect" ? "suspect" : "ok" }));
        const last = readings && readings.length ? readings[readings.length - 1] : null;
        return {
          key: m.key,
          label: m.label,
          unit: METRIC_UNITS[m.key],
          min: m.min,
          max: m.max,
          step: m.step,
          curve: m.curve,
          baseline: isNum(astronaut.baseline[m.key]) ? astronaut.baseline[m.key] : null,
          readings: { status: readings === null ? "error" : "ok", items: readings || [] },
          latest: last ? { value: last.value, timestamp: last.timestamp } : null,
          rule: presentRule(m.key, rules, thresholds),
          extraRule: presentRule(m.key, rules, thresholds, 1), // e.g. body temperature: high (PHY-06) and low (PHY-07)
        };
      });

      return result("ready", "", now, {
        ...base,
        selection: "ok",
        selected: {
          crewId: astronaut.crewId,
          name: astronaut.name,
          missionRole: astronaut.missionRole,
          alerts: alertsRaw === ERROR ? { status: "error", items: [] } : { status: "ok", items: presentAlerts(alertsRaw, aid) },
          metrics,
          limitsAvailable: Boolean(thresholds),
        },
      });
    },
  };
}

const production = createLiveControlService({
  repos: Object.freeze({ usersRepo, astronautsRepo, measurementsRepo, alertsRepo, settingsRepo }),
});
export const getLiveControl = (session, input, options) => production.getLiveControl(session, input, options);
