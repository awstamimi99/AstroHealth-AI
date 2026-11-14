// js/engine/risk-engine.js — pure, deterministic rule evaluation and alert planning (Sprint 8).
//
//   evaluateRule(rule, readings, thresholds, now)      → triggered | clear | insufficient
//   planAlertChange({ rule, result, openAlert, astronautId, now, trigger })
//                                                       → none | open | escalate | retrigger | clear
//
// No database, page, service, DOM, clock, random, network or storage access.
// Inputs are never mutated; every returned object is frozen. Thresholds and
// the evaluation time are always passed in explicitly.
//
// Readings: measurement-shaped objects { id, metric, value, unit, timestamp,
// source, quality }. invalid → ignored; suspect → never trigger, escalate or
// clear; stale (older than the rule's staleMs at `now`) → never trigger,
// escalate or clear. Excluded readings are counted, never used as evidence.
// "Consecutive" means consecutive among the usable readings (quality "ok",
// fresh), newest first.

import { DEMO_LIMITATION, THRESHOLD_SOURCE, SUGGESTED_ACTION, qualifies, inClearRange, boundText } from "./rules/physical-rules.js";

export const SEVERITY_RANK = Object.freeze({ info: 1, warning: 2, critical: 3 });
export const EVIDENCE_LIMIT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const freeze = (o) => Object.freeze(o);
const fmt = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10));
const valueText = (v, unit) => `${fmt(v)} ${unit}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const COMPARE_WORDS = { below: "below", above: "above", atOrAbove: "at or above" };
const CLEAR_WORDS = { below: "at or above", above: "at or below", atOrAbove: "below" };

/** A frozen evidence snapshot with only the documented fields. */
export function evidenceOf(m) {
  return freeze({
    metric: m.metric,
    value: m.value,
    unit: typeof m.unit === "string" ? m.unit : "",
    timestamp: m.timestamp,
    measurementId: typeof m.id === "string" ? m.id : "",
    source: typeof m.source === "string" ? m.source : "",
    quality: m.quality,
  });
}

function excludedNote(ex) {
  const parts = [];
  if (ex.suspect) parts.push(`${ex.suspect} suspect`);
  if (ex.invalid) parts.push(`${ex.invalid} invalid`);
  if (ex.stale) parts.push(`${ex.stale} stale`);
  return parts.length ? ` Not used as evidence: ${parts.join(", ")} reading${ex.suspect + ex.invalid + ex.stale === 1 ? "" : "s"}.` : "";
}

/** The stored thresholds for a rule: { warning, critical } (null when missing / not a finite number). */
export function thresholdsFor(rule, thresholds) {
  const metrics = thresholds && typeof thresholds === "object" ? thresholds.metrics : null;
  const t = metrics && typeof metrics === "object" ? metrics[rule.metric] : null;
  const pick = (key) => (t && isNum(t[key]) ? t[key] : null);
  return { warning: pick(rule.keys.warning), critical: pick(rule.keys.critical) };
}

/** "warning < 95 %, critical < 92 % · 2 consecutive usable readings" */
export function thresholdUsedText(rule, bounds, unit) {
  const tiers = [`warning ${boundText(rule.compare, bounds.warning, unit)}`];
  if (bounds.critical !== null) tiers.push(`critical ${boundText(rule.compare, bounds.critical, unit)}`);
  const span = rule.kind === "nightly" ? `${rule.count} consecutive UTC nights` : `${rule.count} consecutive usable readings`;
  return `${tiers.join(", ")} · ${span}`;
}

/**
 * Evaluate one rule. Pure and deterministic.
 * @returns frozen { outcome, ruleId, ruleVersion, metric, severity, reason, evidence, excluded,
 *                   considered, explanation, threshold, thresholdUsed, limitation, evaluatedAt }
 */
export function evaluateRule(rule, readings, thresholds, now) {
  if (!rule || typeof rule !== "object") throw new TypeError("evaluateRule: unknown rule");
  if (!isNum(now)) throw new RangeError("evaluateRule: `now` must be a finite number");
  const bounds = thresholdsFor(rule, thresholds);
  const list = (Array.isArray(readings) ? readings : []).filter(
    (r) => r && r.metric === rule.metric && isNum(r.value) && isNum(r.timestamp) && r.timestamp <= now
  );
  const unit = (list.find((r) => typeof r.unit === "string") || {}).unit || "";
  const excluded = { suspect: 0, invalid: 0, stale: 0 };
  const ok = [];
  for (const r of list) {
    if (r.quality === "suspect") excluded.suspect += 1;
    else if (r.quality !== "ok") excluded.invalid += 1;
    else ok.push(r);
  }
  // newest first; same time → id ascending (deterministic)
  ok.sort((a, b) => b.timestamp - a.timestamp || String(a.id).localeCompare(String(b.id)));

  const base = (extra) =>
    freeze({
      ruleId: rule.id,
      ruleVersion: rule.version,
      metric: rule.metric,
      severity: null,
      reason: "",
      evidence: freeze([]),
      excluded: freeze({ ...excluded }),
      considered: list.length,
      threshold: freeze({ warning: bounds.warning, critical: bounds.critical, compare: rule.compare, source: THRESHOLD_SOURCE }),
      thresholdUsed: bounds.warning === null ? "" : thresholdUsedText(rule, bounds, unit || "?"),
      limitation: DEMO_LIMITATION,
      evaluatedAt: now,
      ...extra,
    });
  const insufficient = (reason, explanation) => base({ outcome: "insufficient", reason, explanation: explanation + excludedNote(excluded) });

  if (bounds.warning === null) return insufficient("threshold_missing", `No stored demonstration threshold for ${rule.label}, so the rule was not evaluated.`);

  if (rule.kind === "nightly") return evaluateNightly(rule, ok, bounds, now, excluded, unit, base, insufficient);

  // ---- consecutive vital-sign readings ----
  const usable = [];
  for (const r of ok) {
    if (now - r.timestamp > rule.staleMs) excluded.stale += 1;
    else usable.push(r);
  }
  const recentWindow = usable.slice(0, rule.count);
  const evidence = freeze([...recentWindow].reverse().map(evidenceOf)); // oldest first
  const values = [...recentWindow].reverse().map((r) => valueText(r.value, unit)).join(", ");
  const tier = (bound) => recentWindow.length === rule.count && recentWindow.every((r) => qualifies(rule.compare, r.value, bound));
  const words = COMPARE_WORDS[rule.compare];

  if (bounds.critical !== null && tier(bounds.critical)) {
    return base({
      outcome: "triggered", severity: "critical", evidence,
      explanation: `${rule.count} consecutive ${rule.label} readings ${words} the demonstration critical threshold of ${valueText(bounds.critical, unit)} (${values}).${excludedNote(excluded)}`,
    });
  }
  if (tier(bounds.warning)) {
    return base({
      outcome: "triggered", severity: "warning", evidence,
      explanation: `${rule.count} consecutive ${rule.label} readings ${words} the demonstration warning threshold of ${valueText(bounds.warning, unit)} (${values}).${excludedNote(excluded)}`,
    });
  }
  const clearWindow = usable.slice(0, rule.clearCount);
  if (clearWindow.length === rule.clearCount && clearWindow.every((r) => inClearRange(rule.compare, r.value, bounds.warning))) {
    const cv = [...clearWindow].reverse().map((r) => valueText(r.value, unit)).join(", ");
    return base({
      outcome: "clear", evidence: freeze([...clearWindow].reverse().map(evidenceOf)),
      explanation: `${rule.clearCount} consecutive ${rule.label} readings ${CLEAR_WORDS[rule.compare]} the demonstration warning threshold of ${valueText(bounds.warning, unit)} (${cv}).${excludedNote(excluded)}`,
    });
  }
  if (recentWindow.length < rule.count) {
    return insufficient("too_few_usable", `Fewer than ${rule.count} recent usable ${rule.label} readings, so the rule was not evaluated.`);
  }
  return insufficient("mixed", `The latest ${rule.label} readings (${values}) neither meet the rule nor show ${rule.clearCount} consecutive readings in the clear range, so nothing changes.`);
}

function evaluateNightly(rule, ok, bounds, now, excluded, unit, base, insufficient) {
  // newest reading per UTC day
  const byDay = new Map();
  for (const r of ok) {
    const day = Math.floor(r.timestamp / DAY_MS);
    if (!byDay.has(day)) byDay.set(day, r); // ok is newest first
  }
  const nights = [...byDay.entries()].sort((a, b) => b[0] - a[0]);
  if (!nights.length) return insufficient("too_few_usable", `No usable ${rule.label} reading, so the rule was not evaluated.`);
  const [newestDay, newest] = nights[0];
  if (now - newest.timestamp > rule.staleMs) {
    excluded.stale += ok.length;
    return insufficient("stale", `No ${rule.label} reading in the last ${Math.round(rule.staleMs / 3600000)} h, so the rule was not evaluated.`);
  }
  const consecutive = [];
  for (let k = 0; k < rule.count; k += 1) {
    const r = byDay.get(newestDay - k);
    if (!r) break;
    consecutive.push(r);
  }
  const words = COMPARE_WORDS[rule.compare];
  if (consecutive.length === rule.count) {
    const values = [...consecutive].reverse().map((r) => valueText(r.value, unit)).join(", ");
    const evidence = freeze([...consecutive].reverse().map(evidenceOf));
    const all = (bound) => consecutive.every((r) => qualifies(rule.compare, r.value, bound));
    if (bounds.critical !== null && all(bounds.critical)) {
      return base({ outcome: "triggered", severity: "critical", evidence, explanation: `${rule.label} ${words} the demonstration critical threshold of ${valueText(bounds.critical, unit)} on ${rule.count} consecutive UTC nights (${values}).${excludedNote(excluded)}` });
    }
    if (all(bounds.warning)) {
      return base({ outcome: "triggered", severity: "warning", evidence, explanation: `${rule.label} ${words} the demonstration warning threshold of ${valueText(bounds.warning, unit)} on ${rule.count} consecutive UTC nights (${values}).${excludedNote(excluded)}` });
    }
  }
  if (inClearRange(rule.compare, newest.value, bounds.warning)) {
    return base({
      outcome: "clear", evidence: freeze([evidenceOf(newest)]),
      explanation: `The latest night's ${rule.label.toLowerCase()} (${valueText(newest.value, unit)}) is ${CLEAR_WORDS[rule.compare]} the demonstration warning threshold of ${valueText(bounds.warning, unit)}.${excludedNote(excluded)}`,
    });
  }
  if (consecutive.length < rule.count) {
    return insufficient("not_consecutive_nights", `Fewer than ${rule.count} consecutive UTC nights with a usable ${rule.label.toLowerCase()} reading, so the rule was not evaluated.`);
  }
  return insufficient("mixed", `The last ${rule.count} nights don't all meet the rule, and the latest night is not in the clear range, so nothing changes.`);
}

/** Existing + new evidence, deduplicated by measurementId, oldest first, newest EVIDENCE_LIMIT kept. */
export function mergeEvidence(existing, added) {
  const out = [];
  const seen = new Set();
  for (const e of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(added) ? added : [])]) {
    if (!e || typeof e !== "object") continue;
    const key = e.measurementId ? `id:${e.measurementId}` : `t:${e.metric}:${e.timestamp}:${e.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(freeze({ ...e }));
  }
  out.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return freeze(out.slice(-EVIDENCE_LIMIT));
}

function evaluationMeta(result) {
  return freeze({
    ruleVersion: result.ruleVersion,
    evaluatedAt: result.evaluatedAt,
    considered: result.considered,
    excluded: freeze({ ...result.excluded }),
    limitation: result.limitation,
  });
}

/**
 * Decide what (if anything) changes. Pure. `openAlert` is the stored OPEN
 * alert for this astronaut + rule (status new/acknowledged) or null.
 * Event summaries may contain "{number}", filled in by the service.
 */
export function planAlertChange({ rule, result, openAlert, astronautId, now, trigger = "evaluation" }) {
  const none = (reason) => freeze({ kind: "none", reason });
  if (!result || result.outcome === "insufficient") return none(result ? result.reason : "no_result");
  const data = (extra = {}) => freeze({ ruleId: rule.id, ruleVersion: rule.version, trigger, ...extra });

  if (!openAlert) {
    if (result.outcome !== "triggered") return none("no_open_alert");
    const record = freeze({
      astronautId,
      ruleId: rule.id,
      dedupeKey: `${astronautId}:${rule.id}`,
      type: rule.type,
      category: rule.category,
      severity: result.severity,
      status: "new",
      title: rule.title,
      detectedAt: now,
      lastTriggeredAt: now,
      occurrenceCount: 1,
      triggeringMeasurements: mergeEvidence([], result.evidence),
      rule: freeze({ id: rule.id, version: rule.version, description: rule.description, thresholdUsed: result.thresholdUsed, thresholdSource: THRESHOLD_SOURCE }),
      explanation: result.explanation,
      suggestedAction: SUGGESTED_ACTION,
      conditionCleared: 0,
      acknowledgedAt: 0,
      acknowledgedBy: "",
      resolvedAt: 0,
      resolvedBy: "",
      resolutionNote: "",
      evaluation: evaluationMeta(result),
      createdAt: now,
      createdBy: "system",
    });
    return freeze({
      kind: "open",
      record,
      action: freeze({ action: "created", note: "" }),
      events: freeze([
        freeze({ type: "risk_detected", summary: `${rule.id}: ${result.explanation}`, data: data({ severity: result.severity }) }),
        freeze({ type: "alert_generated", summary: `{number} ${rule.title} (${result.severity})`, data: data({ severity: result.severity }) }),
      ]),
    });
  }

  const known = new Set((Array.isArray(openAlert.triggeringMeasurements) ? openAlert.triggeringMeasurements : []).map((e) => e && e.measurementId).filter(Boolean));

  if (result.outcome === "clear") {
    if (openAlert.conditionCleared === 1) return none("already_cleared");
    return freeze({
      kind: "clear",
      expect: freeze({ status: openAlert.status, conditionCleared: openAlert.conditionCleared }),
      changes: freeze({ conditionCleared: 1, evaluation: evaluationMeta(result) }),
      action: freeze({ action: "condition_cleared", note: result.explanation }),
      events: freeze([freeze({ type: "alert_condition_cleared", summary: `{number} condition cleared — ${result.explanation}`, data: data() })]),
    });
  }

  // triggered, with an open alert
  const newest = result.evidence[result.evidence.length - 1];
  const higher = (SEVERITY_RANK[result.severity] || 0) > (SEVERITY_RANK[openAlert.severity] || 0);
  const isNew = newest && newest.measurementId && !known.has(newest.measurementId);
  const common = {
    lastTriggeredAt: now,
    occurrenceCount: (Number.isInteger(openAlert.occurrenceCount) ? openAlert.occurrenceCount : 1) + 1,
    triggeringMeasurements: mergeEvidence(openAlert.triggeringMeasurements, result.evidence),
    conditionCleared: 0,
    evaluation: evaluationMeta(result),
  };
  if (higher) {
    const changes = { ...common, severity: result.severity, status: "new", explanation: result.explanation };
    if (openAlert.status === "acknowledged") Object.assign(changes, { acknowledgedAt: 0, acknowledgedBy: "" });
    return freeze({
      kind: "escalate",
      expect: freeze({ status: openAlert.status, severity: openAlert.severity }),
      changes: freeze(changes),
      action: freeze({ action: "escalated", note: `${openAlert.severity} → ${result.severity}` }),
      events: freeze([freeze({ type: "alert_escalated", summary: `{number} escalated from ${openAlert.severity} to ${result.severity} — ${result.explanation}`, data: data({ severity: result.severity, from: openAlert.severity }) })]),
    });
  }
  if (!isNew) return none("no_new_evidence");
  // The stored explanation must keep explaining the alert's CURRENT severity:
  // a lower-tier re-trigger adds evidence but doesn't replace it.
  const sameTier = result.severity === openAlert.severity;
  return freeze({
    kind: "retrigger",
    expect: freeze({ status: openAlert.status, severity: openAlert.severity }),
    changes: freeze(sameTier ? { ...common, explanation: result.explanation } : { ...common }),
    action: null,
    events: freeze([freeze({ type: "risk_detected", summary: `${rule.id}: ${result.explanation}`, data: data({ severity: result.severity, alertSeverity: openAlert.severity }) })]),
  });
}
