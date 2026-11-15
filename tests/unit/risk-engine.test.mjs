// tests/unit/risk-engine.test.mjs — Sprint 8 pure rule engine and alert planner.
// Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const code = (p) => read(p).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

const rules = await import("../../js/engine/rules/physical-rules.js");
const eng = await import("../../js/engine/risk-engine.js");
const { DEMO_THRESHOLDS } = await import("../../js/db/seed-data.js");
const { METRICS } = await import("../../js/db/constants.js");

const H = 3600e3;
const NOW = Date.UTC(2026, 10, 14, 15, 30);
// The two-tier engine behaviour is tested with the original SpO₂ demo values
// (warning < 95, critical < 92). The current three-tier SpO₂ bands (PHY-02 v2:
// watch < 95, warning < 93, critical < 90) are tested separately below.
const TH = { ...DEMO_THRESHOLDS, metrics: { ...DEMO_THRESHOLDS.metrics, spo2: { warningLow: 95, criticalLow: 92 } } };
const R = (id) => rules.getRule(id);
let seq = 0;
const m = (metric, value, agoMs, quality = "ok", source = "simulation", unit) => ({
  id: `msr_${String(++seq).padStart(4, "0")}`, astronautId: "a-03", metric, value, unit: unit ?? { heartRate: "bpm", spo2: "%", bpSystolic: "mmHg", sleepDuration: "h" }[metric],
  timestamp: NOW - agoMs, source, quality, sampleId: "smp", simulationRunId: "",
});
/** Readings oldest → newest, 10 min apart, newest at NOW - 1 min. */
const series = (metric, values, quality) => values.map((v, i) => m(metric, v, (values.length - 1 - i) * 600e3 + 60e3, Array.isArray(quality) ? quality[i] : quality || "ok"));
const ev = (id, list) => eng.evaluateRule(R(id), list, TH, NOW);

test("catalog: exactly the approved rules, versions, documented metrics, stored threshold keys only", () => {
  assert.deepEqual(rules.PHYSICAL_RULES.map((r) => [r.id, r.version, r.metric]), [["PHY-01", 2, "heartRate"], ["PHY-02", 2, "spo2"], ["PHY-03", 1, "bpSystolic"], ["PHY-05", 1, "sleepDuration"],
    ["PHY-06", 1, "bodyTemperature"], ["PHY-07", 1, "bodyTemperature"], ["ENV-01", 1, "cabinCo2"], ["ENV-02", 1, "cabinPressure"], ["ENV-03", 1, "cabinHumidity"]]);
  for (const r of rules.PHYSICAL_RULES) {
    assert.ok(METRICS.includes(r.metric));
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.keys));
    assert.ok(r.keys.warning in TH.metrics[r.metric] && r.keys.critical in TH.metrics[r.metric], `${r.id} uses stored keys`);
    assert.equal(r.category, r.id.startsWith("ENV-") ? "environment" : "physical");
  }
  // No threshold VALUES in the catalog: only key names.
  const src = code("js/engine/rules/physical-rules.js");
  for (const v of ["95", "92", "100", "120", "140", "160", "6.5", "37.5", "38.5", "36.1"]) assert.ok(!new RegExp(`[^\\d.]${v.replace(".", "\\.")}[^\\d]`).test(src), `no hard-coded threshold ${v}`);
  assert.equal(rules.DEMO_THRESHOLD_LABEL, "Demonstration threshold — not clinically validated.");
});

test("PHY-02 boundaries: < 95 warning, < 92 critical, ≥ 95 ×2 clears, 95 and 92 themselves don't qualify", () => {
  assert.deepEqual([ev("PHY-02", series("spo2", [94, 94])).outcome, ev("PHY-02", series("spo2", [94, 94])).severity], ["triggered", "warning"]);
  assert.equal(ev("PHY-02", series("spo2", [95, 94])).reason, "mixed");
  assert.equal(ev("PHY-02", series("spo2", [94, 95])).reason, "mixed");
  assert.equal(ev("PHY-02", series("spo2", [91, 91])).severity, "critical");
  assert.equal(ev("PHY-02", series("spo2", [92, 91])).severity, "warning", "92 is not below 92");
  assert.equal(ev("PHY-02", series("spo2", [88, 93])).severity, "warning", "the lower tier both readings share");
  assert.equal(ev("PHY-02", series("spo2", [95, 95])).outcome, "clear");
  assert.equal(ev("PHY-02", series("spo2", [99, 95])).outcome, "clear");
  const crit = ev("PHY-02", series("spo2", [90, 88]));
  assert.match(crit.explanation, /2 consecutive SpO₂ readings below the demonstration critical threshold of 92 % \(90 %, 88 %\)/);
  assert.equal(crit.thresholdUsed, "warning < 95 %, critical < 92 % · 2 consecutive usable readings");
  assert.equal(crit.limitation, rules.DEMO_LIMITATION);
  assert.deepEqual(crit.evidence.map((e) => e.value), [90, 88], "oldest first");
});

test("PHY-01 v2 boundaries: > 100 warning, > 120 critical, ≤ 100 ×2 clears", () => {
  assert.equal(ev("PHY-01", series("heartRate", [101, 101])).severity, "warning");
  assert.equal(ev("PHY-01", series("heartRate", [100, 101])).reason, "mixed", "100 is not above 100");
  assert.equal(ev("PHY-01", series("heartRate", [121, 125])).severity, "critical");
  assert.equal(ev("PHY-01", series("heartRate", [120, 125])).severity, "warning", "120 is not above 120");
  assert.equal(ev("PHY-01", series("heartRate", [100, 70])).outcome, "clear");
  assert.equal(ev("PHY-01", series("heartRate", [101, 100])).reason, "mixed");
});

test("PHY-03 boundaries: ≥ 140 warning, ≥ 160 critical, < 140 ×2 clears", () => {
  assert.equal(ev("PHY-03", series("bpSystolic", [140, 140])).severity, "warning", "140 is at the threshold");
  assert.equal(ev("PHY-03", series("bpSystolic", [139, 140])).reason, "mixed");
  assert.equal(ev("PHY-03", series("bpSystolic", [160, 165])).severity, "critical");
  assert.equal(ev("PHY-03", series("bpSystolic", [159, 165])).severity, "warning");
  assert.equal(ev("PHY-03", series("bpSystolic", [139, 118])).outcome, "clear");
  assert.match(ev("PHY-03", series("bpSystolic", [150, 150])).explanation, /at or above the demonstration warning threshold of 140 mmHg/);
});

test("PHY-05: three consecutive UTC nights below 6.5 h (critical below 5); one night ≥ 6.5 h clears", () => {
  const night = (value, daysAgo, quality = "ok") => m("sleepDuration", value, daysAgo * 24 * H + 9.5 * H, quality, "seed"); // 06:00 UTC
  assert.equal(eng.evaluateRule(R("PHY-05"), [night(6, 2), night(6.2, 1), night(5.8, 0)], TH, NOW).severity, "warning");
  assert.equal(eng.evaluateRule(R("PHY-05"), [night(4.9, 2), night(4.5, 1), night(4, 0)], TH, NOW).severity, "critical");
  assert.equal(eng.evaluateRule(R("PHY-05"), [night(5, 2), night(4.5, 1), night(4, 0)], TH, NOW).severity, "warning", "5 is not below 5");
  assert.equal(eng.evaluateRule(R("PHY-05"), [night(6, 2), night(6.5, 1), night(5.8, 0)], TH, NOW).outcome, "insufficient", "6.5 is not below 6.5; latest night not clear");
  assert.equal(eng.evaluateRule(R("PHY-05"), [night(6, 2), night(6, 1), night(6.5, 0)], TH, NOW).outcome, "clear", "one night ≥ 6.5 clears");
  const gap = eng.evaluateRule(R("PHY-05"), [night(6, 3), night(6, 1), night(5.8, 0)], TH, NOW);
  assert.deepEqual([gap.outcome, gap.reason], ["insufficient", "not_consecutive_nights"], "a missing UTC night breaks the sequence");
  const twoSameDay = eng.evaluateRule(R("PHY-05"), [night(6, 1), night(5.8, 0), { ...night(7, 0), timestamp: NOW - 2 * H, id: "msr_late" }], TH, NOW);
  assert.equal(twoSameDay.outcome, "clear", "newest reading of a UTC day counts for that night");
  const stale = eng.evaluateRule(R("PHY-05"), [night(5, 4), night(5, 3), night(5, 2)], TH, NOW);
  assert.deepEqual([stale.outcome, stale.reason], ["insufficient", "stale"], "newest night older than 36 h");
});

test("D5: invalid ignored; suspect and stale never trigger, escalate or clear; counted, not used as evidence", () => {
  const s = series("spo2", [80, 80], "suspect");
  assert.deepEqual([ev("PHY-02", s).outcome, ev("PHY-02", s).reason, ev("PHY-02", s).excluded.suspect], ["insufficient", "too_few_usable", 2]);
  // A suspect reading between two usable ones: consecutive among usable readings.
  const mixed = series("spo2", [93, 70, 93], ["ok", "suspect", "ok"]);
  const r = ev("PHY-02", mixed);
  assert.deepEqual([r.outcome, r.severity, r.excluded.suspect], ["triggered", "warning", 1]);
  assert.ok(r.evidence.every((e) => e.quality === "ok"));
  assert.match(r.explanation, /Not used as evidence: 1 suspect reading\./);
  const inv = ev("PHY-02", series("spo2", [80, 80], "invalid"));
  assert.deepEqual([inv.outcome, inv.excluded.invalid], ["insufficient", 2]);
  // Stale: older than 24 h.
  const old = [m("spo2", 85, 30 * H), m("spo2", 85, 26 * H)];
  const st = ev("PHY-02", old);
  assert.deepEqual([st.outcome, st.excluded.stale], ["insufficient", 2]);
  // Suspect / stale readings can't clear either.
  assert.equal(ev("PHY-02", series("spo2", [98, 98], "suspect")).outcome, "insufficient");
  assert.equal(ev("PHY-02", [m("spo2", 98, 30 * H), m("spo2", 98, 25 * H)]).outcome, "insufficient");
  // Future readings and other metrics are ignored.
  assert.equal(ev("PHY-02", [m("spo2", 85, -60e3), m("spo2", 85, -120e3)]).considered, 0);
  assert.equal(ev("PHY-02", series("heartRate", [150, 150])).considered, 0);
});

test("missing thresholds, missing data and too few readings → insufficient, nothing fabricated", () => {
  assert.equal(eng.evaluateRule(R("PHY-02"), series("spo2", [80, 80]), null, NOW).reason, "threshold_missing");
  assert.equal(eng.evaluateRule(R("PHY-02"), series("spo2", [80, 80]), { metrics: {} }, NOW).reason, "threshold_missing");
  assert.equal(eng.evaluateRule(R("PHY-02"), series("spo2", [80, 80]), { metrics: { spo2: { warningLow: "95" } } }, NOW).reason, "threshold_missing");
  const noCrit = eng.evaluateRule(R("PHY-02"), series("spo2", [80, 80]), { metrics: { spo2: { warningLow: 95 } } }, NOW);
  assert.deepEqual([noCrit.outcome, noCrit.severity], ["triggered", "warning"], "without a critical bound only the warning tier exists");
  assert.equal(ev("PHY-02", []).reason, "too_few_usable");
  assert.equal(ev("PHY-02", series("spo2", [80])).reason, "too_few_usable");
  assert.equal(ev("PHY-02", series("spo2", [98])).reason, "too_few_usable", "one reading can't clear either");
  assert.throws(() => eng.evaluateRule(R("PHY-02"), [], TH, Number.NaN), RangeError);
});

test("deterministic, frozen output; inputs never mutated", () => {
  const input = series("spo2", [93, 92, 90]);
  const before = JSON.stringify(input);
  const th = structuredClone(TH);
  const a = ev("PHY-02", input);
  const b = ev("PHY-02", input);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(th, TH);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.evidence) && a.evidence.every(Object.isFrozen) && Object.isFrozen(a.excluded));
  // Evidence has exactly the documented fields.
  assert.deepEqual(Object.keys(a.evidence[0]).sort(), ["measurementId", "metric", "quality", "source", "timestamp", "unit", "value"]);
});

test("engine purity: js/engine imports only js/engine files; no clock, random, DOM, storage or network", () => {
  const files = [];
  const walk = (dir) => { for (const f of readdirSync(join(ROOT, dir))) { const p = `${dir}/${f}`; if (statSync(join(ROOT, p)).isDirectory()) walk(p); else if (f.endsWith(".js")) files.push(p); } };
  walk("js/engine");
  assert.deepEqual(files.sort(), ["js/engine/risk-engine.js", "js/engine/rules/exercise-rules.js", "js/engine/rules/physical-rules.js", "js/engine/rules/wellbeing-rules.js"]);
  for (const f of files) {
    const src = code(f);
    const imports = [...src.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((x) => x[1]);
    for (const p of imports) assert.match(p, /^\.\/(rules\/)?[a-z-]+\.js$/, `${f}: ${p}`);
    for (const bad of ["Date.now", "new Date", "Math.random", "crypto", "document", "window", "localStorage", "indexedDB", "fetch(", "setTimeout", "/db/", "/services/", "/pages/"]) assert.ok(!src.includes(bad), `${f}: ${bad}`);
  }
});

// ---- planner ----------------------------------------------------------------------------

const plan = (id, result, openAlert) => eng.planAlertChange({ rule: R(id), result, openAlert, astronautId: "a-03", now: NOW, trigger: "simulation" });

test("planner: no open alert → open on triggered, nothing otherwise", () => {
  const p = plan("PHY-02", ev("PHY-02", series("spo2", [93, 92])), null);
  assert.equal(p.kind, "open");
  const r = p.record;
  assert.deepEqual([r.astronautId, r.ruleId, r.dedupeKey, r.type, r.category, r.severity, r.status, r.detectedAt, r.lastTriggeredAt, r.occurrenceCount, r.conditionCleared, r.acknowledgedAt, r.acknowledgedBy, r.resolvedAt, r.createdBy],
    ["a-03", "PHY-02", "a-03:PHY-02", "low_spo2", "physical", "warning", "new", NOW, NOW, 1, 0, 0, "", 0, "system"]);
  assert.deepEqual(Object.keys(r.rule).sort(), ["description", "id", "thresholdSource", "thresholdUsed", "version"]);
  assert.match(r.rule.thresholdSource, /not clinically validated/);
  assert.deepEqual(Object.keys(r.evaluation).sort(), ["considered", "evaluatedAt", "excluded", "limitation", "ruleVersion"]);
  assert.match(r.suggestedAction, /does not prescribe treatment/);
  assert.deepEqual(p.action, { action: "created", note: "" });
  assert.deepEqual(p.events.map((e) => e.type), ["risk_detected", "alert_generated"]);
  assert.equal(plan("PHY-02", ev("PHY-02", series("spo2", [97, 98])), null).kind, "none");
  assert.equal(plan("PHY-02", ev("PHY-02", series("spo2", [94, 97])), null).kind, "none");
});

test("planner with an open alert: escalate / retrigger / clear / unchanged; severity never drops", () => {
  const first = plan("PHY-02", ev("PHY-02", series("spo2", [93, 92])), null).record;
  const open = { ...first, id: "alr_1", number: "ALT-0191" };
  // Same evidence → unchanged.
  assert.deepEqual(plan("PHY-02", ev("PHY-02", series("spo2", [93, 92]).map((x, i) => ({ ...x, id: first.triggeringMeasurements[i].measurementId }))), open), { kind: "none", reason: "no_new_evidence" });
  // New warning evidence → retrigger (no alertAction), occurrence +1.
  const rt = plan("PHY-02", ev("PHY-02", series("spo2", [92, 90])), open);
  assert.equal(rt.kind, "retrigger");
  assert.equal(rt.action, null);
  assert.equal(rt.changes.occurrenceCount, 2);
  assert.equal(rt.changes.severity, undefined, "severity untouched");
  // Higher severity → escalate.
  const esc = plan("PHY-02", ev("PHY-02", series("spo2", [90, 88])), { ...open, status: "acknowledged", acknowledgedAt: NOW - 1, acknowledgedBy: "u-medofficer" });
  assert.equal(esc.kind, "escalate");
  assert.deepEqual([esc.changes.severity, esc.changes.status, esc.changes.acknowledgedAt, esc.changes.acknowledgedBy, esc.changes.conditionCleared], ["critical", "new", 0, "", 0]);
  assert.deepEqual(esc.action, { action: "escalated", note: "warning → critical" });
  assert.equal(esc.events[0].type, "alert_escalated");
  // A "new" alert escalating doesn't touch acknowledgement fields.
  assert.ok(!("acknowledgedAt" in plan("PHY-02", ev("PHY-02", series("spo2", [90, 88])), open).changes));
  // Lower-tier trigger on a critical alert: severity stays critical.
  const lower = plan("PHY-02", ev("PHY-02", series("spo2", [93, 93])), { ...open, severity: "critical" });
  assert.equal(lower.kind, "retrigger");
  assert.ok(!("severity" in lower.changes));
  assert.ok(!("explanation" in lower.changes), "a lower-tier re-trigger keeps the explanation of the current severity");
  assert.ok("explanation" in rt.changes, "a same-tier re-trigger refreshes the explanation");
  // Clear → condition_cleared once.
  const cl = plan("PHY-02", ev("PHY-02", series("spo2", [95, 97])), open);
  assert.equal(cl.kind, "clear");
  assert.deepEqual([cl.changes.conditionCleared, cl.action.action], [1, "condition_cleared"]);
  assert.equal(cl.changes.status, undefined, "clearing never changes status");
  assert.deepEqual(plan("PHY-02", ev("PHY-02", series("spo2", [95, 97])), { ...open, conditionCleared: 1 }), { kind: "none", reason: "already_cleared" });
  // Re-trigger after a clear sets conditionCleared back to 0.
  assert.equal(plan("PHY-02", ev("PHY-02", series("spo2", [93, 93])), { ...open, conditionCleared: 1 }).changes.conditionCleared, 0);
  // Insufficient → nothing.
  assert.equal(plan("PHY-02", ev("PHY-02", series("spo2", [94, 96])), open).kind, "none");
});

test("evidence merge keeps documented fields, dedupes by measurement, oldest first, capped", () => {
  const a = series("spo2", [93, 92]).map(eng.evidenceOf);
  const b = series("spo2", [90]).map(eng.evidenceOf);
  const merged = eng.mergeEvidence(a, [...a, ...b]);
  assert.equal(merged.length, 3);
  assert.ok(merged.every((e, i) => i === 0 || e.timestamp >= merged[i - 1].timestamp));
  const many = Array.from({ length: 70 }, (_, i) => eng.evidenceOf(m("spo2", 90, (70 - i) * 1000)));
  assert.equal(eng.mergeEvidence([], many).length, eng.EVIDENCE_LIMIT);
});

test("PHY-02 v2 SpO₂ bands (seeded): 95–100 none · 93–94 info · 90–92 warning · < 90 critical; clear at ≥ 95", () => {
  const ev3 = (vals) => eng.evaluateRule(R("PHY-02"), series("spo2", vals), DEMO_THRESHOLDS, NOW);
  assert.deepEqual(DEMO_THRESHOLDS.metrics.spo2, { infoLow: 95, warningLow: 93, criticalLow: 90 });
  assert.equal(ev3([95, 96]).outcome, "clear");
  assert.deepEqual([ev3([94, 93]).outcome, ev3([94, 93]).severity], ["triggered", "info"]);
  assert.match(ev3([94, 93]).explanation, /watch threshold of 95 %/);
  assert.equal(ev3([92, 90]).severity, "warning", "90–92 % is low oxygen (warning)");
  assert.equal(ev3([93, 92]).severity, "info", "93 is not below 93: both readings share the watch tier");
  assert.equal(ev3([89, 85]).severity, "critical");
  assert.equal(ev3([90, 89]).severity, "warning", "90 is not below 90");
  assert.equal(ev3([96, 94]).reason, "mixed");
  assert.match(ev3([94, 94]).thresholdUsed, /^watch < 95 %, warning < 93 %, critical < 90 % · 2 consecutive usable readings$/);
  assert.deepEqual(eng.thresholdsFor(R("PHY-02"), DEMO_THRESHOLDS), { info: 95, warning: 93, critical: 90 });
  assert.deepEqual(eng.thresholdsFor(R("PHY-01"), DEMO_THRESHOLDS).info, null, "rules without a watch tier");
});

test("seed v2 rules: body temperature high/low and cabin environment use the stored KPI bands", () => {
  const evm = (id, metric, vals) => eng.evaluateRule(R(id), series(metric, vals).map((r) => ({ ...r, unit: { bodyTemperature: "°C", cabinCo2: "mmHg", cabinPressure: "kPa", cabinHumidity: "%RH" }[metric] })), DEMO_THRESHOLDS, NOW);
  assert.equal(evm("PHY-06", "bodyTemperature", [37.5, 37.6]).severity, "warning", "37.5 °C is at the warning limit");
  assert.equal(evm("PHY-06", "bodyTemperature", [38.5, 38.9]).severity, "critical");
  assert.equal(evm("PHY-06", "bodyTemperature", [36.8, 37.2]).outcome, "clear");
  assert.equal(evm("PHY-07", "bodyTemperature", [36.0, 35.8]).severity, "warning", "below the 36.1 °C normal range");
  assert.equal(evm("PHY-07", "bodyTemperature", [34.9, 34.6]).severity, "critical");
  assert.equal(evm("ENV-01", "cabinCo2", [4.0, 4.4]).severity, "warning");
  assert.equal(evm("ENV-01", "cabinCo2", [6.1, 6.3]).severity, "critical");
  assert.equal(evm("ENV-02", "cabinPressure", [97.5, 97.8]).severity, "warning");
  assert.equal(evm("ENV-02", "cabinPressure", [94.8, 94]).severity, "critical");
  assert.equal(evm("ENV-03", "cabinHumidity", [72, 75]).severity, "warning");
  assert.equal(evm("ENV-03", "cabinHumidity", [81, 85]).severity, "critical");
  assert.equal(evm("ENV-03", "cabinHumidity", [70, 75]).reason, "mixed", "70 is not above 70");
  assert.equal(R("ENV-01").category, "environment");
});
