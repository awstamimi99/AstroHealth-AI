// js/services/simulation-service.js — #/simulation, the Simulation Center (Sprint 7).
//
// Medical Officer only. Generates deterministic SYNTHETIC readings from the
// reviewed catalog in js/simulation/scenarios.js. This service never reads
// thresholds and never reads or writes alerts / alertActions itself.
// Sprint 8: after a step's transaction has COMMITTED, it asks the risk
// service (js/services/risk-service.js) to evaluate the demonstration rules
// for that crew member. That evaluation is a separate transaction: if it
// fails, the reading stays stored and the result says "risk evaluation
// unavailable"; the next step or an explicit evaluation looks at the
// current stored data again.
//
//   listSimulationScenarios()                                    static catalog
//   getSimulationCenter(session, options)                        page state
//   previewSimulation(session, { crewId, scenarioId }, options)  the 12 values
//   startSimulation(session, { crewId, scenarioId, speed, confirm }, options)
//   advanceSimulation(session, runRef, { expectedStep }, options)
//   pauseSimulation(session, runRef, options)
//   resumeSimulation(session, runRef, options)
//   stopSimulation(session, runRef, { confirm }, options)
//
// RULES
//   • Every operation verifies the Medical Officer FIRST (access-control.js),
//     before any simulation read. Crew IDs are resolved only afterwards.
//   • Page input is limited to the fields above. Astronaut, operator,
//     createdBy, status, timestamps, progress fields, source and the run id
//     on measurements all come from this service.
//   • At most ONE active run (running or paused) across the crew, checked
//     inside the start transaction.
//   • Every write transaction re-reads the run and compares status + step
//     ("compare and set"). IndexedDB runs overlapping readwrite transactions
//     one after another, so two tabs can't write the same step twice. A
//     per-run in-memory lock also stops double clicks in one tab.
//   • A step's timestamp is exactly the controlled `now`, which must be
//     strictly later than the run's lastStepAt (else "clock_not_monotonic",
//     nothing written). Readings are never backdated, future-dated or
//     backfilled.
//   • Measurements are written ONLY through measurementsRepo.add(…, { tx }),
//     which maintains astronauts.latest and dailySummaries atomically.
//
// Extra non-indexed simulationRuns fields used (DATA-MODEL allows extra
// fields; documented in docs/ARCHITECTURE.md): step, totalSteps,
// startValue, lastStepAt, pausedAt, catalogVersion.
//
// Event conventions (existing types only):
//   start → simulation_started · resume → simulation_started { phase: "resumed" }
//   pause → simulation_paused · stop → simulation_stopped { outcome: "stopped" }
//   completion → simulation_stopped { outcome: "completed" }
//   each generated reading → measurement_recorded (refStore "simulationRuns")
//
// Outputs are presentation-safe: no user ids, no astronaut ids, no raw
// records. `runRef` is an opaque control handle for this service only —
// pages must never render it or put it in a URL.
//
// Test seam: createSimulationService({ repos, withTransaction, scenarios }).

import {
  usersRepo,
  astronautsRepo,
  measurementsRepo,
  simulationRunsRepo,
  eventsRepo,
  withTransaction,
  DatabaseError,
  MEASUREMENT_WRITE_STORES,
  METRIC_UNITS,
  SIMULATION_STATUSES,
} from "../db/index.js";
import { verifyMedicalOfficer, resolveCrewMember, CREW_ID_PATTERN } from "./access-control.js";
import { evaluateAstronaut } from "./risk-service.js";
import {
  SCENARIOS,
  CATALOG_VERSION,
  SIMULATION_SPEEDS,
  DEFAULT_SPEED,
  BASE_STEP_MS,
  SCENARIO_DISCLAIMER,
  getScenario,
  scenarioValue,
  scenarioSequence,
  resolveScenarioStartValue,
  stepIntervalMs,
} from "../simulation/scenarios.js";

export { SIMULATION_SPEEDS, DEFAULT_SPEED, BASE_STEP_MS, SCENARIO_DISCLAIMER };

export const RISK_NOTE =
  "After each generated reading, the demonstration risk rules (PHY-01 heart rate, PHY-02 SpO₂, PHY-03 systolic blood pressure, PHY-05 sleep) " +
  "are evaluated for that crew member. Demonstration threshold — not clinically validated. Alerts are reviewed on the Alerts page.";
export const OPEN_PAGE_NOTE = "The simulation advances only while this page is open. Background tabs may be delayed.";
export const RECENT_RUNS_LIMIT = 5;
export const TIMELINE_LIMIT = 40;
/** A running run with no step (or resume) for this long is "not advancing". */
export const staleAfterMs = (speed) => 3 * stepIntervalMs(speed) + 5000;

const RUN_REF_PATTERN = /^sim_[A-Za-z0-9-]{1,64}$/;
const RUN_STORES = ["simulationRuns", "missionEvents"];
const STEP_STORES = [...new Set([...MEASUREMENT_WRITE_STORES, "simulationRuns", "missionEvents"])];
const RUN_EVENT_TYPES = ["simulation_started", "simulation_paused", "simulation_stopped", "measurement_recorded"];
const START_LOCK = "start";

const ERROR = Symbol("error");
const valueOf = (s) => (s.status === "fulfilled" ? s.value : ERROR);
const attempt = (fn) => Promise.resolve().then(fn);
const isText = (v) => typeof v === "string" && v.trim() !== "";
const isTime = (v) => typeof v === "number" && Number.isFinite(v);
const result = (status, reason, now, extra = {}) => ({ status, reason, generatedAt: now, ...extra });

/** Catalog entry as shown to the page (copy; the catalog stays frozen). */
function presentScenario(s) {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    metric: s.metric,
    metricLabel: s.metricLabel,
    unit: s.unit,
    target: s.target,
    totalSteps: s.totalSteps,
    phases: { ...s.phases },
    disclaimer: s.disclaimer,
    durationsMs: Object.fromEntries(SIMULATION_SPEEDS.map((speed) => [speed, s.totalSteps * stepIntervalMs(speed)])),
  };
}

/** A stored run whose progress fields are usable by this catalog version. */
function compatible(run, scenario) {
  return (
    Boolean(scenario) &&
    run.catalogVersion === CATALOG_VERSION &&
    run.totalSteps === scenario.totalSteps &&
    Number.isInteger(run.step) &&
    run.step >= 0 &&
    run.step <= run.totalSteps &&
    Number.isInteger(run.startValue) &&
    isTime(run.lastStepAt) &&
    SIMULATION_SPEEDS.includes(run.speed)
  );
}

const EVENT_LABEL = {
  simulation_started: (e) => (e.data && e.data.phase === "resumed" ? "Resumed" : "Started"),
  simulation_paused: () => "Paused",
  simulation_stopped: (e) => (e.data && e.data.outcome === "completed" ? "Completed" : "Stopped"),
  measurement_recorded: () => "Reading generated",
};
// Same-millisecond events: completion after its last reading (newest first).
const EVENT_RANK = { simulation_stopped: 3, simulation_paused: 2, measurement_recorded: 1, simulation_started: 0 };

/** TEST SEAM. Pages use the exported functions below. */
/** Presentation-safe summary of a risk-service result (public numbers only). */
export function presentRiskResult(r) {
  if (!r || r.status !== "evaluated") return { status: "unavailable", reason: (r && r.reason) || "unexpected_error", changes: [] };
  return {
    status: "evaluated",
    reason: "",
    changes: (Array.isArray(r.rules) ? r.rules : [])
      .filter((x) => x && x.change && x.change !== "none")
      .map((x) => ({ ruleId: x.ruleId, title: x.title, change: x.change, alertNumber: x.alertNumber, severity: x.alertSeverity })),
  };
}

export function createSimulationService({ repos, withTransaction: runTransaction, scenarios = SCENARIOS, evaluateRisk = null }) {
  const locks = new Set();
  const nowOf = (options) => (options && options.now !== undefined ? options.now : Date.now());
  const scenarioOf = (id) => getScenario(id, scenarios);

  /** Run a write under a per-key in-memory lock. */
  async function locked(key, now, work) {
    if (locks.has(key)) return result("busy", "operation_in_progress", now);
    locks.add(key);
    try {
      return await work();
    } finally {
      locks.delete(key);
    }
  }

  const badRef = (runRef) => typeof runRef !== "string" || !RUN_REF_PATTERN.test(runRef);

  /** Full presentation of one run (readings + timeline). Never throws for repository failures. */
  async function presentRun(run, viewer, now, crewById) {
    const scenario = scenarioOf(run.scenarioId);
    const settled = await Promise.allSettled([
      crewById && crewById.has(run.astronautId) ? Promise.resolve(crewById.get(run.astronautId)) : attempt(() => repos.astronautsRepo.getById(run.astronautId)),
      run.operatorId === viewer.id ? Promise.resolve({ id: viewer.id, displayName: viewer.displayName }) : attempt(() => repos.usersRepo.getById(run.operatorId)),
      scenario
        ? attempt(() => repos.measurementsRepo.getRange(run.astronautId, scenario.metric, run.startedAt, run.endedAt > 0 ? run.endedAt : now))
        : Promise.resolve([]),
      attempt(() => repos.eventsRepo.getRange({ astronautId: run.astronautId, fromTs: run.startedAt, types: RUN_EVENT_TYPES })),
    ]);
    const [astronautR, operatorR, readingsR, eventsR] = settled.map(valueOf);

    let crew;
    if (astronautR === ERROR) crew = { crewId: "", name: "", available: "unknown" };
    else if (astronautR && astronautR.id === run.astronautId && isText(astronautR.crewId) && CREW_ID_PATTERN.test(astronautR.crewId)) {
      crew = { crewId: astronautR.crewId, name: isText(astronautR.name) ? astronautR.name : astronautR.crewId, available: "yes" };
    } else crew = { crewId: "", name: "", available: "no" };

    let operatorName = "Medical Officer";
    if (operatorR !== ERROR && operatorR && operatorR.id === run.operatorId && isText(operatorR.displayName)) operatorName = operatorR.displayName;
    const operatorIsViewer = run.operatorId === viewer.id;

    const readings =
      readingsR === ERROR
        ? { status: "error", items: [] }
        : {
            status: "ok",
            items: (Array.isArray(readingsR) ? readingsR : [])
              .filter((m) => m && m.simulationRunId === run.id && m.source === "simulation" && m.astronautId === run.astronautId && isTime(m.value) && isTime(m.timestamp))
              .sort((a, b) => a.timestamp - b.timestamp)
              .map((m, i) => ({ step: i + 1, value: m.value, unit: m.unit, timestamp: m.timestamp, source: "simulation", simulated: true })),
          };

    let timeline;
    let lastResumeAt = 0;
    if (eventsR === ERROR) timeline = { status: "error", items: [] };
    else {
      const own = (Array.isArray(eventsR) ? eventsR : []).filter(
        (e) => e && e.refStore === "simulationRuns" && e.refId === run.id && RUN_EVENT_TYPES.includes(e.type) && isTime(e.timestamp)
      );
      for (const e of own) if (e.type === "simulation_started" && e.data && e.data.phase === "resumed") lastResumeAt = Math.max(lastResumeAt, e.timestamp);
      timeline = {
        status: "ok",
        items: own
          .sort((a, b) => b.timestamp - a.timestamp || (EVENT_RANK[b.type] ?? 0) - (EVENT_RANK[a.type] ?? 0) || ((b.data && b.data.step) || 0) - ((a.data && a.data.step) || 0))
          .slice(0, TIMELINE_LIMIT)
          .map((e) => ({ kind: EVENT_LABEL[e.type](e), summary: isText(e.summary) ? e.summary : EVENT_LABEL[e.type](e), timestamp: e.timestamp })),
      };
    }

    const ok = compatible(run, scenario);
    const interval = SIMULATION_SPEEDS.includes(run.speed) ? stepIntervalMs(run.speed) : stepIntervalMs(DEFAULT_SPEED);
    const lastActivityAt = Math.max(isTime(run.lastStepAt) ? run.lastStepAt : 0, run.startedAt, lastResumeAt);
    return {
      runRef: run.id,
      crewId: crew.crewId,
      name: crew.name,
      astronautAvailable: crew.available,
      scenarioId: run.scenarioId,
      scenarioName: scenario ? scenario.name : "Scenario no longer available",
      scenarioAvailable: ok,
      metric: scenario ? scenario.metric : "",
      metricLabel: scenario ? scenario.metricLabel : "",
      unit: scenario ? METRIC_UNITS[scenario.metric] : "",
      status: run.status,
      active: run.status === "running" || run.status === "paused",
      speed: run.speed,
      step: Number.isInteger(run.step) ? run.step : 0,
      totalSteps: Number.isInteger(run.totalSteps) ? run.totalSteps : scenario ? scenario.totalSteps : 0,
      startValue: Number.isInteger(run.startValue) ? run.startValue : null,
      startedAt: run.startedAt,
      lastStepAt: isTime(run.lastStepAt) ? run.lastStepAt : 0,
      pausedAt: isTime(run.pausedAt) ? run.pausedAt : 0,
      endedAt: isTime(run.endedAt) ? run.endedAt : 0,
      stepIntervalMs: interval,
      stale: run.status === "running" && now - lastActivityAt > staleAfterMs(run.speed),
      operatorName: operatorIsViewer ? "You" : operatorName,
      readings,
      timeline,
      synthetic: true,
    };
  }

  const summaryOf = (run, crewById) => {
    const a = crewById.get(run.astronautId);
    const scenario = scenarioOf(run.scenarioId);
    return {
      crewId: a ? a.crewId : "",
      name: a ? a.name : "",
      scenarioName: scenario ? scenario.name : "Scenario no longer available",
      status: run.status,
      step: Number.isInteger(run.step) ? run.step : 0,
      totalSteps: Number.isInteger(run.totalSteps) ? run.totalSteps : 0,
      speed: run.speed,
      startedAt: run.startedAt,
      endedAt: isTime(run.endedAt) ? run.endedAt : 0,
    };
  };

  return {
    listSimulationScenarios() {
      return scenarios.map(presentScenario);
    },

    /**
     * Everything #/simulation shows: crew picker, catalog, the active run (or
     * the most recent finished run) with readings + timeline, recent runs.
     */
    async getSimulationCenter(session, options = {}) {
      const now = nowOf(options);
      const officer = await verifyMedicalOfficer(session, repos, now);
      if (!officer.ok) return officer.refusal;
      const viewer = officer.officer;

      const [crewS, activeS] = await Promise.allSettled([attempt(() => repos.astronautsRepo.getAll()), attempt(() => repos.simulationRunsRepo.getActive())]);
      const all = valueOf(crewS);
      const activeList = valueOf(activeS);
      if (all === ERROR && activeList === ERROR) return result("unavailable", "database_error", now);

      const crewById = new Map();
      const seen = new Set();
      const crew = [];
      if (all !== ERROR) {
        for (const a of (Array.isArray(all) ? all : []).slice().sort((x, y) => String(x && x.crewId).localeCompare(String(y && y.crewId)))) {
          if (!a || !isText(a.id) || typeof a.crewId !== "string" || !CREW_ID_PATTERN.test(a.crewId) || seen.has(a.crewId)) continue;
          seen.add(a.crewId);
          const entry = { crewId: a.crewId, name: isText(a.name) ? a.name : a.crewId };
          crewById.set(a.id, entry);
          crew.push(entry);
        }
      }

      // Recent runs (all crew members), newest first.
      let recent = { status: "error", items: [] };
      let newestRun = null;
      if (all !== ERROR) {
        const lists = await Promise.allSettled([...crewById.keys()].map((aid) => attempt(() => repos.simulationRunsRepo.getByAstronaut(aid))));
        const failed = lists.some((s) => s.status !== "fulfilled");
        const runs = lists
          .flatMap((s) => (s.status === "fulfilled" && Array.isArray(s.value) ? s.value : []))
          .filter((r) => r && isText(r.id) && SIMULATION_STATUSES.includes(r.status) && isTime(r.startedAt) && crewById.has(r.astronautId))
          .sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? -1 : 1));
        newestRun = runs[0] || null;
        recent = { status: failed ? "partial" : "ok", items: runs.slice(0, RECENT_RUNS_LIMIT).map((r) => summaryOf(r, crewById)) };
      }

      let activeRun = null;
      let otherActive = 0;
      if (activeList !== ERROR) {
        const list = (Array.isArray(activeList) ? activeList : []).filter((r) => r && isText(r.id) && (r.status === "running" || r.status === "paused"));
        activeRun = list[0] || null;
        otherActive = Math.max(0, list.length - 1);
      }
      const shown = activeRun || (activeList !== ERROR ? newestRun : null);
      const run = shown ? await presentRun(shown, viewer, now, null) : null;

      return result("ready", "", now, {
        viewer: "officer",
        crew: { status: all === ERROR ? "error" : "ok", items: crew },
        scenarios: scenarios.map(presentScenario),
        speeds: [...SIMULATION_SPEEDS],
        defaultSpeed: DEFAULT_SPEED,
        active: activeList === ERROR ? { status: "error" } : { status: "ok", running: Boolean(activeRun), otherActive },
        run,
        recent,
        notes: { risk: RISK_NOTE, openPage: OPEN_PAGE_NOTE, disclaimer: SCENARIO_DISCLAIMER },
      });
    },

    /** The exact values a run would generate for one crew member. Read-only. */
    async previewSimulation(session, input, options = {}) {
      const now = nowOf(options);
      const officer = await verifyMedicalOfficer(session, repos, now);
      if (!officer.ok) return officer.refusal;
      const src = input && typeof input === "object" ? input : {};
      const scenario = scenarioOf(src.scenarioId);
      if (!scenario) return result("invalid", "unknown_scenario", now);
      const member = await resolveCrewMember(repos, src.crewId, now);
      if (!member.ok) return member.refusal;
      const start = resolveScenarioStartValue(scenario, member.astronaut.baseline);
      return result("ready", "", now, {
        crew: { crewId: member.astronaut.crewId, name: member.astronaut.name },
        scenario: presentScenario(scenario),
        startValue: start.value,
        startSource: start.source,
        steps: scenarioSequence(scenario, start.value).map((s) => ({ ...s })),
      });
    },

    /**
     * Start a run. Page input: { crewId, scenarioId, speed, confirm }. Any
     * other field is ignored.
     */
    async startSimulation(session, input, options = {}) {
      const now = nowOf(options);
      if (!isTime(now)) return result("invalid", "invalid_time", Date.now());
      const officer = await verifyMedicalOfficer(session, repos, now);
      if (!officer.ok) return officer.refusal;
      const src = input && typeof input === "object" ? input : {};
      const scenario = scenarioOf(src.scenarioId);
      if (!scenario) return result("invalid", "unknown_scenario", now);
      if (!SIMULATION_SPEEDS.includes(src.speed)) return result("invalid", "invalid_speed", now);
      if (src.confirm !== true) return result("invalid", "confirmation_required", now);
      const member = await resolveCrewMember(repos, src.crewId, now);
      if (!member.ok) return member.refusal;

      const astronaut = member.astronaut;
      const start = resolveScenarioStartValue(scenario, astronaut.baseline);
      const sequence = scenarioSequence(scenario, start.value); // computed before the transaction
      const officerId = officer.officer.id;

      return locked(START_LOCK, now, async () => {
        let outcome;
        try {
          outcome = await runTransaction(RUN_STORES, "readwrite", async (tx) => {
            const active = await repos.simulationRunsRepo.getActive({ tx });
            if (Array.isArray(active) && active.length) return { conflict: active[0] };
            const run = await repos.simulationRunsRepo.add(
              {
                astronautId: astronaut.id,
                scenarioId: scenario.id,
                status: "running",
                speed: src.speed,
                operatorId: officerId,
                startedAt: now,
                endedAt: 0,
                createdAt: now,
                createdBy: officerId,
                step: 0,
                totalSteps: sequence.length,
                startValue: start.value,
                lastStepAt: now,
                pausedAt: 0,
                catalogVersion: CATALOG_VERSION,
              },
              { tx }
            );
            await repos.eventsRepo.add(
              {
                type: "simulation_started",
                timestamp: now,
                astronautId: astronaut.id,
                actorUserId: officerId,
                refStore: "simulationRuns",
                refId: run.id,
                summary: `Simulation started: ${scenario.name} (${sequence.length} steps, ${src.speed}×)`,
                data: { phase: "started", scenarioId: scenario.id, speed: src.speed, totalSteps: sequence.length },
              },
              { tx }
            );
            return { run };
          });
        } catch {
          return result("unavailable", "database_error", now);
        }
        if (outcome && outcome.conflict) {
          let other = { crewId: "", name: "" };
          try {
            const a = await repos.astronautsRepo.getById(outcome.conflict.astronautId);
            if (a && CREW_ID_PATTERN.test(a.crewId)) other = { crewId: a.crewId, name: a.name };
          } catch {
            /* the conflict is still reported */
          }
          const otherScenario = scenarioOf(outcome.conflict.scenarioId);
          return result("conflict", "another_run_active", now, {
            activeRun: { ...other, scenarioName: otherScenario ? otherScenario.name : "Scenario no longer available", status: outcome.conflict.status },
          });
        }
        return result("started", "", now, {
          runRef: outcome.run.id,
          run: { crewId: astronaut.crewId, name: astronaut.name, scenarioName: scenario.name, status: "running", step: 0, totalSteps: sequence.length, speed: src.speed, startedAt: now },
        });
      });
    },

    /**
     * Generate the next step. Page input: { expectedStep } (the step it last
     * saw). Everything else comes from the stored run.
     */
    async advanceSimulation(session, runRef, input, options = {}) {
      const now = nowOf(options);
      if (!isTime(now)) return result("invalid", "invalid_time", Date.now());
      const officer = await verifyMedicalOfficer(session, repos, now);
      if (!officer.ok) return officer.refusal;
      if (badRef(runRef)) return result("not_found", "unknown_run", now);
      const expectedStep = input && typeof input === "object" ? input.expectedStep : undefined;
      if (!Number.isInteger(expectedStep) || expectedStep < 0) return result("invalid", "invalid_step", now);
      const officerId = officer.officer.id;

      return locked(runRef, now, async () => {
        let run;
        try {
          run = await repos.simulationRunsRepo.getById(runRef);
        } catch {
          return result("unavailable", "database_error", now);
        }
        if (!run || run.id !== runRef) return result("not_found", "unknown_run", now);
        const scenario = scenarioOf(run.scenarioId);
        if (!compatible(run, scenario)) return result("conflict", "scenario_unavailable", now, { runStatus: run.status });
        if (run.status !== "running") return result("conflict", "not_running", now, { runStatus: run.status, currentStep: run.step });
        if (run.step !== expectedStep) return result("conflict", "step_mismatch", now, { runStatus: run.status, currentStep: run.step });
        if (!(now > run.lastStepAt)) return result("conflict", "clock_not_monotonic", now, { runStatus: run.status, currentStep: run.step });

        const step = expectedStep + 1;
        const value = scenarioValue(scenario, run.startValue, step);
        const unit = METRIC_UNITS[scenario.metric];
        const final = step === run.totalSteps;

        let outcome;
        try {
          outcome = await runTransaction(STEP_STORES, "readwrite", async (tx) => {
            const cur = await repos.simulationRunsRepo.getById(runRef, { tx });
            if (!cur || cur.id !== runRef) return { conflict: "unknown_run", status: "not_found" };
            if (cur.status !== "running") return { conflict: "not_running", runStatus: cur.status, currentStep: cur.step };
            if (cur.step !== expectedStep) return { conflict: "step_mismatch", runStatus: cur.status, currentStep: cur.step };
            if (!(now > cur.lastStepAt)) return { conflict: "clock_not_monotonic", runStatus: cur.status, currentStep: cur.step };
            if (cur.scenarioId !== run.scenarioId || cur.startValue !== run.startValue || cur.astronautId !== run.astronautId) {
              return { conflict: "run_changed", runStatus: cur.status, currentStep: cur.step };
            }

            await repos.measurementsRepo.add(
              {
                astronautId: cur.astronautId,
                metric: scenario.metric,
                value,
                unit,
                timestamp: now,
                source: "simulation",
                quality: "ok",
                simulationRunId: cur.id,
                createdAt: now,
                createdBy: officerId,
              },
              { tx }
            );
            const changes = final ? { step, lastStepAt: now, status: "completed", endedAt: now } : { step, lastStepAt: now };
            await repos.simulationRunsRepo.update(cur.id, changes, { tx });
            await repos.eventsRepo.add(
              {
                type: "measurement_recorded",
                timestamp: now,
                astronautId: cur.astronautId,
                actorUserId: officerId,
                refStore: "simulationRuns",
                refId: cur.id,
                summary: `Simulation step ${step} of ${cur.totalSteps}: ${scenario.metricLabel} ${value} ${unit} (synthetic)`,
                data: { step, metric: scenario.metric, value, unit, source: "simulation" },
              },
              { tx }
            );
            if (final) {
              await repos.eventsRepo.add(
                {
                  type: "simulation_stopped",
                  timestamp: now,
                  astronautId: cur.astronautId,
                  actorUserId: officerId,
                  refStore: "simulationRuns",
                  refId: cur.id,
                  summary: `Simulation completed (${step} of ${cur.totalSteps} steps)`,
                  data: { outcome: "completed", step },
                },
                { tx }
              );
            }
            return { ok: true };
          });
        } catch (err) {
          if (err instanceof DatabaseError && err.code === "NOT_FOUND" && err.store === "astronauts") return result("unavailable", "astronaut_missing", now);
          return result("unavailable", "database_error", now);
        }
        if (outcome && outcome.conflict) {
          if (outcome.status === "not_found") return result("not_found", "unknown_run", now);
          return result("conflict", outcome.conflict, now, { runStatus: outcome.runStatus, currentStep: outcome.currentStep });
        }
        // The step is committed. Risk evaluation is a separate transaction (Sprint 8).
        let risk = { status: "not_configured", reason: "", changes: [] };
        if (typeof evaluateRisk === "function") {
          try {
            const a = await repos.astronautsRepo.getById(run.astronautId);
            risk = a && a.id === run.astronautId && CREW_ID_PATTERN.test(a.crewId)
              ? presentRiskResult(await evaluateRisk(session, a.crewId, { now, trigger: "simulation" }))
              : { status: "unavailable", reason: "astronaut_missing", changes: [] };
          } catch {
            risk = { status: "unavailable", reason: "unexpected_error", changes: [] };
          }
        }
        return result(final ? "completed" : "advanced", "", now, {
          step,
          totalSteps: run.totalSteps,
          reading: { step, metric: scenario.metric, value, unit, timestamp: now, source: "simulation" },
          risk,
        });
      });
    },

    /** running → paused. Repeating on a paused run → "unchanged". */
    async pauseSimulation(session, runRef, options = {}) {
      return transition(session, runRef, options, "pause");
    },

    /** paused → running. Repeating on a running run → "unchanged". Needs the scenario. */
    async resumeSimulation(session, runRef, options = {}) {
      return transition(session, runRef, options, "resume");
    },

    /** running / paused → stopped (needs { confirm: true }). Works without the astronaut or scenario. */
    async stopSimulation(session, runRef, input, options = {}) {
      return transition(session, runRef, options, "stop", input);
    },
  };

  async function transition(session, runRef, options, action, input) {
    const now = nowOf(options);
    if (!isTime(now)) return result("invalid", "invalid_time", Date.now());
    const officer = await verifyMedicalOfficer(session, repos, now);
    if (!officer.ok) return officer.refusal;
    if (badRef(runRef)) return result("not_found", "unknown_run", now);
    if (action === "stop" && !(input && typeof input === "object" && input.confirm === true)) return result("invalid", "confirmation_required", now);
    const officerId = officer.officer.id;

    return locked(runRef, now, async () => {
      let outcome;
      try {
        outcome = await runTransaction(RUN_STORES, "readwrite", async (tx) => {
          const cur = await repos.simulationRunsRepo.getById(runRef, { tx });
          if (!cur || cur.id !== runRef) return { status: "not_found" };
          const base = { type: "", timestamp: now, astronautId: cur.astronautId, actorUserId: officerId, refStore: "simulationRuns", refId: cur.id };
          const step = Number.isInteger(cur.step) ? cur.step : 0;
          const total = Number.isInteger(cur.totalSteps) ? cur.totalSteps : 0;

          if (action === "pause") {
            if (cur.status === "paused") return { status: "unchanged", runStatus: cur.status };
            if (cur.status !== "running") return { status: "conflict", runStatus: cur.status };
            await repos.simulationRunsRepo.update(cur.id, { status: "paused", pausedAt: now }, { tx });
            await repos.eventsRepo.add({ ...base, type: "simulation_paused", summary: `Simulation paused at step ${step} of ${total}`, data: { step } }, { tx });
            return { status: "paused" };
          }
          if (action === "resume") {
            if (cur.status === "running") return { status: "unchanged", runStatus: cur.status };
            if (cur.status !== "paused") return { status: "conflict", runStatus: cur.status };
            if (!compatible(cur, scenarioOf(cur.scenarioId))) return { status: "conflict", reason: "scenario_unavailable", runStatus: cur.status };
            await repos.simulationRunsRepo.update(cur.id, { status: "running", pausedAt: 0 }, { tx });
            await repos.eventsRepo.add({ ...base, type: "simulation_started", summary: `Simulation resumed at step ${step} of ${total}`, data: { phase: "resumed", step } }, { tx });
            return { status: "running" };
          }
          // stop
          if (cur.status === "stopped" || cur.status === "completed") return { status: "unchanged", runStatus: cur.status };
          if (cur.status !== "running" && cur.status !== "paused") return { status: "conflict", runStatus: cur.status };
          await repos.simulationRunsRepo.update(cur.id, { status: "stopped", endedAt: now }, { tx });
          await repos.eventsRepo.add({ ...base, type: "simulation_stopped", summary: `Simulation stopped at step ${step} of ${total}`, data: { outcome: "stopped", step } }, { tx });
          return { status: "stopped" };
        });
      } catch {
        return result("unavailable", "database_error", now);
      }
      if (outcome.status === "not_found") return result("not_found", "unknown_run", now);
      if (outcome.status === "conflict") return result("conflict", outcome.reason || "invalid_transition", now, { runStatus: outcome.runStatus });
      if (outcome.status === "unchanged") return result("unchanged", "", now, { runStatus: outcome.runStatus });
      return result(outcome.status, "", now, { runStatus: outcome.status });
    });
  }
}

const production = createSimulationService({
  repos: Object.freeze({ usersRepo, astronautsRepo, measurementsRepo, simulationRunsRepo, eventsRepo }),
  withTransaction,
  evaluateRisk: (session, crewId, options) => evaluateAstronaut(session, crewId, options),
});
export const listSimulationScenarios = () => production.listSimulationScenarios();
export const getSimulationCenter = (session, options) => production.getSimulationCenter(session, options);
export const previewSimulation = (session, input, options) => production.previewSimulation(session, input, options);
export const startSimulation = (session, input, options) => production.startSimulation(session, input, options);
export const advanceSimulation = (session, runRef, input, options) => production.advanceSimulation(session, runRef, input, options);
export const pauseSimulation = (session, runRef, options) => production.pauseSimulation(session, runRef, options);
export const resumeSimulation = (session, runRef, options) => production.resumeSimulation(session, runRef, options);
export const stopSimulation = (session, runRef, input, options) => production.stopSimulation(session, runRef, input, options);
