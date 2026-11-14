# Manual test checklists

Run these before merging a PR that changes pages, and before every demo.
Always test through a local server: `npm run serve` → <http://localhost:8080>.

## 1. Every page (index, about, login, app, style guide)

- [ ] Page loads with no console errors or warnings
- [ ] Text is in **Inter** (DevTools → Elements → Computed → *Rendered Fonts*)
- [ ] Icons render (no empty squares)
- [ ] Favicon shows in the browser tab
- [ ] Footer disclaimer is visible
- [ ] Press <kbd>Tab</kbd> once → "Skip to main content" appears and works
- [ ] Every interactive element has a visible orange focus ring
- [ ] At 375px wide nothing overflows horizontally

## 2. Offline

1. Load <http://localhost:8080/index.html> once (service worker installs).
2. DevTools → Application → Service Workers: status is **activated**.
3. DevTools → Network → tick **Offline**.
4. Reload index, login, app and about → all still load with fonts and icons.
5. DevTools → Network with "3rd-party requests" filter → **zero** requests to any other host.

## 3. App shell (app.html)

- [ ] Sidebar shows 9 items; Crew Monitor and Simulation Center have the "MO" tag
- [ ] Active item has the orange bar, tint and orange icon
- [ ] Below 1024px: sidebar hides; the menu button opens it as a drawer; clicking the dark overlay or pressing <kbd>Esc</kbd> closes it
- [ ] Offline status card in the sidebar footer reads "Online · Offline-ready" once cached, and "Offline mode" when the network is off

## 4. Opened the wrong way

- [ ] Double-click `index.html` in Finder/Explorer (file://) → amber warning bar asks you to run a local server

## 5. Print reports

- [ ] <kbd>Ctrl/Cmd</kbd>+<kbd>P</kbd> on app.html → white page, black text, no sidebar or topbar

## 6. Login & authentication (demo only — not real security)

Demo accounts (password `demo`): `haddad` (astronaut, a-01), `medofficer` and
`medbackup` (Medical Officer).

- [ ] Open `app.html` signed out → you land on `login.html`
- [ ] Empty submit → "Enter your username." (focus moves to Username); then "Enter your password."
- [ ] Wrong password **and** unknown username → the same "Username or password is incorrect."
- [ ] Demo account button only **fills** the form; nothing happens until you press Sign in
- [ ] Show/hide password button announces "Show password" / "Hide password"
- [ ] `haddad` → `app.html#/overview`, header shows "Cmdr. Sami Haddad · Astronaut · SH", 7 nav items
- [ ] As `haddad`, type `app.html#/crew` and `#/simulation` → "Access denied" view (not the page)
- [ ] `medofficer` → 9 nav items; Crew Monitor and Simulation Center open
- [ ] Reload `app.html` → still signed in; open `login.html` → sent back to the app
- [ ] DevTools → Application → Local Storage → `astrohealth.session` has no password, hash or salt
- [ ] Two tabs on `app.html`; log out in one → the other returns to `login.html` too
- [ ] Logging out does **not** delete data (IndexedDB `astrohealth` still has 6 users)
- [ ] After one online visit: DevTools → Network → Offline → sign in still works
- [ ] Keyboard only: Tab order is skip link → username → password → show/hide → Sign in → demo accounts; focus ring always visible
- [ ] 375 px wide: no horizontal scrolling on `login.html` or `app.html`

## 7. Application shell & role-based navigation (Sprint 3)

Run `python3 -m http.server 8080`, then open <http://localhost:8080/login.html>.
If you visited before, reload once so the current service worker
(cache `astrohealth-v0.8.0`) takes over. If the mission chips show
"Not available", the browser holds data seeded before the `mission` setting
existed: run `resetDatabase()` or clear site data.

**Astronaut** (`haddad` / `demo`)

- [ ] Lands on `#/overview`; top bar shows "Cmdr. Sami Haddad", "Astronaut", "SH"
- [ ] Top bar shows **Mission ODYSSEY-7** and **Mission Day 147** on the seed day (from the synthetic seed, not hardcoded)
- [ ] Bell is a plain link to Alerts with **no** number on it
- [ ] Sidebar has 7 items; **Crew Monitor** and **Simulation Center** are not shown
- [ ] Every item opens a functional page (no placeholders remain since Sprint 9): Overview (section 8), Physical Health and Mental Wellbeing (section 10), Alerts (section 12), Health History, Reports and Settings (section 13)
- [ ] The active item has `aria-current="page"`; the page heading and browser tab title change; the page does not reload
- [ ] After choosing a route, focus is on the page heading (screen reader announces it)
- [ ] Type `#/crew` (and `#/simulation`, `#/crew/AH-01`) → **Access denied**: lock icon, "available to the Medical Officer role only. You are signed in as Astronaut.", "Go to Overview" link, focus on the heading
- [ ] Type `#/admin`, `#/`, `#/Crew` → silently replaced with `#/overview`; Back does not return to the bad URL
- [ ] Reload on `#/reports` → still signed in, still on Reports
- [ ] Log out → `login.html`; IndexedDB `astrohealth` still has its data

**Medical Officer** (`medofficer` / `demo`)

- [ ] Lands on `#/overview`; "Dr. Lena Ortiz", "Medical Officer", "LO"
- [ ] 9 sidebar items; Crew Monitor and Simulation Center visible with the "MO" tag
- [ ] `#/overview` and `#/crew` (Crew Monitor) open the functional Sprint 5 views — verify them with section 9
- [ ] `#/simulation` opens the Sprint 7 Simulation Center (no Access denied) — verify it with section 11
- [ ] `#/alerts` opens the Sprint 8 Alerts page — verify it with section 12
- [ ] `#/history`, `#/reports` and `#/settings` open the Sprint 9 pages — verify them with section 13
- [ ] Astronauts still get Access denied on both `#/crew` and `#/simulation` (see the Astronaut list above)
- [ ] Log out → `login.html`

> **Historical — Sprint 3 release (app version 0.2.0), no longer current:** the
> service worker cache was `astrohealth-v0.2.0`, and for the Medical Officer
> `#/overview`, `#/crew` and `#/simulation` were all placeholders. Use the
> current expectations above.

**Sessions across tabs**

- [ ] Signed out, open `app.html#/history` → login; after sign-in you land on `#/history`
- [ ] Two app tabs: log out in one → the other goes to `login.html`
- [ ] In DevTools, edit `astrohealth.session` so `expiresAt` is in the past, then change route → login (returns to that route after sign-in)

**Responsive** (DevTools device toolbar)

- [ ] Desktop 1440 px: sidebar always visible, no menu button, no horizontal scroll
- [ ] Tablet 768 px and mobile 375 px: menu button shows; sidebar is hidden and **not reachable with Tab** while closed
- [ ] Menu button opens the drawer (`aria-expanded="true"`, label "Close menu", focus moves into it)
- [ ] Closes on: overlay click, <kbd>Esc</kbd> (focus returns to the menu button), choosing any route (even the current one)
- [ ] Widening the window past 1024 px while open leaves no overlay behind
- [ ] Mobile: long titles end with "…"; no horizontal scroll; disclaimer visible at the bottom

**Offline**

- [ ] Load once online, then DevTools → Network → Offline → reload `app.html`
- [ ] Every route still opens; mission chips still filled; sidebar card reads "Offline mode"
- [ ] Console has no errors; Network shows no request to any other host

## 8. Astronaut Overview (Sprint 4, `#/overview`)

Run `python3 -m http.server 8080` and open <http://localhost:8080/login.html>.
Returning browsers: reload once so the current service worker cache
`astrohealth-v0.8.0` takes over. All data is synthetic seed data; values are relative to the moment
the database was seeded, so "today" items depend on the UTC time of seeding.

**Expected per account** (seeded today after 08:00 UTC)

| Account | Alert status | Open alerts | Message from the Medical Officer |
| --- | --- | --- | --- |
| `haddad` | No open alerts (green, check icon) | none (ALT-0181 is resolved) | "Routine request: please take a full vital-signs reading…" |
| `karim` | No open alerts | none | "No unacknowledged messages from the Medical Officer." |
| `chen` | Info (blue, info icon) | ALT-0189 Supportive check-in recommended · New | "No unacknowledged messages from the Medical Officer." |
| `reyes` | Watch (amber, triangle icon) | ALT-0190 Reduced sleep duration · Acknowledged | "No unacknowledged messages from the Medical Officer." (theirs is already acknowledged) |

**Each astronaut**

- [ ] Header: "Welcome, <name>", crew ID, mission role, mission, and the synthetic-data notice
- [ ] Status shows "Based on your open alerts only. This is not a health assessment." — never "healthy", "safe" or "normal"
- [ ] Open alerts: at most 3; number · title, explanation, severity badge, status badge, SYNTHETIC tag, "Detected … UTC"; "View all alerts" → `#/alerts`; no action buttons, no unread count
- [ ] Vital signs: exactly Heart rate, SpO₂, Blood pressure (systolic/diastolic), Sleep duration — no temperature, respiration or radiation
- [ ] Each card: value + unit, "… UTC · N min ago", SIMULATED tag, "Your baseline: …"
- [ ] Only your own crew ID, name and alert numbers appear (no other astronaut's data)
- [ ] Today's routine: check-in "Completed today" + "Shared with the Medical Officer" or "Private — not shared" (no mood/stress scores); vital signs "Recorded today"; cognitive check "Last completed …" (never "due"/"overdue")
- [ ] Sleep: 7 UTC dates with bars and values, summary sentence (nights recorded, average, baseline, nights below baseline); missing nights say "No data"
- [ ] A message shows "From the Medical Officer" only when its sender is a stored `medical_officer` account (verified in the service); no sender id appears anywhere on the page
- [ ] Quick links go to `#/physical`, `#/wellbeing`, `#/history`, `#/alerts` (Physical Health and Mental Wellbeing are the Sprint 6 pages; Alerts is the Sprint 8 page; Health History is the Sprint 9 page)

**Routing by role (current, since Sprint 5)**

- [ ] Astronaut `#/overview` is this Sprint 4 Astronaut Overview, unchanged
- [ ] Medical Officer `#/overview` delegates to the Sprint 5 Medical Officer dashboard — it never shows an astronaut's personal Overview. Verify the Medical Officer workflow with section 9.

**States**

- [ ] Stale: view a database seeded on an earlier day → cards show "No newer reading" and the real age (e.g. "3 d ago"); values are not hidden or zeroed
- [ ] Section failure (DevTools console, then go to `#/history` and back to `#/overview`):
      `const o = IDBObjectStore.prototype.index; IDBObjectStore.prototype.index = function (n) { if (n === "by_astronaut_status") throw new DOMException("x", "UnknownError"); return o.call(this, n); }`
      → Alert status "Status unavailable", Open alerts "Couldn't load your alerts." + Retry; other sections still show. Then run `IDBObjectStore.prototype.index = o` and press Retry → normal status returns
- [ ] Navigate to `#/overview` and immediately to `#/history` → the Health History page stays (no late Overview content)

**Responsive, keyboard, accessibility**

- [ ] 1440 px: 4 vital cards in a row · 768 px: 2 columns · 375 px: 1 column; no horizontal scrolling; long alert/message text wraps
- [ ] Tab from the top reaches "View all alerts" and the four quick links, each with a visible focus ring; at 375 px Tab never enters the closed drawer
- [ ] Screen reader / Accessibility pane: one h1 "Overview"; h2s in order Welcome, Alert status, Open alerts, Latest vital signs, Message from the Medical Officer, Today's routine, Sleep — last 7 nights, Go to; vital cards are named articles; values read with spoken units ("73 beats per minute")

**Offline**

- [ ] After one online visit, DevTools → Network → Offline → reload `app.html#/overview` → the Overview renders from local data
- [ ] Console: no errors · Network: no request to another host

**Results — Sprint 4 release, 2026-11-14 (historical; app version 0.3.0; headless Chrome via DevTools Protocol, fresh profile, seeded 14:15 UTC):**
15/15 checks passed — the four astronauts above (status, alerts, messages, no leakage, labels, UTC times, banned wording), refresh + other routes still placeholders + quick links, late-result guard, Retry after an induced alerts failure, keyboard (fresh tab; 5/5 Overview targets with focus ring; drawer skipped at 375 px), accessibility tree (one h1, 8 ordered h2, 4 named vital cards), 1440/768/375 px (4/2/1 columns, no overflow), the Medical Officer placeholder that Sprint 4 showed at `#/overview` (since replaced by the Sprint 5 dashboard), signed-out `#/overview` → login → back, offline reload (cache `astrohealth-v0.3.0` at that time). No console errors, no external requests.

**Regression after Sprint 5, 2026-11-14 (app version 0.4.0):**
The unmodified Sprint 4 harness now fails 3 of 15 checks, all because of intended Sprint 5 changes: it still expects the old Medical Officer placeholder at `#/overview` and the old cache `astrohealth-v0.3.0`, and its signed-out check then fails as a cascade (the Medical Officer session from the failed check is still open). With only those two cross-role/cache expectations updated — Medical Officer `#/overview` is the crew dashboard; cache is `astrohealth-v0.4.0` — the regression run passes 15/15. All astronaut checks pass unchanged. No console errors, no external requests.

Not yet checked: a real screen reader (VoiceOver/NVDA), Firefox, Safari.

## 9. Medical Officer dashboard & Crew Monitor (Sprint 5)

Run `python3 -m http.server 8080`, open <http://localhost:8080/login.html>, and
reload once so the current service worker cache `astrohealth-v0.8.0` takes over.
All data is synthetic seed data.

**`medofficer` and `medbackup` — `#/overview`**

- [ ] "Welcome, <name>", Medical Officer, mission line, synthetic-data notice
- [ ] Crew summary: "4 crew members · 2 with open alerts"; counts Critical 0 · Watch 1 · Info 1 · Status unavailable 0 · Data needs review 0 · No open alerts 2 (each with icon + text + colour)
- [ ] "Review first" is a numbered list: 1. Jonas Reyes · AH-04 (Watch, ALT-0190) 2. Mei Chen · AH-03 (Info, ALT-0189); each "Review" goes to `#/crew/AH-0n`
- [ ] Wording: "based on stored open alerts only. This is not a health assessment." — never healthy, safe, normal, cleared, fit for duty or a score

**`#/crew`**

- [ ] Four cards, each astronaut exactly once, in the order Reyes, Chen, Haddad, Karim
- [ ] Each card: state badge + reason, open-alert count, Heart rate / SpO₂ / Sleep duration with UTC time and SIMULATED tag (no blood pressure), last shared check-in date, message status, "View details"
- [ ] Haddad: "1 awaiting acknowledgement"; Reyes: "1 replied"
- [ ] "Open alerts across the crew": ALT-0190 (Reyes), ALT-0189 (Chen) with names, Synthetic tag, no buttons, link to `#/alerts`
- [ ] "Shared wellbeing check-ins": dates only — no mood/stress numbers

**`#/crew/AH-0n` (detail)**

- [ ] From a card, "View details" opens the detail and focus moves to the name heading; the sidebar still marks Crew Monitor as current
- [ ] Reyes `#/crew/AH-04`: Watch + reason; ALT-0190; Heart rate, SpO₂, Blood pressure, Sleep duration; up to 7 shared check-ins with scores ("Mood 4 / 5"); 7-night sleep summary; "Last completed …" cognitive check (no score); the Medical Officer message marked Replied with Jonas's reply text; no buttons
- [ ] Haddad `#/crew/AH-01`: message "Awaiting acknowledgement"; none of his 3 private check-ins appear; no journal text anywhere
- [ ] Direct URL `app.html#/crew/AH-03` and refresh → Mei Chen's detail
- [ ] `#/crew/AH-99`, `#/crew/a-01`, `#/crew/AH-01/x`, `#/crew/ah-01` → "Crew member not found" with "Back to Crew Monitor" (no astronaut selected)
- [ ] Signed out, `app.html#/crew/AH-03` → login; after sign-in you land on `#/crew` (known limitation: nested returnTo isn't kept)

**Astronaut (`haddad`)**

- [ ] `#/overview` is the unchanged astronaut Overview (Sprint 4)
- [ ] `#/crew`, `#/crew/AH-01`, `#/crew/AH-04` → Access denied; no Crew Monitor in the sidebar

**Responsive, keyboard, accessibility, offline**

- [ ] 1440 px: 3 crew columns · 768 px: 2 · 375 px: 1; no horizontal scrolling on `#/overview`, `#/crew`, `#/crew/AH-04`
- [ ] Tab reaches every crew link/button with a visible focus ring; at 375 px Tab never enters the closed drawer
- [ ] Accessibility pane: one h1; h2s Welcome / Crew summary / Review first on `#/overview`; the queue is an ordered list; crew cards are named articles
- [ ] After one online visit, Network → Offline → reload `#/crew/AH-04` → still renders; console has no errors; no request to another host

**Results — 2026-11-14 (headless Chrome via DevTools Protocol, fresh profile):**
14/14 checks passed — both Medical Officer accounts (summary counts, queue order), crew list (4 once each, order, readings, messages, dates-only sharing), selection + focus + back, direct nested URL + refresh, 4 unknown/malformed IDs → not found, privacy (3 private check-ins hidden, no journal text, no unshared check-in events), late-result guard, 1440/768/375 px (3/2/1 columns, no overflow), keyboard (fresh tab), accessibility tree, offline detail reload, astronaut Overview unchanged + 3× Access denied. No console errors, no external requests.
Not yet checked: a real screen reader, Firefox, Safari.

## 10. Physical Health & Mental Wellbeing (Sprint 6)

Run `python3 -m http.server 8080`, open <http://localhost:8080/login.html>, and
reload once so the current service worker cache `astrohealth-v0.8.0` takes over.
All data is synthetic. No private journal in this sprint.

**Astronaut — `#/physical`** (e.g. `reyes`)

- [ ] "Your physical health" with your own name and crew ID only — no other astronaut appears
- [ ] Latest readings: Heart rate, SpO₂, Blood pressure (systolic/diastolic from one sample), Sleep duration; UTC time + age; SIMULATED or "Manual entry"; "Data quality: suspect" / "No newer reading" when relevant
- [ ] Each reading says e.g. "3 bpm above the stored personal baseline of 70 bpm." and the section says it is descriptive, not a clinical assessment — never normal/abnormal/healthy/safe
- [ ] Trends: "7 days" / "30 days" toggle (`aria-pressed`); a table per measure (Date, Average, Min, Max, Readings), missing days say "No data"; note that daily values include suspect readings and exclude invalid ones; no daily steps
- [ ] Data quality list and open **physical** alerts only (Reyes: ALT-0190), read-only
- [ ] `#/physical/AH-01` (any nested URL) → "Crew member not found"

**Astronaut — `#/wellbeing`** (e.g. `haddad`)

- [ ] Daily check-in form: six questions (fieldset + legend + scale text), native radio buttons, nothing preselected; "Who can see this check-in?" with "Only me (private)" and "Share with the Medical Officer", neither preselected
- [ ] Submit with answers missing → error summary (focused) listing the questions; each unanswered question is outlined with its own message; answers you gave are kept
- [ ] Private check-in on a day that already has one → "You already checked in today … Add another check-in?" → confirm → "Check-in saved. It is private" (focused); form clears; history shows it as **Private**
- [ ] Shared check-in → "All six scores will be shared with the Medical Officer. This check-in can't be edited, and sharing can't be changed or revoked in this version." → confirm → (same-day confirmation, if any) → "saved and shared"; history shows **Shared with the Medical Officer**
- [ ] Cancel on either confirmation saves nothing and returns focus to "Save check-in"
- [ ] Double/triple clicking the final confirmation saves exactly one check-in
- [ ] Recent averages are labelled "Based on your own check-ins (private and shared)"; cognitive check shows last-completed time only; open wellbeing alerts only (Chen: ALT-0189)
- [ ] `#/wellbeing/AH-01` → "Crew member not found"

**Medical Officer (`medofficer`, `medbackup`)**

- [ ] `#/physical` and `#/wellbeing` show a crew picker: names and crew IDs only
- [ ] `#/physical/AH-04`: Jonas Reyes, read-only, links to crew detail / shared wellbeing / picker; focus on the name after choosing from the picker
- [ ] `#/wellbeing/AH-01`: only shared check-ins ("Shared by the astronaut"), summary "Based only on check-ins shared by the astronaut.", the notice "Private check-ins and the private journal are never shown or counted.", no form
- [ ] A shared check-in the astronaut just saved appears; a private one never appears and isn't counted (Haddad's seeded private days Nov 10, Nov 3, Oct 26 are absent)
- [ ] `#/physical/AH-99`, `#/physical/a-04`, `#/wellbeing/ah-01`, `#/wellbeing/AH-01/x` → "Crew member not found"; refresh on `#/wellbeing/AH-03` keeps Mei Chen

**General**

- [ ] 1440 / 768 / 375 px: reading cards 4 / 2 / 1 columns; trend tables become one block per day at 375 px; no horizontal scrolling
- [ ] Keyboard only: Tab reaches each radio group, Space selects, Enter submits, the confirmation is reachable and focused, the saved message receives focus
- [ ] Accessibility pane: 7 named groups (fieldsets) and their radios; status/alert regions
- [ ] Offline (after one online visit): reload and save a check-in → saved locally; no console errors; no request to another host

**Results — 2026-11-14 (headless Chrome via DevTools Protocol, fresh profile):**
12/12 Sprint 6 checks passed — Reyes physical (own data, baseline wording, 7→30 toggle, ALT-0190, 3 nested URLs → not found); Haddad validation (6 errors, summary focused, answers kept); private check-in with same-day confirmation (one record + one score-free event `{shared:0}`); shared check-in with share + same-day confirmation (triple click → exactly one record, event `{shared:1}`, no scores); Medical Officer pickers, `#/physical/AH-04` (focus on name), `#/wellbeing/AH-01` (28 shared shown incl. the new one, 4 private hidden, count matches IndexedDB); 4 bad IDs → not found, nested refresh; 1440/768/375 px (4/2/1 columns, no overflow); keyboard-only check-in (fresh tab); accessibility tree (7 named groups, 50 radios); offline save. No console errors, no external requests.
Not yet checked: a real screen reader, Firefox, Safari.

## 11. Simulation Center (Sprint 7, `#/simulation`)

Run `python3 -m http.server 8080`, open <http://localhost:8080/login.html>, and
reload once so the current service worker cache `astrohealth-v0.8.0` takes over.
All data is synthetic. Sprint 7 shipped without risk evaluation; **since
Sprint 8**, after each generated reading the demonstration risk rules are
evaluated for that crew member and may open, escalate or clear an alert
(section 12).

**Astronaut** (`haddad`)

- [ ] No Simulation Center in the sidebar; typing `#/simulation` → **Access denied** (no simulation request made)

**Medical Officer** (`medofficer`, `medbackup`)

- [ ] Header "Simulation Center", SIMULATED tag, synthetic-data notice, disclaimer (not a medical device, not clinically validated, not affiliated with or endorsed by NASA)
- [ ] Notes: "After each generated reading, the demonstration risk rules (PHY-01 heart rate, PHY-02 SpO₂, PHY-03 systolic blood pressure, PHY-05 sleep) are evaluated for that crew member. Demonstration threshold — not clinically validated. Alerts are reviewed on the Alerts page." and "The simulation advances only while this page is open. Background tabs may be delayed."
- [ ] After each step: "Risk evaluation after step N: …" (no alert changed / ALT-nnnn opened, escalated, updated, condition cleared, with a link); a failed evaluation says "Risk evaluation unavailable after step N. The reading was saved…"
- [ ] New run: crew select, Scenario fieldset with two radios (Low oxygen saturation demonstration, Elevated heart rate demonstration), speed select (1×, 2×, 4×, 8× with total duration); Start stays disabled and says why
- [ ] Choosing AH-03 + low oxygen previews 95 93 92 90 88 88 88 90 92 93 95 97 % (from the stored baseline 97 %); changing the selection clears the confirmation
- [ ] Tick the confirmation → Start → "Active run", Running, `<progress>` "Step 0 of 12"; the screen reader hears "Simulation started for Mei Chen." once, not every step
- [ ] Steps arrive every 8 / 4 / 2 / 1 s (1× / 2× / 4× / 8×); readings table and bars grow; each value is labelled Simulated; timeline lists Started, Reading generated…
- [ ] Pause → Paused, no more readings; "Advance one step" disabled with a reason; Resume continues from the next step
- [ ] Stop → confirmation panel ("Stop this simulation?"); "Keep the run" returns focus to Stop; "Stop simulation" ends it at the current step
- [ ] After 12 steps: Completed (Last run), the final value equals the start value; the new-run form returns; Recent runs lists it
- [ ] While a run is active, starting another (other tab / `medbackup`) → "Another simulation is already active…" and no second run
- [ ] Refresh mid-run (wait > 3 intervals + 5 s) → "Not advancing — the page may have been closed"; no missed steps filled in; Continue / Pause / Stop work
- [ ] Two tabs on the same run: never two readings for the same step (they may advance faster together — known limitation)
- [ ] Links: `#/physical/AH-03` and `#/crew/AH-03` show the new readings with "Simulated · Simulation Center"; the astronaut's own Overview too; alerts change only through the Sprint 8 risk rules (AH-03 low oxygen → one PHY-02 alert, see section 12)
- [ ] Leaving the page during a run writes nothing (run stays Running, no auto-pause)
- [ ] 1440 / 768 / 375 px, no horizontal scrolling; keyboard only (Tab, Space/Enter, arrow keys in the radio group) with a visible focus ring; reduced motion stops bar transitions
- [ ] Offline (after one online visit): the page loads and runs locally; no console errors; no request to another host

**Results — 2026-11-14 (headless Chrome via DevTools Protocol, fresh isolated profiles):**

> Historical — Sprint 7 release (app version 0.6.0), before the Sprint 8 risk
> engine. "Alerts unchanged" was the expected Sprint 7 behaviour; since
> Sprint 8 the low-oxygen run opens a PHY-02 alert.

- Sprint 7: 11/11 passed.
- Full deterministic 12-step low-oxygen run.
- Exact sequence: `95 93 92 90 88 88 88 90 92 93 95 97`.
- Latest reading and daily summary updated.
- 14 simulation events.
- Alerts unchanged.
- Alert-action records unchanged.
- Pause, refresh, resume, and confirmed stop persisted.
- No reading written while paused.
- No backfill while away from the page.
- Two-tab duplicate-step prevention passed.
- Concurrent start created only one active run.
- Cross-dashboard “Simulated · Simulation Center” provenance passed.
- Astronaut Access Denied passed with no simulation write.
- 375px and 768px had no page-level horizontal overflow.
- Keyboard and accessibility checks passed.
- Offline reload and manual step passed.
- No console errors.
- No external requests.

Completed regression suites, each using an isolated fresh browser profile and database:

- Login: 15/15.
- Database: 32/32.
- Sprint 4: 15/15.
- Sprint 5: 14/14.
- Sprint 6: 12/12.

- Not yet checked with a real screen reader, Firefox, or Safari.

## 12. Risk Engine and Alerts (Sprint 8, `#/alerts`)

Run `python3 -m http.server 8080`, open <http://localhost:8080/login.html>, and
reload once so the current service worker cache `astrohealth-v0.8.0` takes over.
All data is synthetic. The rules use the stored demonstration thresholds —
**not clinically validated**, not evidence-backed, not NASA thresholds — and
every alert screen says "Demonstration threshold — not clinically validated."

**Medical Officer — Simulation Center → alert** (`medofficer`)

- [ ] `#/simulation`: start AH-03 + low oxygen. Step 3 (93, 92 %) → "ALT-0191 Low SpO₂ · warning · opened"; step 5 (90, 88 %) → "escalated" to critical; steps 6–10 "updated"; step 11 no change; step 12 (95, 97 %) → "condition cleared". The values are still 95 93 92 90 88 88 88 90 92 93 95 97
- [ ] The same ALT-0191 (critical) appears in Chen's Overview, the Medical Officer Overview queue, the Crew Monitor list and `#/crew/AH-03`, `#/physical/AH-03` (open physical alerts) and `#/alerts` (first, critical)

**Medical Officer — `#/alerts`**

- [ ] List: Filters (Status: Open / New / Acknowledged / Resolved / All; Severity; Crew member) and "Evaluate crew now"; nothing is evaluated just by opening the page
- [ ] "Evaluate crew now" on fresh seed data → "Evaluated 4 crew members. No alert changed." (ALT-0190 is recognised, not duplicated)
- [ ] Detail `#/alerts/ALT-0191`: severity + status + "Condition cleared" badges (icon + text), Summary, "Why this alert" (explanation, rule PHY-02 version 1, threshold used, demonstration label, limitation), Evidence table (SpO₂ values, UTC times, Simulated, Quality OK — no internal ids), Last evaluation (examined / not used), Suggested review, Audit trail (Created, Escalated, Condition cleared by System)
- [ ] Acknowledge → "Alert acknowledged."; status Acknowledged; audit trail adds "Acknowledged · Dr. Lena Ortiz"
- [ ] Resolve stays disabled until a note is written (and, if the condition is still present, the confirmation is ticked); notes over 500 characters are refused; Resolve → "Alert resolved."; the alert is kept as history with no further actions
- [ ] Seeded alerts stay readable: ALT-0190 evidence shows "Not recorded (older alert)" for source/quality; ALT-0189 (WB-01) evidence shows "Not shown (wellbeing score)"; both can be acknowledged/resolved

**Astronaut** (`chen`, then `haddad`)

- [ ] `chen` `#/alerts`: own alerts only (ALT-0191 resolved, ALT-0189); no filters, no "Evaluate crew now", no Acknowledge/Resolve; "This view is read-only"
- [ ] `chen` `#/alerts/ALT-0191`: status Resolved, audit-trail labels and UTC times, but **no** resolution note and no acknowledgement/action notes (Medical Officer notes are internal; the Medical Officer still sees them)
- [ ] `haddad` `#/alerts/ALT-0191` → "Alert not found" (same as an unknown number); `#/alerts/garbage` → "Alert not found"

**General**

- [ ] Two tabs pressing "Evaluate crew now" / acknowledging at once never create a duplicate alert or audit record
- [ ] Offline (after one online visit): reload `#/alerts/ALT-0191` → the lifecycle (acknowledged / resolved) is still shown; no request to another host
- [ ] 1440 / 768 / 375 px, no horizontal page scrolling (evidence table becomes one block per reading at 375 px); keyboard only with a visible focus ring; screen reader hears "Alert acknowledged." / "Alert resolved." / opened and escalated alerts once

**Results — 2026-11-14 (headless Chrome via DevTools Protocol; every suite in its own new browser profile and IndexedDB database, run on the final Sprint 8 working tree):**

- Sprint 8: 11/11 passed.
- Regression suites: Login 15/15 · Database 32/32 · Sprint 4 15/15 · Sprint 5 14/14 · Sprint 6 12/12 · Sprint 7 11/11 (harness expectations updated only for intended Sprint 8 changes: cache `astrohealth-v0.7.0`, `#/alerts` is the Alerts page, the Sprint 7 low-oxygen run now opens one PHY-02 alert while seeded alerts and their audit records stay unchanged).
- AH-03 low-oxygen simulation at 8×: `95 93 92 90 88 88 88 90 92 93 95 97`; ALT-0191 (PHY-02) opened as warning at step 3, escalated to critical at step 5, condition cleared at step 12; the critical explanation (88 %, 90 %) was kept through the lower-tier re-triggers; the alert stayed open until acknowledged.
- Acknowledge, then resolve with a note: 5 audit records (created, escalated, condition cleared, acknowledged, resolved); the Medical Officer sees the resolution note. ALT-0190 (condition still present) resolved only with a note plus confirmation.
- Cross-dashboard: the same ALT-0191 in the Medical Officer queue, Crew Monitor list and AH-03 detail, Physical Health (critical) and first on `#/alerts`.
- Astronaut privacy: Chen sees ALT-0191 resolved and read-only, with no resolution note on the page or in her own service output; Haddad gets "Alert not found" for ALT-0191.
- Two tabs: concurrent "Evaluate crew now" opened one alert (ALT-0192); concurrent acknowledge wrote one audit record (one "acknowledged", one "unchanged"). The later evaluation also opened ALT-0193 (PHY-05) as a new occurrence after ALT-0190 had been resolved with its condition still present; ALT-0190 was untouched.
- Opening `#/alerts` wrote nothing; "Evaluate crew now" ran only when pressed.
- Offline reload (cache `astrohealth-v0.7.0`) kept the resolved lifecycle on `#/alerts/ALT-0191`.
- 375 / 768 / 1440 px: no page-level horizontal overflow on the list and detail; keyboard only: Tab + Enter acknowledge, typed note, Space confirmation, Enter resolve; accessibility tree: 3 named filters, "Evaluate crew now" button, alert links, headings, evidence table, status region.
- No console errors. No external requests.
- Not yet checked: a real screen reader, Firefox, Safari.

## 13. Health History, Reports and Settings (Sprint 9)

Run `python3 -m http.server 8080`, open <http://localhost:8080/login.html>, and
reload once so the current service worker cache `astrohealth-v0.8.0` takes over.
All data is synthetic. Sprint 9 writes nothing to the database.

**Health History (`#/history`)**

- [ ] `haddad`: "Your health history", 7 / 14 / 30-day range (aria-pressed), "Show" category checkboxes, entries grouped by UTC day, newest first, UTC `<time>`; includes "Daily check-in completed · private" (no score) and ALT-0181 lines linking to `#/alerts/ALT-0181`
- [ ] No scores, message text, response text, alert explanations or notes anywhere; vital-sign batches say "Source not recorded"; simulated readings say "Simulated · Simulation Center"
- [ ] More than 100 activities → "Show older (N more)" reveals the next 100 without reloading; more than 500 → "Showing the latest 500 activities for this range."
- [ ] `haddad` `#/history/AH-01` → "Crew member not found"
- [ ] `medofficer` `#/history` → crew picker; `#/history/AH-01` → shared check-ins only, no "private" line and nothing hinting one exists; `#/history/AH-99` and `#/history/a-01` → not found

**Reports (`#/reports`)**

- [ ] `haddad`: "Health summary · AH-01", disclaimer ("Synthetic data · research and educational prototype · not a medical device · …"), physical table (days with data, missing days, average of daily averages, min, max, difference from stored baseline), alerts in the period with "Demonstration threshold — not clinically validated.", activity counts, provenance (last 7 days), "Not included in this report" list; 30 days → "Source breakdown is unavailable for this period." for the older dates
- [ ] "Print report" opens the browser print dialog only when pressed; the preview shows only the report (no sidebar, top bar or buttons)
- [ ] `medofficer`: crew summary (open alerts by severity, latest vital-sign time, days with data, shared check-ins) and per-crew links; `#/reports/AH-01` shows "Shared daily check-ins" only (no total)
- [ ] Nothing is stored: no new record in IndexedDB `reports`, no new `missionEvents`

**Settings (`#/settings`)**

- [ ] Text size (Standard / Large / Larger) and Motion (Follow system setting / Reduce motion) apply immediately, survive a reload, update a second open tab, and are separate per user on this browser; "Reset my display preferences" resets only the signed-in user
- [ ] Mission and Units are read-only; `medofficer` also sees "Demonstration risk thresholds (read-only)" with "Demonstration thresholds — not clinically validated." and the simulation default speed; `haddad` doesn't
- [ ] With site storage blocked: the choice applies to this tab with the notice "…applies to this tab only."

**General**

- [ ] Offline (after one online visit): all three pages load; keyboard only with a visible focus ring; 1440 / 768 / 375 px without horizontal page scrolling; no console errors; no request to another host

**Results — 2026-11-14 (headless Chrome via DevTools Protocol; every suite in its own new browser profile and IndexedDB database, run on the Sprint 9 working tree):**

- Sprint 9: 11/11 passed.
- Regression suites: Login 15/15 · Database 32/32 · Sprint 4 15/15 · Sprint 5 14/14 · Sprint 6 12/12 · Sprint 7 11/11 · Sprint 8 11/11 (harness expectations updated only for intended Sprint 9 changes: cache `astrohealth-v0.8.0`; `#/history`, `#/reports` and `#/settings` are real pages, so the late-result checks now confirm the History page instead of a placeholder).
- History: `haddad` (30 days) sees only his own activity, "Daily check-in completed · private" without scores, ALT-0181 lines linked to `#/alerts/ALT-0181`, "Source not recorded" on vital-sign batches; `#/history/AH-02` → not found. `medofficer` picker → `#/history/AH-01` shows the same 27 shared check-in lines and no private line; `#/history/AH-99` and `#/history/a-01` → not found. After an AH-03 low-oxygen simulation: "Simulation started", simulated readings, "ALT-0191 Low SpO₂ opened (warning)", "escalated to critical", "Simulation stopped", labelled "Simulated · Simulation Center". No IDs, scores, message text or notes in the page HTML.
- Reports: the same service call with the same time gave identical models; crew summary with 4 crew members; `#/reports/AH-01` shows shared check-ins only; the astronaut report shows the disclaimer, exclusions, provenance rows (including "Source not recorded") and, for 30 days, "Source breakdown is unavailable for this period."; with print media emulated, the sidebar, top bar and controls are hidden and only the report shows. The `reports` store stayed empty and `settings` unchanged for the whole suite.
- Preferences: "Larger" applied (body text 17.5 px), synchronized to a second tab, persisted after reload, stored as `{ textSize, motion }` per user only; `chen` started at the defaults and her reset left Haddad's entry untouched; with storage blocked the choice applied to the tab with the notice "…applies to this tab only."; astronauts see no thresholds.
- Offline reload (cache `astrohealth-v0.8.0`): History, Reports and Settings all loaded.
- Keyboard only: arrow key changed the text-size radio, Tab + Enter changed the history range; accessibility tree: "Date range" and "Show" groups, 5 category checkboxes, "Text size" and "Motion" radio groups (5 radios), 4 report tables and headings; 375 / 768 / 1440 px without page-level horizontal overflow.
- No console errors. No external requests.
- Not yet checked: a real screen reader, Firefox, Safari, or printing to paper (print media was emulated).

## 14. Release candidate — integration and competition readiness

- [ ] Run `npm ci`, `npm run build:sw`, `npm run test:unit`, `npm run check:offline`, `npm run test:e2e` and `git diff --check` from a clean checkout.
- [ ] Run `npm run build:sw` a second time and confirm the generated manifest is unchanged.
- [ ] Confirm APP_VERSION, CACHE_VERSION and package version are `0.9.0`; DB_VERSION remains `1`.
- [ ] Confirm home, About, sign-in and authenticated routes have no broken local links, console errors or external runtime requests.
- [ ] Confirm disclaimers consistently say synthetic data, research/education, not a medical device, not clinically validated, and no NASA affiliation or endorsement.
- [ ] Sign in as Medical Officer; type `RESET DEMO`; confirm the reset is atomic, all app tabs sign out, the one-time notice appears, and seed data is restored.
- [ ] Confirm an astronaut cannot see or trigger reset, and wrong confirmation text performs no write.
- [ ] Execute the complete demo in `docs/DEMO.md`, including simulation → explainable alert → acknowledge → resolve → astronaut privacy.
- [ ] Check keyboard-only operation, visible focus, 375 / 768 / 1440 px layouts, offline reload after one online visit, and print preview.
- [ ] Capture current screenshots from the running app; verify `docs/screenshots/` is not in the precache manifest.
- [ ] Record Firefox, Safari, a real screen reader and physical printing as passed only when actually tested.
