// js/db/types.js
// JSDoc type definitions for every record — NO runtime code.
// They give editors (VS Code) autocomplete and type hints in plain JS:
//
//   /** @typedef {import("../db/types.js").Alert} Alert */
//   /** @param {Alert} alert */
//   function showAlert(alert) { alert.number … }
//
// Keep in sync with docs/DATA-MODEL.md.

/**
 * Fields every record has (except settings and meta).
 * @typedef {object} BaseFields
 * @property {string} id
 * @property {number} createdAt   ms since epoch (UTC)
 * @property {number} updatedAt   ms since epoch (UTC)
 * @property {string} createdBy   user id or "system"
 */

/** @typedef {"astronaut"|"medical_officer"} Role */

/**
 * @typedef {BaseFields & {
 *   username: string, displayName: string, role: Role, astronautId: string,
 *   passwordHash: string, salt: string
 * }} User
 */

/** A user WITHOUT passwordHash/salt — what repositories return. @typedef {Omit<User, "passwordHash"|"salt">} SafeUser */

/** @typedef {"heartRate"|"spo2"|"bpSystolic"|"bpDiastolic"|"sleepDuration"|"activity"|"fatigue"} MetricName */

/**
 * @typedef {object} Baseline
 * @property {number} heartRate      bpm
 * @property {number} spo2           %
 * @property {number} bpSystolic     mmHg
 * @property {number} bpDiastolic    mmHg
 * @property {number} sleepDuration  hours
 */

/** @typedef {{ value: number, timestamp: number }} LatestValue */
/** @typedef {Partial<Record<MetricName, LatestValue>>} LatestValues */

/**
 * @typedef {BaseFields & {
 *   crewId: string, name: string, missionRole: string, age: number, initials: string,
 *   baseline: Baseline, latest: LatestValues
 * }} Astronaut
 */

/**
 * @typedef {BaseFields & {
 *   astronautId: string, metric: MetricName, value: number, unit: string, timestamp: number,
 *   source: "seed"|"simulation"|"manual", quality: "ok"|"suspect"|"invalid",
 *   sampleId: string, simulationRunId: string
 * }} Measurement
 */

/**
 * @typedef {BaseFields & {
 *   astronautId: string, metric: MetricName, date: string,
 *   min: number, max: number, avg: number, count: number
 * }} DailySummary
 */

/**
 * Check-in scales: mood/sleepQuality/wellbeing 1–5, stress/fatigue/isolation 0–10.
 * @typedef {BaseFields & {
 *   astronautId: string, timestamp: number,
 *   mood: number, stress: number, sleepQuality: number, fatigue: number, isolation: number, wellbeing: number,
 *   sharedWithMedical: 0|1, source: "seed"|"simulation"|"manual"
 * }} WellbeingAssessment
 */

/** @typedef {BaseFields & { astronautId: string, timestamp: number, text: string }} JournalEntry */

/**
 * @typedef {BaseFields & {
 *   astronautId: string, timestamp: number, meanReactionMs: number, trials: number, misses: number
 * }} CognitiveCheck
 */

/**
 * @typedef {BaseFields & {
 *   astronautId: string, scenarioId: string, status: "running"|"paused"|"stopped"|"completed",
 *   speed: number, operatorId: string, startedAt: number, endedAt: number
 * }} SimulationRun
 */

/**
 * @typedef {object} TriggeringMeasurement
 * @property {string} metric
 * @property {number} value
 * @property {string} unit
 * @property {number} timestamp
 * @property {string} measurementId  measurement id (or wellbeing assessment id)
 */

/** Snapshot of the rule at detection time. @typedef {{ id: string, description: string, thresholdUsed: string }} AlertRuleSnapshot */

/** @typedef {"info"|"warning"|"critical"} Severity */
/** @typedef {"new"|"acknowledged"|"resolved"} AlertStatus */

/**
 * @typedef {BaseFields & {
 *   number: string, astronautId: string, ruleId: string, dedupeKey: string, type: string,
 *   category: "physical"|"wellbeing", severity: Severity, status: AlertStatus, title?: string,
 *   detectedAt: number, lastTriggeredAt: number, occurrenceCount: number,
 *   triggeringMeasurements: TriggeringMeasurement[], rule: AlertRuleSnapshot,
 *   explanation: string, suggestedAction: string, conditionCleared: 0|1,
 *   acknowledgedAt: number, acknowledgedBy: string,
 *   resolvedAt: number, resolvedBy: string, resolutionNote: string
 * }} Alert
 */

/**
 * @typedef {BaseFields & {
 *   alertId: string, action: "created"|"escalated"|"acknowledged"|"condition_cleared"|"resolved",
 *   userId: string, timestamp: number, note: string
 * }} AlertAction
 */

/** @typedef {{ templateId: string, text: string, at: number }} MessageResponse */

/**
 * @typedef {BaseFields & {
 *   astronautId: string, fromUserId: string, templateId: string, body: string,
 *   relatedAlertId: string, sentAt: number, acknowledgedAt: number, response: MessageResponse|null
 * }} Message
 */

/**
 * @typedef {BaseFields & {
 *   timestamp: number, type: string, astronautId: string, actorUserId: string,
 *   refStore: string, refId: string, summary: string, data?: object
 * }} MissionEvent
 */

/**
 * @typedef {BaseFields & {
 *   type: string, title: string, generatedBy: string, astronautId: string,
 *   period: { from: number, to: number }, snapshot: object
 * }} Report
 */

/** @typedef {{ key: string, value: any, updatedAt: number, updatedBy: string }} Setting */
/** @typedef {{ key: string, value: any }} MetaEntry */

// ---- Function parameters / results ---------------------------------------

/** Optional last argument of repository functions. @typedef {{ tx?: IDBTransaction }} TxOptions */

/**
 * @typedef {object} AlertQuery
 * @property {string} [astronautId]
 * @property {AlertStatus|AlertStatus[]} [status]
 * @property {Severity|Severity[]} [severity]
 * @property {number} [fromTs]   detectedAt ≥ fromTs
 * @property {number} [toTs]     detectedAt ≤ toTs
 * @property {number} [limit]
 */

/**
 * @typedef {object} EventQuery
 * @property {string|string[]} [astronautId]  include "crew" for crew-wide events
 * @property {string|string[]} [types]
 * @property {number} [fromTs]
 * @property {number} [toTs]
 * @property {number} [limit]
 */

/**
 * @typedef {object} BackupFile
 * @property {"AstroHealth AI"} app
 * @property {number} schemaVersion
 * @property {number} exportedAt
 * @property {Record<string, object[]>} stores
 */

/** @typedef {{ usage: number|null, quota: number|null, persisted: boolean }} StorageInfo */
/** @typedef {{ daysCompacted: number, readingsDeleted: number, summariesWritten: number }} CompactionResult */

export {};
