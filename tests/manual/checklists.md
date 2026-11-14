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
If you visited before this sprint, reload once so the new service worker
(cache `astrohealth-v0.2.0`) takes over. If the mission chips show
"Not available", the browser holds data seeded before the `mission` setting
existed: run `resetDatabase()` or clear site data.

**Astronaut** (`haddad` / `demo`)

- [ ] Lands on `#/overview`; top bar shows "Cmdr. Sami Haddad", "Astronaut", "SH"
- [ ] Top bar shows **Mission ODYSSEY-7** and **Mission Day 147** on the seed day (from the synthetic seed, not hardcoded)
- [ ] Bell is a plain link to Alerts with **no** number on it
- [ ] Sidebar has 7 items; **Crew Monitor** and **Simulation Center** are not shown
- [ ] Each item opens its placeholder: icon, title, "will be completed in a later sprint" (no numbers, charts, forms or alerts)
- [ ] The active item has `aria-current="page"`; the page heading and browser tab title change; the page does not reload
- [ ] After choosing a route, focus is on the page heading (screen reader announces it)
- [ ] Type `#/crew` (and `#/simulation`, `#/crew/AH-01`) → **Access denied**: lock icon, "available to the Medical Officer role only. You are signed in as Astronaut.", "Go to Overview" link, focus on the heading
- [ ] Type `#/admin`, `#/`, `#/Crew` → silently replaced with `#/overview`; Back does not return to the bad URL
- [ ] Reload on `#/reports` → still signed in, still on Reports
- [ ] Log out → `login.html`; IndexedDB `astrohealth` still has its data

**Medical Officer** (`medofficer` / `demo`)

- [ ] Lands on `#/overview`; "Dr. Lena Ortiz", "Medical Officer", "LO"
- [ ] 9 sidebar items; Crew Monitor and Simulation Center visible with the "MO" tag
- [ ] Both open their normal placeholder (no Access denied)
- [ ] Log out → `login.html`

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
Returning browsers: reload once so the service worker cache `astrohealth-v0.3.0`
takes over. All data is synthetic seed data; values are relative to the moment
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

**Medical Officer** (`medofficer`)

- [ ] `#/overview` shows "Medical Officer overview" with links to Crew Monitor and Alerts only — no astronaut names, crew IDs, alerts or readings

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

**Results — 2026-11-14 (headless Chrome via DevTools Protocol, fresh profile, seeded 14:15 UTC):**
15/15 checks passed — the four astronauts above (status, alerts, messages, no leakage, labels, UTC times, banned wording), refresh + other routes still placeholders + quick links, late-result guard, Retry after an induced alerts failure, keyboard (fresh tab; 5/5 Overview targets with focus ring; drawer skipped at 375 px), accessibility tree (one h1, 8 ordered h2, 4 named vital cards), 1440/768/375 px (4/2/1 columns, no overflow), Medical Officer placeholder, signed-out `#/overview` → login → back, offline reload (cache `astrohealth-v0.3.0`). No console errors, no external requests.
Not yet checked: a real screen reader (VoiceOver/NVDA), Firefox, Safari.
