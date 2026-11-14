// js/db/records.js
// Builds complete records from what a caller passes in: fills ids, base
// fields and documented defaults, converts flags to 0/1, and runs the index
// safety check. Pure module — used by BOTH the real repositories and the
// mock, so they always behave the same.
//
// These are STORAGE rules only: keys, canonical units, defaults, the
// documented enum values of fields that are indexed or queried, the
// role ↔ astronautId link of a user, and immutable identifiers. Business
// validation (allowed ranges, who may do what, alert lifecycle) belongs in
// the services in js/services/.

import { DatabaseError } from "./errors.js";
import { newId } from "./ids.js";
import { findIndexProblems } from "./schema.js";
import {
  ALERT_ACTIONS, ALERT_CATEGORIES, ALERT_STATUSES, CREW, EVENT_TYPES, FLAG_FIELDS, METRICS, METRIC_UNITS,
  QUALITIES, ROLES, SEVERITIES, SIMULATION_STATUSES, SOURCES, SYSTEM_USER,
} from "./constants.js";

// ---- Storage rules (shared with backup validation) ------------------------

/** Documented values for fields that queries filter on. Store → field → allowed values. */
export const ENUM_FIELDS = Object.freeze({
  users: { role: Object.values(ROLES) },
  measurements: { metric: METRICS, source: SOURCES, quality: QUALITIES },
  dailySummaries: { metric: METRICS },
  wellbeingAssessments: { source: SOURCES },
  simulationRuns: { status: SIMULATION_STATUSES },
  alerts: { status: ALERT_STATUSES, severity: SEVERITIES, category: ALERT_CATEGORIES },
  alertActions: { action: ALERT_ACTIONS },
  missionEvents: { type: EVENT_TYPES },
});

/** Fields that identify a record and may never change after creation. */
export const IMMUTABLE_FIELDS = Object.freeze({
  astronauts: ["crewId"],
  alerts: ["number"],
  dailySummaries: ["astronautId", "metric", "date"],
});

/**
 * Every storage-rule problem of a complete record (empty array = OK):
 * index safety, enum values, and the user role ↔ astronautId rule.
 */
export function findRecordProblems(storeName, record) {
  const problems = findIndexProblems(storeName, record);
  if (problems.length || !record || typeof record !== "object") return problems;

  for (const [field, allowed] of Object.entries(ENUM_FIELDS[storeName] || {})) {
    if (!allowed.includes(record[field])) {
      problems.push(`"${field}" is ${JSON.stringify(record[field])} — allowed: ${allowed.join(", ")}`);
    }
  }

  if (storeName === "users") {
    if (typeof record.astronautId !== "string") {
      problems.push('"astronautId" must be a string ("" for a medical officer)');
    } else if (record.role === ROLES.ASTRONAUT && !record.astronautId) {
      problems.push('an astronaut user needs an "astronautId"');
    } else if (record.role === ROLES.MEDICAL_OFFICER && record.astronautId !== "") {
      problems.push('a medical_officer user must have astronautId ""');
    }
  }
  return problems;
}

/** Throw a DatabaseError (code INVALID) if the record breaks a storage rule. */
export function assertRecord(storeName, record) {
  const problems = findRecordProblems(storeName, record);
  if (problems.length) {
    throw new DatabaseError(`Cannot store record in "${storeName}": ${problems.join("; ")}`, {
      code: "INVALID",
      store: storeName,
    });
  }
  return record;
}

// ---- Small helpers --------------------------------------------------------

/** true/false/"1" → 1/0. Numbers other than 0 become 1. */
export function toFlag(value) {
  return value === true || value === 1 || value === "1" ? 1 : 0;
}

/** Convert every known flag field present in `record` to 0/1. */
function normalizeFlags(record) {
  const out = { ...record };
  for (const field of FLAG_FIELDS) {
    if (field in out) out[field] = toFlag(out[field]);
  }
  return out;
}

/** Throw INVALID unless every listed field is present (not undefined/null). */
export function requireFields(storeName, input, fields) {
  if (!input || typeof input !== "object") {
    throw new DatabaseError(`${storeName}: expected a record object`, { code: "INVALID", store: storeName });
  }
  const missing = fields.filter((f) => input[f] === undefined || input[f] === null || input[f] === "");
  if (missing.length) {
    throw new DatabaseError(`${storeName}: missing required field(s): ${missing.join(", ")}`, {
      code: "INVALID",
      store: storeName,
    });
  }
}

/** id + createdAt + updatedAt + createdBy, keeping values the caller gave. */
function baseFields(input, prefix, now) {
  return {
    id: input.id || newId(prefix),
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    createdBy: input.createdBy || SYSTEM_USER,
  };
}

/** Final step for every record: flags → 0/1, then all storage checks. */
function finish(storeName, record) {
  return assertRecord(storeName, normalizeFlags(record));
}

// ---- One builder per store ------------------------------------------------

export function buildMeasurement(input, now = Date.now()) {
  requireFields("measurements", input, ["astronautId", "metric", "value", "timestamp"]);
  const { metric } = input;
  if (!METRICS.includes(metric)) {
    throw new DatabaseError(`measurements: unknown metric "${metric}" (allowed: ${METRICS.join(", ")})`, {
      code: "INVALID",
      store: "measurements",
    });
  }
  const unit = input.unit ?? METRIC_UNITS[metric];
  if (unit !== METRIC_UNITS[metric]) {
    throw new DatabaseError(
      `measurements: ${metric} must be stored in "${METRIC_UNITS[metric]}" (got "${unit}") — convert units only in the UI`,
      { code: "INVALID", store: "measurements" }
    );
  }
  if (typeof input.value !== "number" || !Number.isFinite(input.value)) {
    throw new DatabaseError(`measurements: value must be a finite number (got ${input.value})`, {
      code: "INVALID",
      store: "measurements",
    });
  }
  return finish("measurements", {
    ...input,
    ...baseFields(input, "msr", now),
    unit,
    source: input.source || "manual",
    quality: input.quality || "ok",
    sampleId: input.sampleId || newId("smp"),
    simulationRunId: input.simulationRunId || "",
  });
}

export function buildWellbeing(input, now = Date.now()) {
  requireFields("wellbeingAssessments", input, ["astronautId"]);
  return finish("wellbeingAssessments", {
    ...input,
    ...baseFields(input, "wba", now),
    timestamp: input.timestamp ?? now,
    sharedWithMedical: toFlag(input.sharedWithMedical), // private unless opted in
    source: input.source || "manual",
  });
}

export function buildJournalEntry(input, now = Date.now()) {
  requireFields("privateJournal", input, ["astronautId"]);
  return finish("privateJournal", {
    ...input,
    ...baseFields(input, "jnl", now),
    timestamp: input.timestamp ?? now,
    text: input.text ?? "",
  });
}

export function buildCognitiveCheck(input, now = Date.now()) {
  requireFields("cognitiveChecks", input, ["astronautId", "meanReactionMs"]);
  return finish("cognitiveChecks", {
    ...input,
    ...baseFields(input, "cog", now),
    timestamp: input.timestamp ?? now,
    trials: input.trials ?? 0,
    misses: input.misses ?? 0,
  });
}

export function buildSimulationRun(input, now = Date.now()) {
  requireFields("simulationRuns", input, ["astronautId", "scenarioId", "operatorId"]);
  return finish("simulationRuns", {
    ...input,
    ...baseFields(input, "sim", now),
    status: input.status || "running",
    speed: input.speed ?? 1,
    startedAt: input.startedAt ?? now,
    endedAt: input.endedAt ?? 0,
  });
}

/** `number` must already be assigned (alertsRepo.add does that). */
export function buildAlert(input, now = Date.now()) {
  requireFields("alerts", input, ["number", "astronautId", "ruleId", "severity", "category"]);
  const detectedAt = input.detectedAt ?? now;
  return finish("alerts", {
    ...input,
    ...baseFields(input, "alr", now),
    dedupeKey: input.dedupeKey || `${input.astronautId}:${input.ruleId}`,
    type: input.type || input.ruleId,
    status: input.status || "new",
    detectedAt,
    lastTriggeredAt: input.lastTriggeredAt ?? detectedAt,
    occurrenceCount: input.occurrenceCount ?? 1,
    triggeringMeasurements: input.triggeringMeasurements || [],
    rule: input.rule || { id: input.ruleId, description: "", thresholdUsed: "" },
    explanation: input.explanation ?? "",
    suggestedAction: input.suggestedAction ?? "",
    conditionCleared: toFlag(input.conditionCleared),
    acknowledgedAt: input.acknowledgedAt ?? 0,
    acknowledgedBy: input.acknowledgedBy ?? "",
    resolvedAt: input.resolvedAt ?? 0,
    resolvedBy: input.resolvedBy ?? "",
    resolutionNote: input.resolutionNote ?? "",
  });
}

export function buildAlertAction(input, now = Date.now()) {
  requireFields("alertActions", input, ["alertId", "action"]);
  const userId = input.userId || SYSTEM_USER;
  return finish("alertActions", {
    ...input,
    ...baseFields({ createdBy: userId, ...input }, "act", now),
    userId,
    timestamp: input.timestamp ?? now,
    note: input.note ?? "",
  });
}

export function buildMessage(input, now = Date.now()) {
  requireFields("messages", input, ["astronautId", "fromUserId"]);
  return finish("messages", {
    ...input,
    ...baseFields({ createdBy: input.fromUserId, ...input }, "msg", now),
    templateId: input.templateId ?? "",
    body: input.body ?? "",
    relatedAlertId: input.relatedAlertId || "",
    sentAt: input.sentAt ?? now,
    acknowledgedAt: input.acknowledgedAt ?? 0,
    response: input.response ?? null, // NOT indexed, so null is allowed here
  });
}

export function buildEvent(input, now = Date.now()) {
  requireFields("missionEvents", input, ["type"]);
  const actorUserId = input.actorUserId || SYSTEM_USER;
  return finish("missionEvents", {
    ...input,
    ...baseFields({ createdBy: actorUserId, ...input }, "evt", now),
    timestamp: input.timestamp ?? now,
    astronautId: input.astronautId || CREW,
    actorUserId,
    refStore: input.refStore ?? "",
    refId: input.refId ?? "",
    summary: input.summary ?? "",
  });
}

export function buildReport(input, now = Date.now()) {
  requireFields("reports", input, ["type", "generatedBy"]);
  return finish("reports", {
    ...input,
    ...baseFields({ createdBy: input.generatedBy, ...input }, "rpt", now),
    title: input.title ?? "",
    astronautId: input.astronautId || CREW,
    period: input.period || { from: 0, to: 0 },
    snapshot: input.snapshot || {},
  });
}

export function buildDailySummary(input, now = Date.now()) {
  requireFields("dailySummaries", input, ["astronautId", "metric", "date"]);
  return finish("dailySummaries", {
    ...input,
    id: `${input.astronautId}:${input.metric}:${input.date}`,
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    createdBy: input.createdBy || SYSTEM_USER,
  });
}

/** Users are built without the password; usersRepo adds hash + salt. */
export function buildUser(input, now = Date.now()) {
  requireFields("users", input, ["username", "displayName", "role"]);
  return finish("users", {
    ...input,
    ...baseFields(input, "usr", now),
    username: normalizeUsername(input.username),
    astronautId: input.astronautId || "",
  });
}

/** Usernames are stored trimmed + lower-case, so login is case-insensitive. */
export function normalizeUsername(username) {
  return String(username ?? "").trim().toLowerCase();
}

/** Remove secrets before a user record leaves the database layer. */
export function toSafeUser(user) {
  if (!user) return null;
  const { password, passwordHash, salt, ...safe } = user;
  return safe;
}

/**
 * Shallow-merge `changes` into `existing` for update(). Never changes id,
 * createdAt or createdBy (silently kept). Changing an immutable identifier
 * (IMMUTABLE_FIELDS, e.g. astronaut crewId or alert number) throws INVALID.
 * Sets updatedAt. Flags → 0/1. Runs all storage checks.
 */
export function mergeChanges(storeName, existing, changes, now = Date.now()) {
  const { id, createdAt, createdBy, ...allowed } = changes || {};
  for (const field of IMMUTABLE_FIELDS[storeName] || []) {
    if (field in allowed && allowed[field] !== existing[field]) {
      throw new DatabaseError(`${storeName}: "${field}" can't be changed after creation`, {
        code: "INVALID",
        store: storeName,
        operation: "update",
      });
    }
  }
  return finish(storeName, {
    ...existing,
    ...allowed,
    id: existing.id,
    createdAt: existing.createdAt,
    createdBy: existing.createdBy,
    updatedAt: now,
  });
}
