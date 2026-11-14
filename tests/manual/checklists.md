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
