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

## 5. Print (Team 1 reports)

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
(cache `astrohealth-v0.4.0`) takes over. If the mission chips show
"Not available", the browser holds data seeded before the `mission` setting
existed: run `resetDatabase()` or clear site data.

**Astronaut** (`haddad` / `demo`)

- [ ] Lands on `#/overview`; top bar shows "Cmdr. Sami Haddad", "Astronaut", "SH"
- [ ] Top bar shows **Mission ODYSSEY-7** and **Mission Day 147** on the seed day (from the synthetic seed, not hardcoded)
- [ ] Bell is a plain link to Alerts with **no** number on it
- [ ] Sidebar has 7 items; **Crew Monitor** and **Simulation Center** are not shown
- [ ] Each item except Overview opens its placeholder: icon, title, "will be completed in a later sprint" (no numbers, charts, forms or alerts). Overview is the Sprint 4 Astronaut Overview (section 8)
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
- [ ] `#/simulation` (Simulation Center) still opens its placeholder (no Access denied)
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
`astrohealth-v0.4.0` takes over. All data is synthetic seed data; values are relative to the moment
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
- [ ] Quick links go to `#/physical`, `#/wellbeing`, `#/history`, `#/alerts` and those pages show their placeholders

**Routing by role (current, since Sprint 5)**

- [ ] Astronaut `#/overview` is this Sprint 4 Astronaut Overview, unchanged
- [ ] Medical Officer `#/overview` delegates to the Sprint 5 Medical Officer dashboard — it never shows an astronaut's personal Overview. Verify the Medical Officer workflow with section 9.

**States**

- [ ] Stale: view a database seeded on an earlier day → cards show "No newer reading" and the real age (e.g. "3 d ago"); values are not hidden or zeroed
- [ ] Section failure (DevTools console, then go to `#/history` and back to `#/overview`):
      `const o = IDBObjectStore.prototype.index; IDBObjectStore.prototype.index = function (n) { if (n === "by_astronaut_status") throw new DOMException("x", "UnknownError"); return o.call(this, n); }`
      → Alert status "Status unavailable", Open alerts "Couldn't load your alerts." + Retry; other sections still show. Then run `IDBObjectStore.prototype.index = o` and press Retry → normal status returns
- [ ] Navigate to `#/overview` and immediately to `#/history` → the Health History placeholder stays (no late Overview content)

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
reload once so the service worker cache `astrohealth-v0.4.0` takes over. All
data is synthetic seed data.

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
