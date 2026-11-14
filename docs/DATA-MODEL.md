# AstroHealth AI — Data model & database contract

> **Status:** v1 — **frozen for Sprint 2 integration** (see section 16). Changes
> now need an update to this file, the mock repositories and the relevant
> tests in the same change.
> Research & educational prototype · Not a medical device · All data synthetic.

This file is the contract between the **database layer** (`js/db/`) and the
**services** that call it (`js/services/`). The code in `js/db/` must always
match this document. If you change one, change the other in the same change.

---

## 1. Overview

- One IndexedDB database: **`astrohealth`**, version **1**
  (`DB_NAME` / `DB_VERSION` in `js/core/config.js`).
- **15 object stores** (section 3). Everything lives on the device; nothing
  is ever sent anywhere.
- The database layer (`js/db/`: repositories plus `database.js`, `seed.js`,
  `backup.js`, `maintenance.js`) is the *only* code that talks to IndexedDB.
  Pages and services never touch the database directly.
- Repositories **only read and write**. They do **not** check permissions,
  evaluate risk rules, decide alerts, write timeline events for you, or touch
  the UI. The services (`js/services/`) do all of that.
- Every repository function is `async` and returns a Promise. Failures are
  thrown as a **`DatabaseError`** (section 6).

### How to import (services)

```js
// One import point for everything:
import { alertsRepo, measurementsRepo, withTransaction, DatabaseError } from "../db/index.js";

// Types for editor autocomplete (JSDoc):
/** @typedef {import("../db/types.js").Alert} Alert */
```

For tests without a real database, import the same names from
`js/db/mock-repositories.js` (section 13).

### Files

| File | What it does | Runs in Node? |
| --- | --- | --- |
| `database.js` | open / upgrade / close, `withTransaction()`, error mapping, persistence | no (browser) |
| `schema.js` | store + index definitions, `MIGRATIONS`, index checks | yes |
| `constants.js` | metric names, canonical units, roles, statuses, event types | yes |
| `types.js` | JSDoc `@typedef` for every record (no runtime code) | yes |
| `ids.js` | `newId()`, alert numbers (`ALT-0001`) | yes |
| `errors.js` | `DatabaseError` | yes |
| `random.js` | seeded random generator (mulberry32) | yes |
| `summaries.js` | dates, daily summaries, "latest value" cache helpers | yes |
| `records.js` | default values + integrity checks for new records | yes |
| `password.js` | PBKDF2 password hashing (demo only) | yes |
| `seed-data.js` | builds the deterministic demo data set (no DB) | yes |
| `seed.js` | `seedDemoData()` — writes the demo data | no |
| `backup-format.js` | backup file format + `validateBackup()` (runs every storage rule on every record) | yes |
| `backup.js` | `exportAll()`, `importAll()`, `resetDatabase()` | no |
| `maintenance.js` | `compactMeasurements()`, `getStorageInfo()` | no |
| `repositories/*.js` | one repository per store | no |
| `mock-repositories.js` | in-memory repos with the same API | yes* |
| `index.js` | re-exports everything | no |

\* `mock-repositories.js` uses only standard JS + WebCrypto.

---

## 2. Conventions

### Base fields

Every record **except `settings` and `meta`** has:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Primary key (see ID rules). Generated if you don't pass one. |
| `createdAt` | number | ms since epoch (UTC). Set by the repository. |
| `updatedAt` | number | ms since epoch (UTC). Set on every write. |
| `createdBy` | string | A user `id`, or `"system"`. Defaults to `"system"`. |

Repositories set `createdAt` / `updatedAt` themselves. `update()` never
changes `id`, `createdAt` or `createdBy`.

### ID rules

| Kind | Format | Example |
| --- | --- | --- |
| Generated IDs | `<prefix>_<uuid>` using `crypto.randomUUID()` | `msr_3f2c…` |
| Seed IDs (fixed, so seeding twice can't duplicate) | `<prefix>_seed_<n>` | `msr_seed_00042` |
| Astronauts | fixed | `a-01` … `a-04` |
| Users (seed) | fixed | `u-medofficer`, `u-haddad` |
| Alert **number** (human-readable, unique) | `ALT-` + 4 digits from `meta.alertCounter` | `ALT-0193` |
| Daily summary | `${astronautId}:${metric}:${YYYY-MM-DD}` | `a-01:heartRate:2026-11-14` |
| Settings / meta | the `key` string | `"mission"`, `"alertCounter"` |

Prefixes: `usr` user · `msr` measurement · `smp` sample · `wba` wellbeing
assessment · `jnl` journal · `cog` cognitive check · `sim` simulation run ·
`alr` alert · `act` alert action · `msg` message · `evt` mission event ·
`rpt` report.

An alert has **both** an `id` (`alr_…`, primary key, never shown) and a
`number` (`ALT-0193`, shown in the UI).

### Timestamps

All times are **numbers: milliseconds since epoch, UTC** (`Date.now()`).
Never store `Date` objects or ISO strings in timestamp fields. Calendar
dates (`dailySummaries.date`) are `"YYYY-MM-DD"` strings **in UTC**. The
mission clock is UTC, like the ISS.

**"Not happened yet" = `0`** for timestamps (`acknowledgedAt: 0`) and **`""`**
for user/ID references (`acknowledgedBy: ""`). Never `null` in these fields.

### Canonical units

The database stores **only** these units. Convert in the UI only.

| Metric / field | Unit | Range |
| --- | --- | --- |
| `heartRate` | `bpm` | — |
| `spo2` | `%` | 0–100 |
| `bpSystolic`, `bpDiastolic` | `mmHg` | — |
| `sleepDuration` | `h` (hours, decimals ok) | — |
| `activity` | `steps` — **cumulative steps since 00:00 UTC that day** | ≥ 0 |
| `fatigue` (measurement & check-in) | `0-10` | 0–10 |
| `stress`, `isolation` | 0–10 | 0–10 |
| `mood`, `sleepQuality`, `wellbeing` | 1–5 | 1–5 |
| `meanReactionMs` | ms | — |

`measurementsRepo.add()` rejects a measurement whose `unit` differs from the
canonical unit (or fills it in when you leave `unit` out).

### Flags (no booleans!)

IndexedDB **cannot index booleans, `null` or `undefined`** — such records just
silently disappear from the index. So:

- Flags are stored as numbers **`0` / `1`** (`sharedWithMedical`,
  `conditionCleared`, and flags inside settings).
- Repositories convert `true`/`false` you pass into `1`/`0` for flag fields.
- Optional / nullable fields are **never indexed** (`messages.response`,
  `missionEvents.data`, `measurements.simulationRunId`).
- Every write runs an **index check**: if an indexed field is missing,
  `null`, `undefined`, boolean or `NaN`, the write is rejected with a
  `DatabaseError` (`code: "INVALID"`) instead of silently vanishing from queries.

### Storage rules checked on every write (and on backup import)

These are **storage** rules, not business rules (`ENUM_FIELDS`,
`IMMUTABLE_FIELDS` and `findRecordProblems()` in `records.js`). A violation
throws `DatabaseError` with `code: "INVALID"` (on import:
`INCOMPATIBLE_BACKUP`).

| Rule | Details |
| --- | --- |
| Index safety | primary key + every indexed field is a string or a number (not boolean/null/undefined/NaN) |
| Documented values | `users.role` ∈ ROLES · `measurements.metric` ∈ METRICS, `.source` ∈ SOURCES, `.quality` ∈ QUALITIES · `dailySummaries.metric` · `wellbeingAssessments.source` · `simulationRuns.status` · `alerts.status` / `.severity` / `.category` · `alertActions.action` · `missionEvents.type` ∈ EVENT_TYPES |
| Canonical units | `measurements.unit` must equal `METRIC_UNITS[metric]`; `value` must be a finite number |
| User role link | `astronaut` needs a non-empty `astronautId`; `medical_officer` must have `astronautId: ""` |
| Immutable identifiers | `update()` can't change `astronauts.crewId` or `alerts.number` (INVALID); `id`, `createdAt`, `createdBy` are always kept |
| Storable values | values that can't be cloned (functions, DOM nodes) → INVALID |

Need a new event type, status or metric? Add it to `constants.js` (and this
file) in a reviewed PR — never store an undocumented value.

### Sort order of results

| Kind of query | Order |
| --- | --- |
| Time series for charts — measurements, daily summaries, wellbeing, cognitive checks, alert actions | **oldest → newest** |
| Lists for display — alerts, events, messages, journal, reports, simulation runs | **newest → oldest** |

Records with the **same time are ordered by `id` (ascending)**, in the real
repositories and the mock alike, so results are always deterministic.

### Not-found and extra fields

- `getById()` style functions return **`null`** (not `undefined`) when nothing matches.
- `update(id, changes)` throws `DatabaseError` with `code: "NOT_FOUND"` if the record doesn't exist.
- `update()` is a **shallow merge**: nested objects (`baseline`, `rule`, `period`…) are replaced, not merged.
- You may store extra non-indexed fields; they are kept as-is.

---

## 3. Stores (schema version 1)

Notation: **PK** = primary key (keyPath). Index names are exact.

### 3.1 `users`

| Field | Type | Required | Key/index | Notes |
| --- | --- | --- | --- | --- |
| `id` | string | yes | **PK** | `usr_…` or seed `u-…` |
| `username` | string | yes | `username` (**unique**) | stored **lower-case, trimmed** |
| `displayName` | string | yes | | "Dr. Lena Ortiz" |
| `role` | `"astronaut"` \| `"medical_officer"` | yes | | exact values, enforced on add/update (`ROLES`) |
| `astronautId` | string | yes | | `"a-01"`, or `""` for a medical officer |
| `passwordHash` | string (base64) | yes | | PBKDF2-SHA256, 100 000 iterations, 32 bytes |
| `salt` | string (base64) | yes | | 16 random bytes |
| base fields | | | | |

> ⚠️ **DEMO security only.** Hashing happens in the browser and anyone with
> the device can read or replace the database. This protects nothing real.
> Repositories **never return** `passwordHash` / `salt` (except in backups).

```json
{ "id": "u-medofficer", "username": "medofficer", "displayName": "Dr. Lena Ortiz",
  "role": "medical_officer", "astronautId": "", "passwordHash": "q8…=", "salt": "Zt…==",
  "createdAt": 1763100000000, "updatedAt": 1763100000000, "createdBy": "system" }
```

### 3.2 `astronauts`

| Field | Type | Required | Key/index | Notes |
| --- | --- | --- | --- | --- |
| `id` | string | yes | **PK** | `a-01` |
| `crewId` | string | yes | `crewId` (**unique**) | `AH-01` |
| `name` | string | yes | | "Sami Haddad" |
| `missionRole` | string | yes | | "Commander" |
| `age` | number | yes | | |
| `initials` | string | yes | | "SH" |
| `baseline` | object | yes | | `{ heartRate, spo2, bpSystolic, bpDiastolic, sleepDuration }` canonical units |
| `latest` | object | yes | | **denormalized cache** of the newest value per metric: `{ heartRate: { value, timestamp }, spo2: {…}, bpSystolic, bpDiastolic, sleepDuration, activity, fatigue }`. A metric is missing until it has a reading. |
| base fields | | | | |

`latest` is maintained **automatically** by `measurementsRepo.add/addMany`
(same transaction). It only moves forward in time, and readings with
`quality: "invalid"` never update it.

```json
{ "id": "a-01", "crewId": "AH-01", "name": "Sami Haddad", "missionRole": "Commander",
  "age": 41, "initials": "SH",
  "baseline": { "heartRate": 72, "spo2": 98, "bpSystolic": 118, "bpDiastolic": 76, "sleepDuration": 7 },
  "latest": { "heartRate": { "value": 74, "timestamp": 1763128800000 }, "spo2": { "value": 98, "timestamp": 1763128800000 } },
  "createdAt": 1763100000000, "updatedAt": 1763128800000, "createdBy": "system" }
```

### 3.3 `measurements` (raw readings)

| Field | Type | Required | Key/index | Notes |
| --- | --- | --- | --- | --- |
| `id` | string | yes | **PK** | `msr_…` |
| `astronautId` | string | yes | in `by_astronaut_metric_time`, `by_astronaut_time` | |
| `metric` | `"heartRate"` \| `"spo2"` \| `"bpSystolic"` \| `"bpDiastolic"` \| `"sleepDuration"` \| `"activity"` \| `"fatigue"` | yes | in `by_astronaut_metric_time` | |
| `value` | number | yes | | canonical unit |
| `unit` | string | yes | | must equal the canonical unit |
| `timestamp` | number | yes | in all three time indexes, `by_time` | when the reading was taken |
| `source` | `"seed"` \| `"simulation"` \| `"manual"` | yes | | default `"manual"` |
| `quality` | `"ok"` \| `"suspect"` \| `"invalid"` | yes | | default `"ok"` |
| `sampleId` | string | yes | `by_sample` | readings taken together share it (BP systolic + diastolic **must**) |
| `simulationRunId` | string | yes | | `""` when not from a simulation (not indexed) |
| base fields | | | | |

Indexes: `by_astronaut_metric_time` `[astronautId, metric, timestamp]`,
`by_astronaut_time` `[astronautId, timestamp]`, `by_time` `timestamp`,
`by_sample` `sampleId`.

**One record per metric per sample.** A blood-pressure reading = two records
(`bpSystolic`, `bpDiastolic`) with the same `sampleId` and `timestamp`.

```json
{ "id": "msr_seed_00042", "astronautId": "a-01", "metric": "bpSystolic", "value": 118,
  "unit": "mmHg", "timestamp": 1763128800000, "source": "seed", "quality": "ok",
  "sampleId": "smp_seed_00007", "simulationRunId": "",
  "createdAt": 1763128800000, "updatedAt": 1763128800000, "createdBy": "system" }
```

### 3.4 `dailySummaries`

| Field | Type | Required | Key/index | Notes |
| --- | --- | --- | --- | --- |
| `id` | string | yes | **PK** | `${astronautId}:${metric}:${date}` |
| `astronautId` | string | yes | in `by_astronaut_metric_date` | |
| `metric` | string | yes | in `by_astronaut_metric_date` | same names as measurements |
| `date` | string `YYYY-MM-DD` (UTC) | yes | in `by_astronaut_metric_date` | |
| `min`, `max`, `avg` | number | yes | | over readings with `quality ≠ "invalid"` |
| `count` | number | yes | | number of readings included |
| base fields | | | | `createdBy: "system"` |

Index: `by_astronaut_metric_date` `[astronautId, metric, date]`.

Summaries are **always current**: `measurementsRepo.add/addMany` update the
day's summary in the same transaction. Compaction (section 9) recomputes a
day exactly from its raw readings before deleting them. Use summaries for
7d / 14d / 30d charts. For `activity` (cumulative steps), the day's **`max`
is the daily step total**.

```json
{ "id": "a-01:heartRate:2026-11-13", "astronautId": "a-01", "metric": "heartRate",
  "date": "2026-11-13", "min": 63, "max": 81, "avg": 72.4, "count": 12,
  "createdAt": 1763049600000, "updatedAt": 1763128800000, "createdBy": "system" }
```

### 3.5 `wellbeingAssessments` (daily check-ins)

| Field | Type | Required | Key/index | Notes |
| --- | --- | --- | --- | --- |
| `id` | string | yes | **PK** | `wba_…` |
| `astronautId` | string | yes | in `by_astronaut_time` | |
| `timestamp` | number | yes | in `by_astronaut_time`, `by_shared_time` | |
| `mood` | 1–5 | yes | | |
| `stress` | 0–10 | yes | | |
| `sleepQuality` | 1–5 | yes | | |
| `fatigue` | 0–10 | yes | | |
| `isolation` | 0–10 | yes | | |
| `wellbeing` | 1–5 | yes | | |
| `sharedWithMedical` | `0` \| `1` | yes | in `by_shared_time` | default **`0`** (private unless the astronaut opts in) |
| `source` | `"seed"` \| `"simulation"` \| `"manual"` | yes | | |
| base fields | | | | `createdBy` = the astronaut's user id |

Indexes: `by_astronaut_time` `[astronautId, timestamp]`,
`by_shared_time` `[sharedWithMedical, timestamp]`.

The personal reflection text is **not** stored here — it goes to
`privateJournal`.

```json
{ "id": "wba_seed_00003", "astronautId": "a-03", "timestamp": 1763107200000,
  "mood": 2, "stress": 7, "sleepQuality": 3, "fatigue": 5, "isolation": 6, "wellbeing": 2,
  "sharedWithMedical": 1, "source": "seed",
  "createdAt": 1763107200000, "updatedAt": 1763107200000, "createdBy": "u-chen" }
```

### 3.6 `privateJournal`

| Field | Type | Required | Key/index | Notes |
| --- | --- | --- | --- | --- |
| `id` | string | yes | **PK** | `jnl_…` |
| `astronautId` | string | yes | in `by_astronaut_time` | |
| `timestamp` | number | yes | in `by_astronaut_time` | |
| `text` | string | yes | | free text |
| base fields | | | | |

Kept in its **own store** so Medical Officer queries can never touch it by
accident. Services must only read it for the owning astronaut. **Not
encrypted** (out of scope for this prototype). Journal entries are **never**
written to `missionEvents`.

```json
{ "id": "jnl_seed_00001", "astronautId": "a-03", "timestamp": 1763109000000,
  "text": "Long day in the lab module. Missing home more than usual.",
  "createdAt": 1763109000000, "updatedAt": 1763109000000, "createdBy": "u-chen" }
```

### 3.7 `cognitiveChecks`

| Field | Type | Required | Key/index | Notes |
| --- | --- | --- | --- | --- |
| `id` | string | yes | **PK** | `cog_…` |
| `astronautId` | string | yes | in `by_astronaut_time` | |
| `timestamp` | number | yes | in `by_astronaut_time` | |
| `meanReactionMs` | number | yes | | |
| `trials` | number | yes | | e.g. 10 |
| `misses` | number | yes | | |
| base fields | | | | |

```json
{ "id": "cog_seed_00001", "astronautId": "a-04", "timestamp": 1763111000000,
  "meanReactionMs": 342, "trials": 10, "misses": 1,
  "createdAt": 1763111000000, "updatedAt": 1763111000000, "createdBy": "u-reyes" }
```

### 3.8 `simulationRuns`

| Field | Type | Required | Key/index | Notes |
| --- | --- | --- | --- | --- |
| `id` | string | yes | **PK** | `sim_…` |
| `astronautId` | string | yes | `by_astronaut` | target astronaut |
| `scenarioId` | string | yes | | `"low_oxygen"` etc. (the simulation service defines the list) |
| `status` | `"running"` \| `"paused"` \| `"stopped"` \| `"completed"` | yes | `by_status` | default `"running"` |
| `speed` | number | yes | | 1, 2, 4, 8 |
| `operatorId` | string | yes | | user id of the medical officer |
| `startedAt` | number | yes | `by_started` | |
| `endedAt` | number | yes | | `0` until ended |
| base fields | | | | |

```json
{ "id": "sim_9c1…", "astronautId": "a-01", "scenarioId": "low_oxygen", "status": "running",
  "speed": 4, "operatorId": "u-medofficer", "startedAt": 1763130240000, "endedAt": 0,
  "createdAt": 1763130240000, "updatedAt": 1763130240000, "createdBy": "u-medofficer" }
```

### 3.9 `alerts`

| Field | Type | Required | Key/index | Notes |
| --- | --- | --- | --- | --- |
| `id` | string | yes | **PK** | `alr_…` |
| `number` | string | yes | `by_number` (**unique**) | `ALT-0193`, assigned by `alertsRepo.add` |
| `astronautId` | string | yes | in `by_astronaut_status` | |
| `ruleId` | string | yes | | `"PHY-02"` |
| `dedupeKey` | string | yes | in `by_dedupe_status` | default `${astronautId}:${ruleId}` |
| `type` | string | yes | | short machine name, e.g. `"low_spo2"` |
| `category` | `"physical"` \| `"wellbeing"` | yes | | |
| `severity` | `"info"` \| `"warning"` \| `"critical"` | yes | `by_severity` | |
| `status` | `"new"` \| `"acknowledged"` \| `"resolved"` | yes | `by_status`, in `by_astronaut_status`, `by_dedupe_status` | default `"new"`. **Open** = new or acknowledged |
| `detectedAt` | number | yes | `by_detected` | default now |
| `lastTriggeredAt` | number | yes | | default `detectedAt` |
| `occurrenceCount` | number | yes | | default 1 |
| `triggeringMeasurements` | array | yes | | `[{ metric, value, unit, timestamp, measurementId }]`. `measurementId` may also be a wellbeing assessment id |
| `rule` | object | yes | | **snapshot at detection time**: `{ id, description, thresholdUsed }` |
| `title` | string | no | | display title, e.g. "Low oxygen saturation" |
| `explanation` | string | yes | | why it fired |
| `suggestedAction` | string | yes | | review guidance, never a prescription |
| `conditionCleared` | `0` \| `1` | yes | | default 0 |
| `acknowledgedAt` / `acknowledgedBy` | number / string | yes | | `0` / `""` until acknowledged |
| `resolvedAt` / `resolvedBy` / `resolutionNote` | number / string / string | yes | | `0` / `""` / `""` until resolved |
| base fields | | | | |

Indexes: `by_number` (unique), `by_astronaut_status` `[astronautId, status]`,
`by_status`, `by_severity`, `by_detected` `detectedAt`,
`by_dedupe_status` `[dedupeKey, status]`.

**Optional, non-indexed metadata written by the Sprint 8 risk service.** These
fields are not required, add no store or index, change no enum or required
field, need no migration and leave `DB_VERSION` at 1. Alerts created earlier
(including the seeded history) simply don't have them.

| Field | Type | Notes |
| --- | --- | --- |
| `rule.version` | number | version of the rule that created the alert, e.g. `2` for PHY-01 v2 |
| `rule.thresholdSource` | string | where the threshold values came from, e.g. `"settings.thresholds (demonstration values, not clinically validated)"` |
| `triggeringMeasurements[].source` | `"seed"` \| `"simulation"` \| `"manual"` | copied from the measurement when the evidence snapshot was taken |
| `triggeringMeasurements[].quality` | `"ok"` \| `"suspect"` \| `"invalid"` | copied from the measurement (only `"ok"` readings are used as evidence) |
| `evaluation` | object | the latest evaluation that changed the alert: `{ ruleVersion, evaluatedAt, considered, excluded: { suspect, invalid, stale }, limitation }` — `considered` and the `excluded` counts are numbers, `limitation` is text |

Evidence items are immutable snapshots: `{ metric, value, unit, timestamp,
measurementId, source, quality }`. Pages never receive `measurementId` or
any other internal id.

```json
{ "id": "alr_seed_00004", "number": "ALT-0190", "astronautId": "a-04", "ruleId": "PHY-05",
  "dedupeKey": "a-04:PHY-05", "type": "reduced_sleep", "category": "physical",
  "severity": "warning", "status": "acknowledged", "title": "Reduced sleep duration",
  "detectedAt": 1763100120000, "lastTriggeredAt": 1763100120000, "occurrenceCount": 1,
  "triggeringMeasurements": [{ "metric": "sleepDuration", "value": 5.8, "unit": "h",
    "timestamp": 1763100000000, "measurementId": "msr_seed_02101" }],
  "rule": { "id": "PHY-05", "description": "Sleep below threshold on 3 consecutive nights",
    "thresholdUsed": "< 6.5 h × 3 nights" },
  "explanation": "Sleep was below 6.5 h for the last 3 nights.",
  "suggestedAction": "Medical officer review recommended. Follow approved crew protocol.",
  "conditionCleared": 0, "acknowledgedAt": 1763102400000, "acknowledgedBy": "u-medofficer",
  "resolvedAt": 0, "resolvedBy": "", "resolutionNote": "",
  "createdAt": 1763100120000, "updatedAt": 1763102400000, "createdBy": "system" }
```

### 3.10 `alertActions` (audit trail per alert)

| Field | Type | Required | Key/index | Notes |
| --- | --- | --- | --- | --- |
| `id` | string | yes | **PK** | `act_…` |
| `alertId` | string | yes | `by_alert` | alert `id` (not number) |
| `action` | `"created"` \| `"escalated"` \| `"acknowledged"` \| `"condition_cleared"` \| `"resolved"` | yes | | |
| `userId` | string | yes | | user id or `"system"` |
| `timestamp` | number | yes | `by_time` | |
| `note` | string | yes | | default `""` |
| base fields | | | | |

```json
{ "id": "act_seed_00010", "alertId": "alr_seed_00004", "action": "acknowledged",
  "userId": "u-medofficer", "timestamp": 1763102400000, "note": "",
  "createdAt": 1763102400000, "updatedAt": 1763102400000, "createdBy": "u-medofficer" }
```

### 3.11 `messages` (medical officer ↔ astronaut)

| Field | Type | Required | Key/index | Notes |
| --- | --- | --- | --- | --- |
| `id` | string | yes | **PK** | `msg_…` |
| `astronautId` | string | yes | in `by_astronaut_time` | the astronaut the conversation is about/with |
| `fromUserId` | string | yes | | sender |
| `templateId` | string | yes | | `"rest_and_reassess"` etc., `""` for free text |
| `body` | string | yes | | |
| `relatedAlertId` | string | yes | `by_alert` | alert `id`, or `""` |
| `sentAt` | number | yes | in `by_astronaut_time` | |
| `acknowledgedAt` | number | yes | | `0` until the astronaut acknowledges |
| `response` | `{ templateId, text, at }` \| `null` | yes | (not indexed) | astronaut's reply |
| base fields | | | | |

```json
{ "id": "msg_seed_00001", "astronautId": "a-04", "fromUserId": "u-medofficer",
  "templateId": "rest_and_reassess", "body": "Please prioritise rest tonight and reassess tomorrow.",
  "relatedAlertId": "alr_seed_00004", "sentAt": 1763102520000, "acknowledgedAt": 1763103720000,
  "response": { "templateId": "will_comply", "text": "Understood — resting early tonight.", "at": 1763103720000 },
  "createdAt": 1763102520000, "updatedAt": 1763103720000, "createdBy": "u-medofficer" }
```

### 3.12 `missionEvents` (timeline)

| Field | Type | Required | Key/index | Notes |
| --- | --- | --- | --- | --- |
| `id` | string | yes | **PK** | `evt_…` |
| `timestamp` | number | yes | `by_time`, in `by_astronaut_time`, `by_type_time` | |
| `type` | see list | yes | in `by_type_time` | |
| `astronautId` | string | yes | in `by_astronaut_time` | astronaut id or **`"crew"`** for crew-wide |
| `actorUserId` | string | yes | | who did it, or `"system"` |
| `refStore` | string | yes | | store of the related record, or `""` |
| `refId` | string | yes | | id of the related record, or `""` |
| `summary` | string | yes | | one human-readable line |
| `data` | object | no | (not indexed) | small extra details |
| base fields | | | | |

Types: `measurement_recorded`, `risk_detected`, `alert_generated`,
`alert_escalated`, `alert_acknowledged`, `alert_condition_cleared`,
`alert_resolved`, `message_sent`, `message_acknowledged`,
`astronaut_response`, `checkin_completed`, `cognitive_check_completed`,
`simulation_started`, `simulation_paused`, `simulation_stopped`,
`settings_changed`, `report_generated`, `data_reset`, `data_imported`
(`EVENT_TYPES` in `constants.js`).

> **Privacy:** a `checkin_completed` event for a check-in with
> `sharedWithMedical: 0` must not contain scores in `summary` or `data`. The
> seed follows this rule; services should too.

```json
{ "id": "evt_seed_00120", "timestamp": 1763100120000, "type": "alert_generated",
  "astronautId": "a-04", "actorUserId": "system", "refStore": "alerts", "refId": "alr_seed_00004",
  "summary": "ALT-0190 Reduced sleep duration (warning)", "data": { "severity": "warning", "ruleId": "PHY-05" },
  "createdAt": 1763100120000, "updatedAt": 1763100120000, "createdBy": "system" }
```

### 3.13 `reports`

| Field | Type | Required | Key/index | Notes |
| --- | --- | --- | --- | --- |
| `id` | string | yes | **PK** | `rpt_…` |
| `type` | string | yes | in `by_type_created` | `"crew_summary"`, `"astronaut_health"`… |
| `title` | string | yes | | |
| `generatedBy` | string | yes | | user id |
| `astronautId` | string | yes | `by_astronaut` | astronaut id or `"crew"` |
| `period` | `{ from, to }` | yes | | timestamps |
| `snapshot` | object | yes | | frozen copy of the numbers shown in the report |
| base fields | | | in `by_type_created` (`createdAt`) | |

```json
{ "id": "rpt_51a…", "type": "astronaut_health", "title": "AH-01 weekly health summary",
  "generatedBy": "u-medofficer", "astronautId": "a-01",
  "period": { "from": 1762526400000, "to": 1763131200000 }, "snapshot": { "heartRate": { "avg": 73.1 } },
  "createdAt": 1763131200000, "updatedAt": 1763131200000, "createdBy": "u-medofficer" }
```

No reports are seeded.

### 3.14 `settings`

| Field | Type | Required | Key/index | Notes |
| --- | --- | --- | --- | --- |
| `key` | string | yes | **PK** | see keys below |
| `value` | any | yes | | flags inside use `0`/`1` |
| `updatedAt` | number | yes | | |
| `updatedBy` | string | yes | | user id or `"system"` |

| Key | Seeded value |
| --- | --- |
| `mission` | `{ name: "ODYSSEY-7", startDate: <146 days before today, 00:00 UTC>, missionDayOverride: 0 }` (0 = no override; Mission Day = days since `startDate` + 1 → **147** on seed day) |
| `units` | the canonical unit table (display preferences only) |
| `notifications` | `{ criticalBanner: 1, sound: 0 }` |
| `simulation` | `{ speed: 1 }` |
| `display` | `{ timeFormat: "24h", density: "comfortable" }` |
| `thresholds` | demo thresholds per metric — `{ label: "Demonstration thresholds — not clinically validated", metrics: { heartRate: { warningHigh, criticalHigh, warningLow, criticalLow }, … } }`. A missing bound = no bound. |

Seeded thresholds (demonstration only, **not clinically validated**):

| Metric | warningLow | criticalLow | warningHigh | criticalHigh |
| --- | --- | --- | --- | --- |
| heartRate (bpm) | 50 | 40 | 100 | 120 |
| spo2 (%) | 95 | 92 | — | — |
| bpSystolic (mmHg) | 90 | 80 | 140 | 160 |
| bpDiastolic (mmHg) | 60 | 50 | 90 | 100 |
| sleepDuration (h) | 6.5 | 5 | — | — |
| fatigue (0–10) | — | — | 7 | 9 |

### 3.15 `meta`

| Field | Type | Required | Key/index | Notes |
| --- | --- | --- | --- | --- |
| `key` | string | yes | **PK** | |
| `value` | any | yes | | |

| Key | Meaning |
| --- | --- |
| `schemaVersion` | written by the migration (`1`) |
| `seededAt` | ms when demo data was written (absent = never seeded) |
| `seedVersion` | version of the seed data set (`1`) |
| `alertCounter` | last used alert number (seed leaves it at `190` → next alert is `ALT-0191`) |
| `lastCompactedAt` | ms of the last `compactMeasurements()` run, `0` = never |

---

## 4. Relationships

```
users.astronautId ───────────────► astronauts.id   ("" for medical officers)
measurements.astronautId ────────► astronauts.id
measurements.sampleId ── groups readings taken together (BP sys + dia)
measurements.simulationRunId ────► simulationRuns.id  ("" if none)
dailySummaries ── derived from measurements (same astronautId + metric + UTC day)
wellbeingAssessments / privateJournal / cognitiveChecks .astronautId ─► astronauts.id
simulationRuns.astronautId ──────► astronauts.id ; .operatorId ─► users.id
alerts.astronautId ──────────────► astronauts.id
alerts.triggeringMeasurements[].measurementId ─► measurements.id | wellbeingAssessments.id
alertActions.alertId ────────────► alerts.id
messages.astronautId ────────────► astronauts.id ; .relatedAlertId ─► alerts.id ("")
missionEvents.refStore + refId ──► any record ; .astronautId ─► astronauts.id | "crew"
reports.astronautId ─────────────► astronauts.id | "crew"
*.createdBy / userId / actorUserId / acknowledgedBy … ─► users.id | "system"
```

IndexedDB has no foreign keys. Repositories don't check references, with
**one exception**: `measurementsRepo.add/addMany` must find the astronaut to
update its `latest` cache, so an unknown `astronautId` is rejected.

---

## 5. Repository API

All functions are `async`. "→" is what the Promise resolves to.
`opts` is an optional last argument **`{ tx }`** that lets you run the call
inside your own transaction (section 7). The *Stores* column lists the
stores your transaction must include when you pass `{ tx }`.

### 5.1 `database.js`

| Function | → | Notes |
| --- | --- | --- |
| `openDatabase()` | `IDBDatabase` | cached singleton; runs migrations on first open |
| `closeDatabase()` | `void` | |
| `deleteDatabase()` | `void` | deletes the whole database (tests / factory reset) |
| `withTransaction(storeNames, mode, async (tx, stores) => {…})` | your callback's result | all-or-nothing; `mode` = `"readonly"` \| `"readwrite"`; `stores` = `{ storeName: IDBObjectStore }` |
| `requestPersistentStorage()` | `boolean` | asks the browser not to evict our data |
| `requestToPromise(request)` | request result | helper for raw IDB requests |
| `useDatabaseName(name)` / `getDatabaseName()` | `void` / `string` | **tests only** — use a different database name |

### 5.2 Repositories

| Repository / function | → | Stores (for `{ tx }`) |
| --- | --- | --- |
| **usersRepo** | | |
| `getById(id, opts?)` | `SafeUser \| null` | users |
| `getByUsername(username, opts?)` | `SafeUser \| null` (case-insensitive) | users |
| `getAll(opts?)` | `SafeUser[]` sorted by username | users |
| `add({ username, displayName, role, astronautId?, password })` | `SafeUser` | — (no `tx`: hashing is async) |
| `update(id, changes)` — `changes.password` re-hashes | `SafeUser` | — (no `tx`) |
| `verifyPassword(username, password)` | `SafeUser \| null` | — (no `tx`) |
| **astronautsRepo** | | |
| `getAll(opts?)` | `Astronaut[]` sorted by crewId | astronauts |
| `getById(id, opts?)` | `Astronaut \| null` | astronauts |
| `getByCrewId(crewId, opts?)` | `Astronaut \| null` | astronauts |
| `update(id, changes, opts?)` | `Astronaut` | astronauts |
| `updateLatest(astronautId, metric, value, timestamp, opts?)` | `Astronaut` (unchanged if not newer). Unknown metric / non-finite value → INVALID; unknown astronaut → NOT_FOUND | astronauts |
| **measurementsRepo** | | |
| `add(record, opts?)` | `Measurement` | measurements, astronauts, dailySummaries |
| `addMany(records, opts?)` | `Measurement[]` (one transaction) | measurements, astronauts, dailySummaries |
| `getRange(astronautId, metric, fromTs, toTs, opts?)` | `Measurement[]` oldest→newest, bounds inclusive | measurements |
| `getLatest(astronautId, metric, opts?)` | `Measurement \| null` (any quality) | measurements |
| `getRecent(astronautId, metric, limit = 50, opts?)` | `Measurement[]` — the newest `limit`, returned oldest→newest | measurements |
| `getBySample(sampleId, opts?)` | `Measurement[]` | measurements |
| `countAll(opts?)` | `number` | measurements |
| **dailySummariesRepo** | | |
| `getRange(astronautId, metric, fromDate, toDate, opts?)` | `DailySummary[]` oldest→newest; dates `"YYYY-MM-DD"` inclusive | dailySummaries |
| `upsert(summary, opts?)` | `DailySummary` (id computed) | dailySummaries |
| **wellbeingRepo** | | |
| `add(record, opts?)` | `WellbeingAssessment` | wellbeingAssessments |
| `getRange(astronautId, fromTs, toTs, opts?)` | `WellbeingAssessment[]` oldest→newest | wellbeingAssessments |
| `getLatest(astronautId, opts?)` | `WellbeingAssessment \| null` | wellbeingAssessments |
| `getSharedRange(fromTs, toTs, opts?)` | all astronauts' **shared** check-ins, oldest→newest | wellbeingAssessments |
| **journalRepo** | | |
| `add(record, opts?)` | `JournalEntry` | privateJournal |
| `getByAstronaut(astronautId, opts?)` | `JournalEntry[]` newest→oldest | privateJournal |
| **cognitiveRepo** | | |
| `add(record, opts?)` | `CognitiveCheck` | cognitiveChecks |
| `getRange(astronautId, fromTs, toTs, opts?)` | `CognitiveCheck[]` oldest→newest | cognitiveChecks |
| **simulationRunsRepo** | | |
| `add(record, opts?)` | `SimulationRun` | simulationRuns |
| `update(id, changes, opts?)` | `SimulationRun` | simulationRuns |
| `getById(id, opts?)` | `SimulationRun \| null` | simulationRuns |
| `getActive(opts?)` | `SimulationRun[]` (running or paused) newest→oldest | simulationRuns |
| `getByAstronaut(astronautId, opts?)` | `SimulationRun[]` newest→oldest | simulationRuns |
| **alertsRepo** | | |
| `add(record, opts?)` | `Alert` with new `number` | alerts, meta |
| `update(id, changes, opts?)` | `Alert` | alerts |
| `getById(id, opts?)` | `Alert \| null` | alerts |
| `getOpenByDedupeKey(dedupeKey, opts?)` | open `Alert \| null` (status new or acknowledged) | alerts |
| `query({ astronautId?, status?, severity?, fromTs?, toTs?, limit? }, opts?)` | `Alert[]` newest `detectedAt` first. `status` / `severity` may be a string or an array | alerts |
| `countOpen({ astronautId? } = {}, opts?)` | `number` (new + acknowledged) | alerts |
| **alertActionsRepo** | | |
| `add(record, opts?)` | `AlertAction` | alertActions |
| `getByAlert(alertId, opts?)` | `AlertAction[]` oldest→newest (lifecycle order) | alertActions |
| **messagesRepo** | | |
| `add(record, opts?)` | `Message` | messages |
| `update(id, changes, opts?)` | `Message` | messages |
| `getById(id, opts?)` | `Message \| null` | messages |
| `getByAstronaut(astronautId, opts?)` | `Message[]` newest→oldest | messages |
| `getByAlert(alertId, opts?)` | `Message[]` newest→oldest | messages |
| `getUnacknowledged(astronautId, opts?)` | `Message[]` with `acknowledgedAt === 0`, newest→oldest | messages |
| **eventsRepo** (store `missionEvents`) | | |
| `add(record, opts?)` | `MissionEvent` | missionEvents |
| `addMany(records, opts?)` | `MissionEvent[]` | missionEvents |
| `getRange({ astronautId?, fromTs?, toTs?, types?, limit? } = {}, opts?)` | `MissionEvent[]` newest→oldest. `astronautId` / `types` may be a string or array; include `"crew"` to get crew-wide events | missionEvents |
| **reportsRepo** | | |
| `add(record, opts?)` | `Report` | reports |
| `getById(id, opts?)` | `Report \| null` | reports |
| `getAll({ type?, astronautId? } = {}, opts?)` | `Report[]` newest→oldest | reports |
| **settingsRepo** | | |
| `get(key, opts?)` | the **value**, or `null` | settings |
| `set(key, value, userId = "system", opts?)` | `{ key, value, updatedAt, updatedBy }` | settings |
| `getAll(opts?)` | `{ [key]: value }` | settings |
| **metaRepo** | | |
| `get(key, opts?)` | value or `null` | meta |
| `set(key, value, opts?)` | `value` | meta |

### 5.3 `seed.js`, `backup.js`, `maintenance.js`, `ids.js`

| Function | → | Notes |
| --- | --- | --- |
| `seedDemoData({ now? } = {})` | `{ seeded: boolean, counts? }` | idempotent — does nothing if `meta.seedVersion` exists |
| `exportAll()` | `BackupFile` (section 11) | one read-only transaction |
| `importAll(json, { userId? } = {})` | `{ counts }` | `json` = object or JSON string. Validated first; then replaces **all** data in one transaction, logs `data_imported` |
| `validateBackup(json)` | `{ file, stores }` | checks a backup without touching the database (e.g. before asking the user to confirm an import); throws `INCOMPATIBLE_BACKUP` |
| `resetDatabase({ userId? } = {})` | `{ counts }` | clears everything and re-seeds in one transaction, logs `data_reset` |
| `compactMeasurements({ keepRawDays = 7, now? } = {})` | `{ daysCompacted, readingsDeleted, summariesWritten }` | section 9 |
| `getStorageInfo()` | `{ usage, quota, persisted }` | bytes; `null` when the browser can't tell |
| `newId(prefix)` | string | `"msr_<uuid>"` |
| `nextAlertNumber(metaStore)` | `"ALT-0191"` | must be called inside a readwrite transaction that includes `meta` (`alertsRepo.add` does this for you) |
| `formatAlertNumber(n)` / `parseAlertNumber(s)` | string / number | `193 ↔ "ALT-0193"` |

`index.js` also re-exports everything in `constants.js` (`ROLES`, `METRICS`,
`METRIC_UNITS`, `EVENT_TYPES`, `SEVERITIES`, `ALERT_STATUSES`, …),
`SCHEMA`, `STORE_NAMES`, `MIGRATIONS`, `MEASUREMENT_WRITE_STORES`,
`SEED_VERSION`, `DEMO_PASSWORD`, `BACKUP_APP_NAME`, `DatabaseError`, and the
date/summary helpers (`toDateKey`, `dateKeyToStart`, `startOfUtcDay`,
`summarize`). The complete list (68 names) is section 16.

---

## 6. Errors

Every failure is a **`DatabaseError`** (`import { DatabaseError } from "../db/index.js"`):

```js
try { await alertsRepo.update(id, { status: "acknowledged" }); }
catch (err) {
  if (err instanceof DatabaseError && err.code === "NOT_FOUND") { /* … */ }
  console.error(err.message, err.cause); // cause = the original browser error
}
```

| `code` | When |
| --- | --- |
| `UNSUPPORTED` | no IndexedDB (very old browser, some private modes) |
| `OPEN_FAILED` | the database could not be opened |
| `VERSION` | the device has a **newer** database than this app (reload / update the app) |
| *(no `BLOCKED` error)* | a blocked upgrade is **not** thrown: `openDatabase()` keeps waiting and the `db:blocked` event is emitted (see below). It continues automatically once the other tab closes or reloads |
| `INVALID_STATE` | the connection was closed or is busy (e.g. storage cleared while open) |
| `ABORTED` | the browser aborted a transaction for its own reasons; nothing was saved |
| `NOT_FOUND` | `update()` on a missing record; unknown astronaut for a measurement |
| `INVALID` | a record breaks a storage rule (section 2: indexed field, enum value, unit, user role link, immutable id, unstorable value), or a `{ tx }` call lacks a store / writes in a readonly transaction |
| `CONSTRAINT` | unique index clash (duplicate `username`, `crewId`, alert `number`, or `id`) |
| `QUOTA` | device storage full |
| `TRANSACTION_INACTIVE` | you `await`ed something that is not a database request inside `withTransaction` |
| `TRANSACTION_FAILED` | your `withTransaction` callback threw — everything was rolled back; see `err.cause` |
| `INCOMPATIBLE_BACKUP` | `importAll`/`validateBackup`: wrong app or schema version, bad shape, unknown store, a record breaking a storage rule, duplicate keys or unique values |
| `UNKNOWN` | anything else (see `err.cause`) |

Properties: `name: "DatabaseError"`, `code`, `message`, `cause`, `store`,
`operation`.

The database layer also emits two **infrastructure** events on the event bus
(local tab only): `db:blocked` (an upgrade waits for other tabs) and
`db:versionchange` (another tab upgraded the database. This tab closed its
connection, so **ask the user to reload**).

---

## 7. Transactions

Each repository call runs in its **own** transaction unless you pass
`{ tx }`. To make several writes **all-or-nothing**, wrap them:

```js
import { withTransaction, alertsRepo, alertActionsRepo, eventsRepo } from "../db/index.js";

await withTransaction(["alerts", "alertActions", "missionEvents"], "readwrite", async (tx) => {
  const alert = await alertsRepo.update(id, { status: "acknowledged", acknowledgedAt: now, acknowledgedBy: userId }, { tx });
  await alertActionsRepo.add({ alertId: id, action: "acknowledged", userId, timestamp: now }, { tx });
  await eventsRepo.add({ type: "alert_acknowledged", astronautId: alert.astronautId, actorUserId: userId,
                         refStore: "alerts", refId: id, summary: `${alert.number} acknowledged` }, { tx });
});
// If anything inside throws, NOTHING is saved.
```

**Rules (important!)**

1. Inside `withTransaction`, only `await` **database calls** (repository
   calls with `{ tx }` or `requestToPromise`). Awaiting anything else —
   `fetch`, `setTimeout`, `crypto.subtle`, a user prompt — lets the
   browser auto-commit the transaction. Your next call then fails with
   `TRANSACTION_INACTIVE`. Do that work **before** starting the transaction.
2. List **every store** the calls need (see the *Stores* column in section 5).
   `alertsRepo.add` needs `"meta"` (alert counter).
   `measurementsRepo.add` needs `"astronauts"` and `"dailySummaries"`. The
   exported constant `MEASUREMENT_WRITE_STORES` lists them for you:
   `withTransaction([...MEASUREMENT_WRITE_STORES, "missionEvents"], "readwrite", …)`.
3. `usersRepo.add/update/verifyPassword` don't accept `{ tx }` (password
   hashing is async).
4. Keep transactions short. Never keep one open while waiting for the user.
5. Writes to the same store are queued by the browser, so two tabs adding
   alerts at once still get unique numbers.

---

## 8. Schema versions & migrations

- `schema.js` defines `MIGRATIONS = { 1: (db, tx) => { … } }`.
  `openDatabase()` runs every step from the stored version + 1 up to
  `DB_VERSION`, inside the upgrade transaction.
- **Never edit a past migration** — devices that already ran it won't run it
  again. Any change (new store, new index, renamed field) = bump
  `DB_VERSION` in `js/core/config.js` (core file: run the full test suite) and add
  `MIGRATIONS[2]`, which transforms existing data. Also bump the backup
  `schemaVersion` handling in `backup.js` and update this document.
- Another tab running an older version is closed automatically
  (`db:versionchange`); if it can't, `db:blocked` is emitted.

---

## 9. Retention policy

| Data | Kept |
| --- | --- |
| Raw `measurements` | **7 days** (`keepRawDays`), then compacted into `dailySummaries` and deleted |
| `dailySummaries` | whole mission (never deleted) |
| alerts, alertActions, messages, wellbeing, journal, cognitive checks, simulation runs, reports, missionEvents, settings | whole mission (small) |

`compactMeasurements({ keepRawDays = 7 })` takes every **whole UTC day**
older than `today − keepRawDays`. For **each day, in one transaction**, it
recomputes that day's summaries **exactly from the raw readings**, saves them,
and deletes the raw readings. A crash can't lose a day. It then sets
`meta.lastCompactedAt`. Suggested use (services): call it once per app start
when `lastCompactedAt` is older than a day.

Simulation tip: logging a `measurement_recorded` event for *every* simulated
reading will grow `missionEvents` quickly; prefer one event per sample batch.

---

## 10. Seed data (`seedDemoData()`)

Deterministic: random numbers come from `mulberry32(147)`, so the **values are
identical every time**. Timestamps are **relative to the moment of seeding**,
so the data always ends "now". Password salts are random (security), so
hashes differ between seeds.

Idempotent: if `meta.seedVersion` exists, nothing is written. Everything is
written in **one** `withTransaction`.

| What | Details |
| --- | --- |
| Astronauts | `a-01` AH-01 Sami Haddad, Commander, 41 · `a-02` AH-02 Aisha Karim, Flight Engineer, 36 · `a-03` AH-03 Mei Chen, Mission Specialist, 33 · `a-04` AH-04 Jonas Reyes, Payload Specialist, 38 — each with a baseline and a filled `latest` cache |
| Users (password **`demo`** for all) | `medofficer` (medical_officer, "Dr. Lena Ortiz") · `medbackup` (medical_officer, backup demo account) · `haddad` → a-01 · `karim` → a-02 · `chen` → a-03 · `reyes` → a-04 |
| Raw vitals, last **7 days**, every **2 h** | heartRate, spo2, bpSystolic + bpDiastolic (shared `sampleId`), activity (cumulative steps), fatigue — day/night rhythm on UTC clock (asleep 22:00–06:00) |
| Sleep | one `sleepDuration` per day at 06:00 UTC for **30 days** |
| Suspect readings | a-03 SpO₂ **72 %** (3 days ago) and a-04 HR **178 bpm** (5 days ago), `quality: "suspect"` |
| Daily summaries | **30 days** for every metric (older days come from readings that were "already compacted") |
| Wellbeing | daily check-ins at 08:00 UTC for 30 days. **a-03**: mood gradually falls, stress rises (low mood on 3 of the last 4). **a-04**: low sleep quality and higher fatigue for the last 3 days. a-01 did not share 3 check-ins (`sharedWithMedical: 0`) |
| Journal | 3 private entries (a-01 ×1, a-03 ×2) |
| Cognitive checks | 2 per astronaut (a-03 and a-04 slower recently) |
| Alerts | **ALT-0181** a-01 elevated BP (PHY-03), *resolved* · **ALT-0184** a-02 elevated heart rate (PHY-01), *resolved* · **ALT-0189** a-03 supportive check-in recommended (WB-01, info), *new* · **ALT-0190** a-04 reduced sleep (PHY-05, warning), *acknowledged*. `meta.alertCounter = 190` |
| Alert actions | full history: created → acknowledged → condition_cleared → resolved (resolved alerts), created → acknowledged (ALT-0190), created (ALT-0189) |
| Messages | to a-04 "rest and reassess" about ALT-0190 — acknowledged with a response · to a-01 "check vital signs" — not yet acknowledged |
| Mission events | one per seeded record/action (vitals batched per astronaut per day; check-ins without scores when not shared) |
| Settings | mission ODYSSEY-7 (today = **Mission Day 147**), units, notifications, simulation, display, demo thresholds |

Alert numbers match the design mock-ups (earlier numbers are assumed
archived). Triggering measurements of seeded alerts point to real seeded
records.

Record counts after seeding (identical every time):

| Store | Records | Store | Records |
| --- | --- | --- | --- |
| users | 6 | alerts | 4 |
| astronauts | 4 | alertActions | 11 |
| measurements | 2,136 | messages | 2 |
| dailySummaries | 864 | missionEvents | 299 |
| wellbeingAssessments | 120 | reports | 0 |
| privateJournal | 3 | settings | 6 |
| cognitiveChecks | 8 | meta | 5 |
| simulationRuns | 0 | | |

---

## 11. Backup format

`exportAll()` returns (and `importAll()` accepts) **one JSON object**:

```json
{
  "app": "AstroHealth AI",
  "schemaVersion": 1,
  "exportedAt": 1763131200000,
  "stores": {
    "users": [ … ], "astronauts": [ … ], "measurements": [ … ], "dailySummaries": [ … ],
    "wellbeingAssessments": [ … ], "privateJournal": [ … ], "cognitiveChecks": [ … ],
    "simulationRuns": [ … ], "alerts": [ … ], "alertActions": [ … ], "messages": [ … ],
    "missionEvents": [ … ], "reports": [ … ], "settings": [ … ], "meta": [ … ]
  }
}
```

- It contains **everything**, including `passwordHash`/`salt` and the
  **private journal**. It's demo data, but treat backup files as private.
- `importAll` rejects (`INCOMPATIBLE_BACKUP`) **before deleting anything**
  when `app` isn't `"AstroHealth AI"`, `schemaVersion` isn't the current one,
  `stores` is missing, a store name is unknown, a store isn't an array, a
  record isn't an object, **any record breaks a storage rule** (missing or
  boolean/null/NaN indexed field, undocumented enum value, wrong user role
  link — section 2), or a store contains **duplicate primary keys** or
  **duplicate values in a unique index** (`username`, `crewId`, alert
  `number`). A missing store is imported as empty.
- Import **replaces all data** in one transaction (all or nothing), then adds
  a `data_imported` event. So after a round trip `missionEvents` has
  exactly one more record.
- Saving to / loading from a file is UI work (app pages): `JSON.stringify(await exportAll())`.

---

## 12. Privacy & security notes

- Demo authentication only (PBKDF2 in the browser). Not real security.
- `privateJournal` is a separate store and never appears in events. Services
  must only show it to its owner.
- `sharedWithMedical` defaults to `0`. Medical-officer views should use
  `wellbeingRepo.getSharedRange()`.
- No encryption at rest (out of scope). All data is synthetic.

---

## 13. Mock repositories

`js/db/mock-repositories.js` exports the **same repository objects with the
same function names and parameters**, backed by in-memory `Map`s and
pre-loaded with the same seed data. It also exports `withTransaction` (it
snapshots the data and restores it if your callback throws) and
`resetMock({ seed = true, now })`. It uses the same default-value and
index-check code (`records.js`) as the real repositories, so mistakes like
boolean flags fail the same way. Differences: data is lost on reload, and
there's no cross-tab sharing.

---

## 14. Testing

- `npm run test:unit` — Node tests (`node --test "tests/unit/*.test.mjs"`):
  schema + migrations (fake IndexedDB), constants, storage rules, index
  checks, password hashing, safe users, deterministic random data, seed data,
  summaries, IDs, backup validation, mock repositories, mock ↔ real API
  parity, and an **encapsulation guard** (no app file may import a `js/db`
  file other than `index.js`, touch IndexedDB, or handle password material).
- `tests/browser/db-tests.html` — open via `npm run serve`. Runs the real
  IndexedDB layer against a separate database `astrohealth-test` (switched
  before any test runs; the page refuses to run otherwise) and shows
  PASS/FAIL. The real `astrohealth` database is never opened. The test
  database is deleted at the end.

---

## 15. Integration decisions

1. The canonical role name is `"medical_officer"` everywhere. Application
   code should use `ROLES.MEDICAL_OFFICER` instead of repeating the string.
2. Every astronaut has exactly one demo login. The sixth account,
   `medbackup`, is a backup Medical Officer demo account and has no astronaut
   profile.
3. The services own the scenario and message-template lists. Current seed IDs are
   `rest_and_reassess`, `check_vital_signs`, and `will_comply`; centralize the
   final lists before building the Simulation Center and messaging UI.
4. `invalid` readings are ignored. `suspect` readings remain visible for data
   quality review but must not create a critical alert by themselves; the risk
   service requires a corroborating valid reading or its configured
   consecutive-reading rule.

---

## 16. Database API frozen for Sprint 2 integration

This section is the stable contract that services and dashboards are built
on. Changing anything here needs a change (PR recommended) that updates this
file, the tests and the mock together. A second reviewer is optional (solo
project).

### Database

- Name **`astrohealth`**, schema version **1** (`DB_NAME`, `DB_VERSION` in
  `js/core/config.js`). No schema change was needed for Sprint 2.
- **15 stores:** `users`, `astronauts`, `measurements`, `dailySummaries`,
  `wellbeingAssessments`, `privateJournal`, `cognitiveChecks`,
  `simulationRuns`, `alerts`, `alertActions`, `messages`, `missionEvents`,
  `reports`, `settings`, `meta`.
- Unique indexes: `users.username`, `astronauts.crewId`, `alerts.by_number`.

### Import path — the ONLY one

```js
import { usersRepo, alertsRepo, withTransaction, ROLES, DatabaseError } from "../db/index.js";
```

Pages and services must **not** import any other `js/db/` file, use
`indexedDB` / `IDBObjectStore` / `IDBKeyRange`, re-implement storage
validation, or verify passwords themselves. `tests/unit/db-api.test.mjs`
fails the build if app code breaks this. (Tests may also import
`js/db/mock-repositories.js`.)

Public exports (68): `openDatabase`, `closeDatabase`, `deleteDatabase`,
`withTransaction`, `requestToPromise`, `requestPersistentStorage`,
`useDatabaseName` / `getDatabaseName` (tests only), `DatabaseError`,
`newId`, `nextAlertNumber`, `formatAlertNumber`, `parseAlertNumber`,
`toDateKey`, `dateKeyToStart`, `startOfUtcDay`, `summarize`, the 15
repositories (`usersRepo`, `astronautsRepo`, `measurementsRepo`,
`dailySummariesRepo`, `wellbeingRepo`, `journalRepo`, `cognitiveRepo`,
`simulationRunsRepo`, `alertsRepo`, `alertActionsRepo`, `messagesRepo`,
`eventsRepo`, `reportsRepo`, `settingsRepo`, `metaRepo`), `seedDemoData`,
`exportAll`, `importAll`, `resetDatabase`, `validateBackup`,
`compactMeasurements`, `getStorageInfo`, and the constants `SCHEMA`,
`STORE_NAMES`, `MIGRATIONS`, `MEASUREMENT_WRITE_STORES`, `SEED_VERSION`,
`DEMO_PASSWORD`, `BACKUP_APP_NAME`, `ROLES`, `SYSTEM_USER`, `CREW`,
`METRICS`, `METRIC_UNITS`, `WELLBEING_SCALES`, `SOURCES`, `QUALITIES`,
`SEVERITIES`, `ALERT_STATUSES`, `OPEN_ALERT_STATUSES`, `ALERT_CATEGORIES`,
`ALERT_ACTIONS`, `SIMULATION_STATUSES`, `ACTIVE_SIMULATION_STATUSES`,
`EVENT_TYPES`, `SETTINGS_KEYS`, `META_KEYS`, `FLAG_FIELDS`, `MINUTE_MS`,
`HOUR_MS`, `DAY_MS`. Signatures: section 5.

### Canonical roles

`ROLES.ASTRONAUT = "astronaut"`, `ROLES.MEDICAL_OFFICER = "medical_officer"`.
The hyphenated form `medical-officer` is invalid everywhere (rejected by the
users store, by sessions and by backup import).

### Who owns what

| Database layer (`js/db/`) | Services (`js/services/`) |
| --- | --- |
| persistence, schema, migrations | permissions and role checks |
| storage validation (section 2) | business validation (ranges, required answers…) |
| repository queries | risk rules and alert decisions (create / escalate / resolve) |
| atomic transactions (`withTransaction`, `{ tx }`) | lifecycle transactions (alert + action + event together) |
| deterministic seed data | timeline policy (which events to log, and their wording) |
| backup / restore / reset | privacy policy (who may see what) |
| maintenance (compaction, storage info) | application events and user-facing messages |

Repositories never check who is calling. **Every service must enforce
permissions itself.**

### Transaction rules

1. Several writes that belong together → one `withTransaction([...stores],
   "readwrite", async (tx) => { … { tx } … })`. If anything throws, nothing
   is saved (proven in the browser suite for alerts + alertActions +
   missionEvents with a failing final write).
2. Inside the callback, only `await` database calls. Anything else ends the
   transaction (`TRANSACTION_INACTIVE`).
3. List every store the calls need (section 5 "Stores" column). A missing
   store fails with `INVALID` naming the store.
4. `usersRepo.add / update / verifyPassword` can't join a transaction.

### Privacy boundaries (data level — services must enforce them)

- `privateJournal`: only `journalRepo.add` and
  `journalRepo.getByAstronaut(astronautId)` exist — no crew-wide query.
  Services must only call it for the signed-in astronaut's own
  `astronautId`. Never shown to a medical officer; never written to
  `missionEvents`.
- Wellbeing: medical-officer views must use
  `wellbeingRepo.getSharedRange()` (only `sharedWithMedical: 1`). Events
  about unshared check-ins must not contain scores.
- An astronaut sees only records with their own `astronautId` (services
  filter; the repository does not know who is asking).
- Backups contain everything (hashes, salts, journals) — treat as private.

### Safe user shape (what `usersRepo` returns)

```js
{ id, username, displayName, role, astronautId, createdAt, updatedAt, createdBy }
```

Never `password`, `passwordHash` or `salt`. Login stores only `userId`,
`username`, `displayName`, `role`, `astronautId` (+ session timestamps) in
`localStorage["astrohealth.session"]`.

### Seed accounts (password `demo`)

| Username | Role | astronautId |
| --- | --- | --- |
| `haddad` | astronaut | `a-01` |
| `karim` | astronaut | `a-02` |
| `chen` | astronaut | `a-03` |
| `reyes` | astronaut | `a-04` |
| `medofficer` | medical_officer | `""` |
| `medbackup` | medical_officer | `""` |

Exactly one login per astronaut profile.

### Synthetic data and the SIMULATED label

There is no per-record "synthetic" flag: **all data in this prototype is
synthetic.** Where it comes from is stored in `source` on measurements and
wellbeing check-ins (`"seed"` = demo history, `"simulation"` = Simulation
Center, `"manual"` = entered in the app). The app (services and pages) must:

1. Show the `.sim-tag` "SIMULATED" label on every vital-sign / wellbeing
   value or chart whose data has `source: "seed"` or `"simulation"`, and on
   alerts, messages and reports derived from such data.
2. Keep the footer disclaimer ("All health data synthetic") on every page.
3. Label thresholds from `settings.thresholds` as demonstration values, not
   clinically validated.

Risk detection is rule-based and lives in the services, not here. No
data here is real NASA or crew health data.

### Migration rule

Never edit `MIGRATIONS[1]`. A schema change = bump `DB_VERSION`, add
`MIGRATIONS[n]`, update `SCHEMA`, backup compatibility (`backup-format.js`),
this file and the tests.

### Known limitations

- **Seed upgrades:** `seedDemoData()` does nothing when *any* seed exists.
  A browser seeded before the demo accounts changed (e.g. one that still
  has an `astronaut` user and no `medbackup`) keeps its old data. Fix it
  with `resetDatabase()` or by clearing site data.
- **Blocked upgrades** are reported only through the `db:blocked` event.
  The browser suite couldn't trigger a blocked upgrade at schema version 1,
  so that path is untested.
- **Service worker cache:** `CACHE_VERSION` in `sw.js` must be bumped when
  releasing changed files. Otherwise returning browsers keep the cached copy.
- No encryption at rest; demo authentication only; data stays on the device.
