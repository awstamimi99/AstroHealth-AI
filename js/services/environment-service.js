// js/services/environment-service.js — #/environment, the Cabin Environment.
//
//   getCabinEnvironment(session, options)
//
// Readings come from each crew member's PERSONAL cabin-environment monitor
// (measurements cabinCo2 ppCO₂ mmHg, cabinPressure kPa, cabinHumidity %RH —
// synthetic). Shown:
//   • crew-wide latest average / range and 24-hour statistics per measure,
//     with the stored demonstration limits (ENV-01/02/03);
//   • the AIR CHECK (project KPI: "if SpO₂ drops for one person it's a health
//     issue; if it drops for several crew members at once, the air is the
//     problem") — deterministic, explainable, never a diagnosis;
//   • open environment alerts (astronaut: own; Medical Officer: all).
// Astronaut: crew-wide figures only (no other crew member's names or
// values). Medical Officer: per crew member as well.
// Reads only; never writes. Test seam: createEnvironmentService({ repos }).

import { usersRepo, astronautsRepo, measurementsRepo, alertsRepo, settingsRepo, OPEN_ALERT_STATUSES, SEVERITIES, METRIC_UNITS, DAY_MS, ROLES } from "../db/index.js";
import { verifyAstronaut, verifyMedicalOfficer, CREW_ID_PATTERN } from "./access-control.js";

export const CABIN_METRICS = Object.freeze([
  Object.freeze({ key: "cabinCo2", label: "Cabin CO₂ (ppCO₂)", decimals: 1, rule: "ENV-01", direction: "high" }),
  Object.freeze({ key: "cabinPressure", label: "Cabin pressure", decimals: 1, rule: "ENV-02", direction: "low" }),
  Object.freeze({ key: "cabinHumidity", label: "Cabin humidity", decimals: 0, rule: "ENV-03", direction: "high" }),
]);
export const ENVIRONMENT_NOTE = "Synthetic readings from each crew member's personal cabin-environment monitor. Demonstration limits — not clinically validated and not spacecraft life-support limits.";
const STALE_MS = 24 * 60 * 60 * 1000;
const ERROR = Symbol("error");
const attempt = (fn) => Promise.resolve().then(fn);
const valueOf = (s) => (s.status === "fulfilled" ? s.value : ERROR);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isText = (v) => typeof v === "string" && v.trim() !== "";
const round = (v, d) => (isNum(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const result = (status, reason, now, extra = {}) => ({ status, reason, generatedAt: now, ...extra });

/** ok | warning | critical against the stored limits for one measure. */
export function levelOf(metric, value, limits) {
  if (!isNum(value) || !limits) return "unknown";
  if (metric.direction === "high") {
    if (isNum(limits.criticalHigh) && value >= limits.criticalHigh) return "critical";
    if (isNum(limits.warningHigh) && (metric.key === "cabinHumidity" ? value > limits.warningHigh : value >= limits.warningHigh)) return "warning";
    return "ok";
  }
  if (isNum(limits.criticalLow) && value < limits.criticalLow) return "critical";
  if (isNum(limits.warningLow) && value < limits.warningLow) return "warning";
  return "ok";
}

/**
 * Air check (pure). `members`: [{ spo2, co2 }] latest values. → { status, text, lowSpo2, total }.
 * status: "crew_pattern" (≥ 2 crew with SpO₂ under the watch limit AND cabin CO₂ at/above its warning),
 *         "crew_spo2"    (≥ 2 crew with low SpO₂, CO₂ normal), "individual" (exactly 1), "clear", "unknown".
 */
export function airCheck(members, thresholds) {
  const t = (thresholds && thresholds.metrics) || {};
  const spoLimit = isNum(t.spo2?.infoLow) ? t.spo2.infoLow : t.spo2?.warningLow;
  const co2Limit = t.cabinCo2?.warningHigh;
  const known = members.filter((m) => isNum(m.spo2));
  if (!known.length || !isNum(spoLimit)) return { status: "unknown", text: "Not enough recent SpO₂ readings for the air check.", lowSpo2: 0, total: members.length };
  const low = known.filter((m) => m.spo2 < spoLimit).length;
  const co2 = members.map((m) => m.co2).filter(isNum);
  const co2High = co2.length && isNum(co2Limit) && Math.max(...co2) >= co2Limit;
  if (low >= 2 && co2High) return { status: "crew_pattern", text: `${low} of ${members.length} crew members have SpO₂ below ${spoLimit} % while cabin CO₂ is at or above ${co2Limit} mmHg — a crew-wide pattern that points to the cabin air rather than one person. Check life support (demonstration rule).`, lowSpo2: low, total: members.length };
  if (low >= 2) return { status: "crew_spo2", text: `${low} of ${members.length} crew members have SpO₂ below ${spoLimit} % at the same time. Cabin CO₂ is within its limit; a crew-wide drop can still point to the air supply (demonstration rule).`, lowSpo2: low, total: members.length };
  if (low === 1) return { status: "individual", text: `1 crew member has SpO₂ below ${spoLimit} %. A single person's drop is reviewed as an individual health reading, not a cabin problem.`, lowSpo2: 1, total: members.length };
  return { status: "clear", text: `No crew member has SpO₂ below ${spoLimit} %. No crew-wide oxygen pattern.`, lowSpo2: 0, total: members.length };
}

/** TEST SEAM. */
export function createEnvironmentService({ repos }) {
  const nowOf = (o) => (o && o.now !== undefined ? o.now : Date.now());
  return {
    async getCabinEnvironment(session, options = {}) {
      const now = nowOf(options);
      const role = session && session.role;
      let viewerAid = null;
      if (role === ROLES.MEDICAL_OFFICER) {
        const o = await verifyMedicalOfficer(session, repos, now);
        if (!o.ok) return o.refusal;
      } else {
        const a = await verifyAstronaut(session, repos, now);
        if (!a.ok) return a.refusal;
        viewerAid = a.astronaut.id;
      }
      let crew;
      let thresholds;
      try {
        const [all, th] = await Promise.all([repos.astronautsRepo.getAll(), repos.settingsRepo.get("thresholds")]);
        const seen = new Set();
        crew = (Array.isArray(all) ? all : []).filter((a) => a && isText(a.id) && typeof a.crewId === "string" && CREW_ID_PATTERN.test(a.crewId) && !seen.has(a.crewId) && seen.add(a.crewId)).sort((a, b) => a.crewId.localeCompare(b.crewId));
        thresholds = th && th.metrics ? th : null;
      } catch {
        return result("unavailable", "database_error", now);
      }
      const t = (thresholds && thresholds.metrics) || {};
      const perMember = [];
      for (const a of crew) {
        const settled = await Promise.allSettled([
          ...CABIN_METRICS.map((m) => attempt(() => repos.measurementsRepo.getRange(a.id, m.key, now - DAY_MS, now))),
          attempt(() => repos.measurementsRepo.getRecent(a.id, "spo2", 6)),
        ]);
        const row = { crewId: a.crewId, name: isText(a.name) ? a.name : a.crewId, metrics: {}, spo2: null };
        CABIN_METRICS.forEach((m, i) => {
          const raw = valueOf(settled[i]);
          if (raw === ERROR) { row.metrics[m.key] = { status: "error" }; return; }
          const ok = (Array.isArray(raw) ? raw : []).filter((r) => r && r.astronautId === a.id && r.metric === m.key && r.quality === "ok" && isNum(r.value) && r.timestamp <= now).sort((x, y) => x.timestamp - y.timestamp);
          const last = ok[ok.length - 1];
          const values = ok.map((r) => r.value);
          row.metrics[m.key] = {
            status: "ok",
            latest: last && now - last.timestamp <= STALE_MS ? round(last.value, m.decimals) : null,
            at: last ? last.timestamp : 0,
            average24h: values.length ? round(values.reduce((s, v) => s + v, 0) / values.length, m.decimals) : null,
            min24h: values.length ? round(Math.min(...values), m.decimals) : null,
            max24h: values.length ? round(Math.max(...values), m.decimals) : null,
            samples: values.length,
          };
          row.metrics[m.key].level = levelOf(m, row.metrics[m.key].latest, t[m.key]);
        });
        const s = valueOf(settled[CABIN_METRICS.length]);
        const sOk = s === ERROR ? [] : (Array.isArray(s) ? s : []).filter((r) => r && r.astronautId === a.id && r.quality === "ok" && isNum(r.value) && now - r.timestamp <= STALE_MS).sort((x, y) => y.timestamp - x.timestamp);
        row.spo2 = sOk.length ? sOk[0].value : null;
        perMember.push(row);
      }
      const crewWide = CABIN_METRICS.map((m) => {
        const latest = perMember.map((p) => p.metrics[m.key]?.latest).filter(isNum);
        const avg = perMember.map((p) => p.metrics[m.key]?.average24h).filter(isNum);
        const mins = perMember.map((p) => p.metrics[m.key]?.min24h).filter(isNum);
        const maxs = perMember.map((p) => p.metrics[m.key]?.max24h).filter(isNum);
        const average = latest.length ? round(latest.reduce((s, v) => s + v, 0) / latest.length, m.decimals) : null;
        const worst = latest.length ? (m.direction === "high" ? Math.max(...latest) : Math.min(...latest)) : null;
        return {
          key: m.key, label: m.label, unit: METRIC_UNITS[m.key], rule: m.rule, direction: m.direction,
          limits: t[m.key] ? { warning: m.direction === "high" ? t[m.key].warningHigh : t[m.key].warningLow, critical: m.direction === "high" ? t[m.key].criticalHigh : t[m.key].criticalLow } : null,
          latestAverage: average, worstLatest: worst, level: levelOf(m, worst, t[m.key]),
          average24h: avg.length ? round(avg.reduce((s, v) => s + v, 0) / avg.length, m.decimals) : null,
          min24h: mins.length ? Math.min(...mins) : null, max24h: maxs.length ? Math.max(...maxs) : null,
          monitors: latest.length,
        };
      });
      const check = airCheck(perMember.map((p) => ({ spo2: p.spo2, co2: p.metrics.cabinCo2?.latest })), thresholds);
      let alerts;
      try {
        const lists = await Promise.all(crew.filter((a) => role === ROLES.MEDICAL_OFFICER || a.id === viewerAid).map((a) => repos.alertsRepo.query({ astronautId: a.id })));
        const byId = new Map(crew.map((a) => [a.id, a]));
        alerts = { status: "ok", items: lists.flat().filter((x) => x && x.category === "environment" && OPEN_ALERT_STATUSES.includes(x.status) && byId.has(x.astronautId)).map((x) => ({ number: x.number, title: isText(x.title) ? x.title : "Cabin alert", severity: SEVERITIES.includes(x.severity) ? x.severity : "info", status: x.status, ruleId: x.ruleId || "", crewId: role === ROLES.MEDICAL_OFFICER ? byId.get(x.astronautId).crewId : "", name: role === ROLES.MEDICAL_OFFICER ? byId.get(x.astronautId).name : "", detectedAt: isNum(x.detectedAt) ? x.detectedAt : 0 })) };
      } catch {
        alerts = { status: "error", items: [] };
      }
      return result("ready", "", now, {
        viewer: role === ROLES.MEDICAL_OFFICER ? "officer" : "astronaut",
        crewWide,
        members: role === ROLES.MEDICAL_OFFICER ? perMember.map(({ spo2, ...rest }) => rest) : [],
        airCheck: role === ROLES.MEDICAL_OFFICER ? check : { ...check, text: check.text },
        alerts,
        thresholdsAvailable: Boolean(thresholds),
        note: ENVIRONMENT_NOTE,
      });
    },
  };
}

const production = createEnvironmentService({ repos: Object.freeze({ usersRepo, astronautsRepo, measurementsRepo, alertsRepo, settingsRepo }) });
export const getCabinEnvironment = (session, options) => production.getCabinEnvironment(session, options);
