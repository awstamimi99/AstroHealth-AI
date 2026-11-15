# AstroHealth AI — Architecture

AstroHealth AI is an **online-capable** web app with **optional offline
support**. The frontend is static HTML/CSS/vanilla JavaScript, any static file
server runs it (`python3 -m http.server 8080`), and IndexedDB in the browser is
the application's primary data store. Specific features *may* call an approved
API (for example a small Python/FastAPI service) when there is a real need;
see [API policy](#api-policy), [Python policy](#python-policy) and
[Offline policy](#offline-policy) below.

There is **no Python backend and no Python dependency yet**. Today every
feature runs in the browser.

> Research & educational prototype · Not a medical device · Not affiliated
> with or endorsed by NASA · All health data synthetic.

## Layers

```
┌────────────────────────────────────────────────────────────────────┐
│ UI  — HTML pages + js/pages/* + js/components/* + css/*            │
│       (index/about = public site, login/app = authenticated app)   │
└──────────────┬──────────────────────────────▲──────────────────────┘
               │ calls                        │ events (js/core/event-bus.js)
┌──────────────▼──────────────────────────────┴──────────────────────┐
│ Services — js/services/*   (business logic used by pages)           │
│   ├─ Risk engine   js/engine/  + js/engine/rules/*                  │
│   │    pure functions: measurements in → risk levels / alerts out   │
│   └─ Simulation    js/simulation/  synthetic crew data generator    │
└──────────────┬─────────────────────────────────────────────────────┘
               │ read / write
┌──────────────▼─────────────────────────────────────────────────────┐
│ Data — js/db/  (IndexedDB) + js/db/repositories/*                   │
│        one repository per store; pages never touch IndexedDB direct │
└────────────────────────────────────────────────────────────────────┘

 Service worker (sw.js) — precaches every runtime file; cache-first.
 Auth (js/auth/) — local session in localStorage["astrohealth.session"].

 Optional, not built yet:
 Services ──HTTPS (localhost in dev)──► approved API, e.g. Python/FastAPI
   for one specific job (analysis, risk engine, simulation, reports,
   data integration). Pages never call it directly; IndexedDB stays primary.
```

All layers are maintained by the project owner (solo project). Rows marked
**core** are used by every page: change them with extra care and run the full
test suite.

| Layer | Folder | Core? | Notes |
| --- | --- | --- | --- |
| Pages / UI | `*.html`, `js/pages/`, `css/pages/` | | Build DOM with `el()` — never `innerHTML` with data |
| Shared components | `js/components/`, `css/components.css` | core | Showcased in `tests/browser/styleguide.html` |
| Core | `js/core/` | core | config, event bus, environment check, utils, `preferences.js` (Sprint 9: browser-only personal display preferences) |
| Services | `js/services/` | | The only layer pages call for data. Current: `mission-service.js` (mission name/day), `astronaut-overview-service.js` (read-only astronaut Overview: own data only, status from open alerts only, never a health assessment), `crew-monitor-service.js` (read-only Medical Officer crew snapshot and crew-member detail: verified officer only, shared wellbeing only, no journal or mission events, ranked by open alerts), `access-control.js` (Sprint 6 identity checks: verified astronaut / Medical Officer, strict crew-ID resolution), `physical-health-service.js` (read-only physical readings, 7/30-day daily-summary trends, numeric baseline differences, open physical alerts), `wellbeing-service.js` (own check-ins; shared-only officer view; the check-in write: validated, explicitly shared or private, saved atomically with a score-free `checkin_completed` event), `simulation-service.js` (Sprint 7 Simulation Center: verified Medical Officer only; start / advance / pause / resume / stop of one synthetic run at a time; no risk evaluation, no alerts — see [Simulation Center](#simulation-center-sprint-7)), `risk-service.js` (Sprint 8: evaluates the demonstration risk rules for a crew member — Medical Officer only, after a committed simulation step or an explicit "Evaluate crew now"; one atomic transaction per astronaut), `alerts-service.js` (Sprint 8: role-scoped alert list, detail by public alert number, acknowledge / resolve — see [Risk Engine and Alerts](#risk-engine-and-alerts-sprint-8)), `history-service.js`, `reports-service.js`, `settings-service.js` (Sprint 9: read-only history timeline, dynamic printable reports, read-only settings — see [Health History, Reports and Settings](#health-history-reports-and-settings-sprint-9)) |
| Risk engine | `js/engine/`, `js/engine/rules/` | | Deterministic, explainable rules; unit-testable. Pure: imports only other `js/engine/` files (a unit test enforces this). Sprint 8: `rules/physical-rules.js` (catalog) and `risk-engine.js` (evaluate + plan) |
| Simulation | `js/simulation/` | | Generates **synthetic** data; tag UI with `.sim-tag`. `scenarios.js` is the pure, import-free scenario catalog (Sprint 7) |
| Database | `js/db/`, `js/db/repositories/` | contract | IndexedDB wrapper + storage-only repositories; contract in `docs/DATA-MODEL.md` |
| Offline (optional support) | `sw.js`, `js/sw-register.js` | core | Precache list generated by `npm run build:sw` |
| API client | `js/core/api.js` | core | `postJson()` — HTTPS or localhost only, timeout, `ApiError` |
| Python API (future) | not created yet | | Only when a feature needs it — see [Python policy](#python-policy) |

### Event bus

`js/core/event-bus.js` is a tiny pub/sub (`on`, `once`, `off`, `emit`). Every
event is mirrored to other open tabs via `BroadcastChannel("astrohealth")`, so
e.g. a new alert appears in all tabs. Suggested event names use
`noun:verb` — `measurement:added`, `alert:new`, `alert:acknowledged`,
`simulation:started`, `session:changed`, `sw:status`.

### 3D body (three.js)

`js/components/body-3d.js` draws a rotatable 3D body with alert pins, used by
the vitals stage (astronaut Overview, Crew Monitor detail) and every context
body map (Physical, Wellbeing, History, Alerts, Reports). three.js 0.170.0
(MIT) is a pinned dev dependency, copied to `vendor/three/` by
`scripts/copy-vendor.mjs` and loaded on demand with a relative
`import()` — no CDN. The 2D body (`body-scan.js`) is shown first and stays
when WebGL or the import is unavailable. Pins are real buttons that follow
their zone; resolved alerts are never pinned. The figure is an original,
stylised illustration and carries no health meaning. `check:offline`
allows exactly the XHTML namespace string used inside three.js (an XML
identifier, never fetched).

### Service worker

- Cache name `astrohealth-v<version>`; old caches are deleted on activate.
- Precaches `js/core/precache-manifest.js` (generated — walks the repo and
  skips `node_modules`, `scripts`, `tests`, `docs`, `.git`).
- Cache-first for same-origin `GET`. Cross-origin requests (including any
  approved external API) are not intercepted or cached by the worker.
- If a **same-origin** API path is ever added (e.g. `/api/…` served by
  FastAPI), `sw.js` must bypass it before that feature ships: API responses
  must never be served from the cache-first precache.
- When you ship changes: bump `CACHE_VERSION` in `sw.js` and `APP_VERSION` in
  `js/core/config.js`, then run `npm run build:sw`.

## Architecture direction

These rules replace the earlier "strictly offline-first, no remote API" rule.

1. **Frontend stays as it is**: HTML5, CSS3, vanilla JavaScript ES modules.
   No framework, bundler or TypeScript, and the UI is never rewritten in
   Python.
2. **IndexedDB stays the primary store.** The database API in `js/db/`
   (frozen contract in `docs/DATA-MODEL.md`) is not replaced, moved to a
   server, or broken. Pages import data only through `js/services/`, and
   services import only `js/db/index.js`.
3. **Online-capable, offline optional.** The app may use approved APIs. The
   service worker and offline support stay as a feature, but offline is no
   longer a requirement for every feature.
4. **Python is allowed when justified**, as a small API for specific jobs,
   preferably FastAPI. Not before a real feature needs it.
5. **Safety rules are unchanged** (see the next section).

### Safety rules (always mandatory)

- Research & educational prototype · Not a medical device · Not affiliated
  with or endorsed by NASA. The footer disclaimer stays on every page.
- **All astronaut health, medical, mission, and simulation records are
  synthetic.** Real astronaut health or medical records are never permitted.
- **Verified public NASA resources and research references may be real**, and
  must be clearly attributed (title, authors or publisher, year, link). Real
  references never imply NASA affiliation or endorsement.
- Never fabricate citations (see `data/references.json` rules below).
- Canonical roles are exactly `astronaut` and `medical_officer`
  ("Medical Officer" is a display label only).
- Risk detection stays **explainable**: every alert says which rule fired,
  with which values and thresholds. A Python service may compute it, but must
  return that explanation too.
- Never claim clinical validity or machine-learning capabilities.

## API policy

Calling an API is allowed only under these rules ("controlled API policy").

**What may be called**

- Only an **approved** endpoint: a local development API, or a trusted
  external API that the project owner has approved and listed in one place (see
  [check:offline scope](#checkoffline-scope)). No ad-hoc URLs inside pages.
- **HTTPS in production.** `http://` is accepted only for `localhost`,
  `127.0.0.1` or `::1` during development. `js/core/api.js` already enforces
  this.
- No analytics, tracking, advertising or remote fonts/CDN assets. Scripts,
  styles, fonts, icons and images stay inside the repo (`vendor/`, `assets/`).

**Who calls it**

- Only services (`js/services/`) make API calls, always through the shared
  client `js/core/api.js`. **Pages never call APIs or database repositories
  directly**; they call services. The API is never a second database:
  IndexedDB remains the source of truth for app data.

**What may be sent**

- The minimum data the job needs. Never send passwords, password hashes,
  salts, the session object, or private journal text. Medical Officer views
  keep the same privacy rules as local data (no private journals, no unshared
  check-ins).
- No secrets or API keys in frontend code. Anything shipped to the browser is
  public.

**How the UI behaves** (required for every online feature)

- A clear **loading** state while waiting.
- A **timeout** (`postJson()` defaults to 15 s) and a cancellable request.
- An **offline** state: say the feature needs a connection instead of
  breaking.
- An **understandable error message** on failure, timeout or offline.
- **No fabricated data** on failure: no cached guesses or placeholder numbers
  shown as real results.
- Validate responses before use; build DOM with `el()`/`textContent`, never
  `innerHTML`.
- Results that are synthetic or simulated stay labelled as such.

## Python policy

- **When**: only when a concrete feature needs it. Good candidates are
  analysis, the risk engine, simulation, report generation, or data
  integration. No Python service, folder or dependency is added before then.
- **How**: a small, stateless API, preferably **FastAPI**. It receives an
  explicit payload from a service, returns a result, and does not become the
  app's data store. Health data is not persisted on the server at this stage.
- **Dependencies**: added only with the feature that needs them, pinned in
  that service's own requirements file, and listed in `docs/LICENSES.md`.
- **Rules carried over**: deterministic and explainable risk logic, synthetic
  data, canonical roles, no clinical-validity or machine-learning claims,
  unit tests (pytest) for any Python logic.
- **Development**: run it on `localhost` beside the static server. Features
  that don't need it must keep working when it isn't running.
- **Review**: the first Python API PR must document its endpoints, payloads
  and errors here, include a security review against the
  [API policy](#api-policy), and add tests. A second reviewer is optional
  (solo project).

## Offline policy

- The **service worker stays**. It precaches the static frontend so that
  login, the app shell and IndexedDB-backed views can keep working offline.
  Don't remove that without a documented project decision.
- Offline support is an **optional feature**, not a requirement for every
  new feature. Features that work only on local data should still work
  offline where practical.
- A feature that needs the network must say so when offline (for example,
  "This needs an internet connection"). It must not break the rest of the app
  and must not show invented results.
- After adding, renaming or deleting runtime files, run `npm run build:sw`.
  When shipping, bump `CACHE_VERSION` in `sw.js` and `APP_VERSION` in
  `js/core/config.js` together.

## check:offline scope

`npm run check:offline` (`scripts/check-offline.mjs`) still runs before every
PR. It protects the **static frontend** from remote assets and from accidental,
unapproved URLs:

- It scans runtime `.html`, `.css`, `.js`, `.mjs`, `.webmanifest` and `.json`
  files.
- It skips `node_modules/`, `docs/`, `scripts/`, `tests/`, `.git/`, `.github/`
  and `package*.json`.
- Any `http://` or `https://` URL it finds fails the check. URLs inside
  comments are ignored, and so is the SVG namespace `http://www.w3.org/2000/svg`.
- **Exactly one file is exempt: `data/references.json`.** Its URLs are
  reference links shown to readers, never fetched as assets or APIs. The
  match uses the exact repository-relative path, so every other JSON file
  (including the rest of `data/`) is still checked.

This keeps scripts, styles, fonts, icons and images inside the repo and lets
the service worker cache the frontend.

**Current limitation: the check has no API allowlist yet.** Any remote URL in
runtime code fails, including an approved API endpoint. That is acceptable
today because no API endpoint is configured (the landing-page forms read
`data-api-endpoint`, which is unset). The policy intent is **not** a permanent
ban on approved APIs. The allowlist below is added when the first one is
approved.

**Proposed allowlist, to add with the first approved remote endpoint. Not
implemented yet.** Keep it narrow; don't weaken the check broadly.

1. Declare approved API base URLs in **one** place, e.g. an `API_ENDPOINTS`
   object in `js/core/config.js`.
2. Add a small reviewed list of approved **origins** (e.g.
   `scripts/approved-api-origins.json`) that `check-offline.mjs` reads.
3. A URL passes only if its origin **exactly** matches an approved origin,
   **and** it appears in `js/core/config.js`. The same URL anywhere else
   (a page, CSS, a `<script src>`) still fails.
4. Approved origins must be `https://`. `http://localhost` and
   `http://127.0.0.1` may be allowed for development only.
5. Adding an origin is a core-file change: document why the origin is
   trusted, review it against the API policy, and run the full test suite.

## Planned IndexedDB stores

Database `astrohealth` (see `DB_NAME` / `DB_VERSION` in `js/core/config.js`).

| Store | Holds |
| --- | --- |
| `users` | Local accounts (astronaut / medical officer roles) |
| `astronauts` | Crew profiles and baselines |
| `measurements` | Vital signs over time (HR, SpO₂, sleep, …) |
| `wellbeingAssessments` | Mood / stress / fatigue questionnaires |
| `privateJournal` | Astronaut-only journal entries (never shown to MO) |
| `cognitiveChecks` | Reaction-time / cognitive test results |
| `simulationRuns` | Scenario runs from the Simulation Center |
| `alerts` | Alerts raised by the risk engine |
| `alertActions` | Acknowledge / escalate / resolve history per alert |
| `messages` | Delayed crew ↔ ground messages |
| `missionEvents` | Mission timeline (EVA, blackout windows, …) |
| `reports` | Generated health reports |
| `settings` | User / device preferences |
| `meta` | Schema version, seed flags, last sync time |

## Simulation Center (Sprint 7)

`#/simulation` is Medical Officer only (route guard + service check). It
generates **deterministic synthetic** readings for one crew member. The
simulation service itself never reads thresholds and never reads or writes
`alerts` / `alertActions`. *Sprint 7 shipped as simulation only; since
Sprint 8*, after each step's transaction has committed, the service asks the
risk service to evaluate the demonstration rules for that crew member (a
separate transaction — see [Risk Engine and Alerts](#risk-engine-and-alerts-sprint-8)).
If that evaluation fails, the reading stays stored and the page says "Risk
evaluation unavailable"; the next step or an explicit evaluation checks the
current stored data again.

- **Catalog** — `js/simulation/scenarios.js`: pure, static, no imports (a
  unit test enforces this). `low_oxygen` (SpO₂, target 88 %, start = stored
  baseline if 94–100, else 98) and `elevated_heart_rate` (heart rate, target
  128 bpm, start = baseline if 50–95, else 72). 12 steps each: 5 ramp, 2 hold,
  5 recovery; whole numbers; the last value equals the start value.
  `CATALOG_VERSION` 1. One step every 8 s at 1×; speeds 1, 2, 4, 8, fixed at
  start.
- **Service** — `js/services/simulation-service.js` imports only
  `js/db/index.js`, `./access-control.js` and the catalog. Every operation
  verifies the Medical Officer first (`verifyMedicalOfficer`); crew IDs are
  resolved afterwards (`resolveCrewMember`). Page input is limited to
  `{ crewId, scenarioId, speed, confirm }` (start), `{ expectedStep }`
  (advance) and `{ confirm }` (stop). Any verified Medical Officer may
  control the active run. Outputs contain no user or astronaut ids; the
  opaque `runRef` is a control handle the page keeps in memory only.
- **One active run** (running or paused) across the crew, checked with
  `simulationRunsRepo.getActive({ tx })` inside the start transaction.
- **Transactions** — start / pause / resume / stop: `simulationRuns` +
  `missionEvents`. Advance: `MEASUREMENT_WRITE_STORES` + `simulationRuns` +
  `missionEvents`; the reading is written only through
  `measurementsRepo.add(…, { tx })`, which maintains `astronauts.latest` and
  `dailySummaries`. Every write transaction re-reads the run and compares
  status and step; expected business conflicts are returned from the
  callback (nothing written), not thrown.
- **Timestamps** — a step's timestamp is exactly the controlled `now`, which
  must be strictly later than `lastStepAt`; otherwise the result is
  `conflict / clock_not_monotonic` and nothing is written. No backdating,
  no future dates, no backfill.
- **Extra non-indexed `simulationRuns` fields** (allowed by DATA-MODEL §2
  "extra non-indexed fields"; no schema change): `step` (steps generated,
  0–12), `totalSteps` (12), `startValue` (frozen at start), `lastStepAt`
  (time of the last step; `startedAt` before the first), `pausedAt` (0 unless
  paused), `catalogVersion` (1). A run whose fields don't match the catalog
  can only be stopped.
- **Events** (existing types only): start → `simulation_started`
  `{ phase: "started" }`; resume → `simulation_started` `{ phase: "resumed" }`;
  pause → `simulation_paused`; stop → `simulation_stopped`
  `{ outcome: "stopped" }`; completion → `simulation_stopped`
  `{ outcome: "completed" }`; each reading → one `measurement_recorded`. All
  use `refStore: "simulationRuns"`, `refId` = the run id.
- **Measurements** — `source: "simulation"`, `quality: "ok"`,
  `simulationRunId` = the run id, canonical unit, `createdBy` = the verified
  officer. Existing dashboards label them "Simulated (Simulation Center)".
- **Timer** — owned by the page (`setTimeout` chain, never `setInterval`),
  only for a run this tab started, resumed or chose to Continue. Cleared on
  pause, stop, completion, errors and navigation. Leaving the page writes
  nothing (no auto-pause, no backfill). A running run with no step or resume
  for `3 × interval + 5 s` is shown as "Not advancing — the page may have been
  closed" and waits for Continue, Pause or Stop. The simulation advances only
  while the page is open; background tabs may be delayed.

**Known limitations**

- No cross-tab lock. IndexedDB runs overlapping readwrite transactions one
  after another and every step compares the stored step, so **duplicate
  steps and a second active run are prevented** — but two tabs that both
  advance the same run may alternately advance it faster than intended. A
  payload-free `simulation:changed` event-bus ping refreshes other tabs.
- Daily summaries and `astronauts.latest` don't record a source, so
  simulated readings permanently join that day's min / max / average and can
  move the latest cache (latest-reading cards still show "Simulated"). Only
  "reset demo data" removes them.
- Sleep, activity and wellbeing scenarios are deferred (one sleep value per
  night can't be simulated coherently in real time).

## Risk Engine and Alerts (Sprint 8)

Deterministic, explainable **demonstration** rules on synthetic data. They are
not evidence-backed, not medical guidance, not clinical standards and not
NASA thresholds, and no references are cited. Every alert and the relevant
screens say: "Demonstration threshold — not clinically validated."

- **Rules** — `js/engine/rules/physical-rules.js` (pure catalog, no values):
  | Rule | Metric | Warning | Critical | Clears when |
  | --- | --- | --- | --- | --- |
  | PHY-01 v2 elevated heart rate | `heartRate` | 2 consecutive `> warningHigh` | 2 consecutive `> criticalHigh` | 2 consecutive `≤ warningHigh` |
  | PHY-02 v1 low SpO₂ | `spo2` | 2 consecutive `< warningLow` | 2 consecutive `< criticalLow` | 2 consecutive `≥ warningLow` |
  | PHY-03 v1 elevated systolic BP | `bpSystolic` | 2 consecutive `≥ warningHigh` | 2 consecutive `≥ criticalHigh` | 2 consecutive `< warningHigh` |
  | PHY-05 v1 reduced sleep | `sleepDuration` | 3 consecutive UTC nights `< warningLow` | 3 nights `< criticalLow` | 1 night `≥ warningLow` |

  Threshold **values** come only from `settings.thresholds` (seeded
  demonstration values) and are passed in; a missing value gives
  "insufficient". Historical alerts (e.g. the seeded PHY-01 v1 alert) keep
  their own rule snapshot. WB-01 is not evaluated (deferred); the seeded
  WB-01 alert stays readable and actionable.
- **Readings** — only quality `"ok"` readings that are fresh (vital signs
  ≤ 24 h old; for sleep the newest night ≤ 36 h old) are evidence.
  `invalid` is ignored; `suspect` and stale readings never trigger, escalate
  or clear — they are only counted in the explanation. "Consecutive" means
  consecutive among usable readings, newest first; sleep uses the newest
  reading of each UTC day and needs consecutive UTC dates.
- **Engine** — `js/engine/risk-engine.js`: `evaluateRule()` → `triggered`
  (severity, evidence, explanation, threshold snapshot, limitation) /
  `clear` / `insufficient` (reason); `planAlertChange()` → `none` / `open` /
  `escalate` / `retrigger` / `clear`. Pure, deterministic, frozen results;
  inputs never mutated; time passed in.
- **Lifecycle** (existing statuses, actions and event types only):
  | Change | Who | Writes (one transaction, all or nothing) |
  | --- | --- | --- |
  | open | engine | `alertsRepo.add` (new `ALT-` number via `meta`) + action `created` + events `risk_detected`, `alert_generated` |
  | escalate (higher severity only) | engine | alert: severity up, status back to `new`, `acknowledgedAt` 0 / `acknowledgedBy` "" (the earlier acknowledgement stays in `alertActions` / `missionEvents`) + action `escalated` + event `alert_escalated` |
  | retrigger (new evidence, same or lower tier) | engine | alert: `lastTriggeredAt`, `occurrenceCount + 1`, evidence merged, `conditionCleared` 0 + event `risk_detected` |
  | condition cleared | engine | alert: `conditionCleared` 1 (status unchanged) + action `condition_cleared` + event `alert_condition_cleared` |
  | acknowledge (`new` → `acknowledged`) | Medical Officer | alert + action `acknowledged` + event `alert_acknowledged` |
  | resolve (`acknowledged` → `resolved`) | Medical Officer | trimmed note 1–500 chars; if `conditionCleared` is 0, explicit confirmation; alert + action `resolved` + event `alert_resolved` |

  Severity never decreases automatically. A resolved alert is history: it is
  never reopened; a later occurrence opens a **new** alert (new number,
  `occurrenceCount` 1). Audit records are never edited or deleted.
- **Triggers** — after a committed Simulation Center step, and an explicit
  "Evaluate crew now" (Medical Officer, `#/alerts`). No evaluation on page
  load, no timer, worker, background process, remote service or Python.
- **Atomicity and concurrency** — evaluation: one transaction per astronaut
  over `measurements`, `alerts`, `meta`, `alertActions`, `missionEvents`; inside
  it the readings and the open alert (`getOpenByDedupeKey`) are re-read and the
  plan is computed from what is stored. Lifecycle actions: one transaction
  over `alerts`, `alertActions`, `missionEvents` that re-reads the alert.
  IndexedDB runs overlapping readwrite transactions one after another, so
  competing evaluations or actions (other tabs) can't duplicate an alert or an
  audit record; repeats are "unchanged", invalid transitions are conflicts.
  An in-memory lock also stops double clicks. No cross-tab lock is claimed.
- **Privacy** — services verify the user (`access-control.js`) before any
  alert or health read. Astronauts see only their own alerts (open + resolved
  in the last 30 days), read-only; another astronaut's alert number is "not
  found". The risk and alerts services never read the journal, wellbeing
  records, messages or password material. Pages get public alert numbers and
  crew IDs only — never alert, astronaut, user or measurement ids. Wellbeing
  alert evidence is shown without score values.
- **Explainability** — each alert stores the rule snapshot
  (`{ id, version, description, thresholdUsed, thresholdSource }`), evidence
  snapshots (`{ metric, value, unit, timestamp, measurementId, source,
  quality }`), the explanation (why this severity tier) and `evaluation`
  (`{ ruleVersion, evaluatedAt, considered, excluded, limitation }`) —
  documented as optional non-indexed metadata in `docs/DATA-MODEL.md` §3.9.

## Health History, Reports and Settings (Sprint 9)

Read-only features. Sprint 9 writes **nothing** to IndexedDB: no
`reportsRepo` record, no `missionEvents`, no `settingsRepo.set`.

- **History** (`history-service.js`, `#/history`, `#/history/AH-0n`) — built
  from `missionEvents` for one verified astronaut and a 7 / 14 / 30-day UTC
  range (whole days, inclusive). **Stored `summary` and `data` are never
  returned or rendered** (seeded shared check-in events contain scores and
  response events contain reply text). An explicit allow-list
  (`describeEvent`) writes every line from narrowly validated fields:
  | Category | Event types | Text (examples) |
  | --- | --- | --- |
  | Readings | `measurement_recorded` | "Simulated reading: SpO₂ 92 % (step 3)" (only when the referenced simulation run exists), "12 vital-sign samples recorded", "Sleep duration recorded: 6.2 h" |
  | Wellbeing activity | `checkin_completed`, `cognitive_check_completed` | "Daily check-in completed · shared"; "· private" **only for its own astronaut**; "Cognitive check completed" — never a score |
  | Alerts | `risk_detected`, `alert_generated`, `alert_escalated`, `alert_condition_cleared`, `alert_acknowledged`, `alert_resolved` | public `ALT-` number + title (internal id resolved in the service; "an alert" without a link if the lookup fails) — no explanation, no notes |
  | Messages | `message_sent`, `message_acknowledged`, `astronaut_response` | allow-listed template label only; never message or response text |
  | Simulation | `simulation_started` / `_paused` / `_stopped` | "Simulation started: Low oxygen saturation demonstration" |

  `settings_changed`, `report_generated`, `data_reset`, `data_imported` and
  unknown types are omitted. The Medical Officer never receives an event that
  reveals a private check-in. Snapshot: sorted by timestamp desc, category
  rank, internal tie-breaker; capped at 500 (`totalAvailable`,
  `returnedCount`, `truncated`); internal ids removed; the page reveals 100 at
  a time from the loaded snapshot (no id cursor).
- **Provenance** — never inferred. Labels: `simulation` → "Simulated ·
  Simulation Center", `seed` → "Synthetic seed data", `manual` → "Manual
  entry", otherwise "Source not recorded". History marks a reading as
  simulated only when its event references a stored simulation run; other
  reading events say "Source not recorded". Reports count sources only from
  raw measurement records with a canonical `source`, inside the last 7 UTC
  days (raw retention); older dates say "Source breakdown is unavailable for
  this period."
- **Reports** (`reports-service.js`, `#/reports`, `#/reports/AH-0n`) —
  generated dynamically and printed with `window.print()` (via
  `css/print.css`) only when the user presses "Print report"; no PDF
  library. `astronaut_health` (own, or a crew member for the Medical Officer)
  and `crew_summary` (Medical Officer). Pure builders
  (`buildHealthReport`, `buildCrewSummary`) take an explicit `generatedAt`
  and never read the clock: identical input → deeply equal model. Missing
  data shows "No data"; nothing is estimated. Every report states the
  disclaimer and lists what is excluded: private journal, wellbeing scores,
  cognitive scores, alert explanations, Medical Officer notes, message
  bodies and responses, passwords and session data, internal IDs. Check-ins
  appear as counts only (the Medical Officer gets the shared count only).
- **Settings** (`settings-service.js`, `#/settings`) — read-only mission and
  units for both roles; read-only demonstration thresholds ("Demonstration
  thresholds — not clinically validated.") and simulation default speed for
  the Medical Officer only.
- **Preferences** (`js/core/preferences.js`) — browser-only
  `localStorage["astrohealth.prefs.v1"] = { [userId]: { textSize, motion } }`.
  Only `textSize` (standard / large / larger) and `motion` (system / reduce)
  are accepted; malformed data falls back to defaults; reset removes only
  the current user's entry; blocked storage keeps the choice in memory for
  the tab. Applied as `data-text-size` / `data-motion` on `<html>` (CSS hooks
  in `css/base.css`; `prefers-reduced-motion` is still respected); other
  tabs update through the browser `storage` event. Preferences never affect
  data, alerts, thresholds, simulation or risk evaluation.
- **Deferred** — stored report snapshots (need public report references and
  a retention/deletion design; `reportsRepo` has no delete); editable
  thresholds and shared settings (need validation, an audit trail with
  `settings_changed`, atomic writes and stated consequences); ranges beyond 30
  days; a message-history view.

## Session contract

`localStorage["astrohealth.session"]` (`SESSION_KEY` in `js/core/config.js`)
is **written only by `js/auth/`**. Other code may **read** it — e.g. to
show "Continue to dashboard" on the landing page — but never write or delete it.

## Database contract

Stores, fields, keys, indexes, migrations, and exact repository signatures are
defined in `docs/DATA-MODEL.md` before implementation. Services call
repositories only through `js/db/index.js`. Repositories contain no business
rules or permission checks; services own permissions, validation, timeline
logging, risk evaluation, and events. `js/db/mock-repositories.js` keeps the
same API for tests. Any contract change updates `docs/DATA-MODEL.md`, the mock
and the relevant tests together.

## Data files

### `data/team.json`

```json
{ "team": "RSS AstroMinds", "members": [{ "name": "", "role": "", "initials": "", "photo": null }] }
```

`photo` is a relative path inside `assets/images/` or `null` (show initials in `.avatar`).

### `data/references.json`

An array of sources. JSON has no comments, so the schema lives here:

```json
[
  {
    "id": "ref-001",
    "title": "Exact title of the paper / page",
    "authors": ["Surname, A.", "Surname, B."],
    "publisher": "Journal, agency or website",
    "year": 2024,
    "url": "https://…",
    "accessed": "2026-11-14",
    "verified": false
  }
]
```

**Never invent citations.** Only add a source that has actually been opened
and read. Every entry starts with `"verified": false`. Set it to `true` only
after a separate, deliberate check of the title, authors, year and URL against
the real source; while the project is solo, the owner does that check.
Unverified sources must stay `verified: false`, and the UI should label them
as such.

URLs in `data/references.json` are *displayed as text/links* and never
fetched by the app. They are reference data, not API endpoints, which is why
`check:offline` exempts exactly this file (see
[check:offline scope](#checkoffline-scope)).

## Release verification

Release candidates keep the application, cache and package versions aligned
while the IndexedDB schema version changes only when the schema changes. The
committed service-worker manifest is generated by `npm run build:sw`; screenshots
and development documentation are intentionally excluded from that runtime cache.

`npm run test:release` performs the repeatable local gate: manifest generation,
unit tests, static/offline policy checks and a fresh-profile headless-Chrome smoke
test. GitHub Actions runs the deterministic Node checks on Node 24 and verifies
that regenerating the manifest produces no diff. Browser smoke remains local
because a browser is not part of the repository's CI contract.

Before a release is tagged, follow `docs/DEMO.md` and Section 14 of the manual
checklist. Record unavailable platform checks honestly; never convert an
unperformed Firefox, Safari, screen-reader or physical-print check into a pass.
