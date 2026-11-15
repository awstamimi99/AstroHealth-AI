# AstroHealth AI

**Autonomous health risk detection and response during communication-limited space missions.**

AstroHealth AI is a web app for monitoring astronaut health when the crew
can't count on a live link to Earth. The frontend runs in the browser and
keeps its data on the device in IndexedDB. It is **online-capable**, so
specific features may call an approved API, and it has **optional offline
support** through a service worker. Core monitoring features run locally; the
optional Gemini assistant uses the small Node proxy documented below. A Python
(FastAPI) API may be added later for other specific jobs.

A student project for the NASA Space Apps Challenge, by team **RSS AstroMinds**.

> ⚠️ **Research & educational prototype · Not a medical device · Not affiliated
> with or endorsed by NASA · All health data synthetic.**
> Do not use it to make real medical decisions.

All astronaut health, medical, mission and simulation records in the app are
synthetic. Real astronaut health or medical records are never used. Verified
public NASA resources and research references may be real and are always
clearly attributed. Citations are never invented.

## Requirements

| Tool | Needed for |
| --- | --- |
| git | getting the code |
| python3 | running the local web server (any static server works) |
| Node.js 24 and npm | setup/tests, and runtime only for the optional AI proxy |

No Python packages are needed yet. If a Python API is added, its setup will
be documented here together with that feature.

## Run it

```bash
# one-time setup (only needed if you change dependencies or icons;
# vendor/ and assets/fonts/ are already committed)
npm install
npm run setup

# every time
npm run serve          # same as: python3 -m http.server 8080
```

Then open **<http://localhost:8080>**.

**Don't open the HTML files directly** (double-clicking gives a `file://`
URL). Service workers, ES modules and IndexedDB need a real server — the app
shows a warning bar if you try.

### While developing: avoid stale files

The service worker is **cache-first**, so after the first visit the browser
serves the cached copy of every file — your edits won't show up on reload.
In Chrome/Edge DevTools → **Application → Service Workers**, tick
**"Update on reload"** (or **"Bypass for network"**) while you work.
For a release, bump `CACHE_VERSION` in `sw.js` and `APP_VERSION` in
`js/core/config.js` so every device downloads the new files.

### npm scripts

| Script | What it does |
| --- | --- |
| `npm run setup` | Copies Chart.js + fonts into the repo, builds the icon set, brand files and the service-worker file list |
| `npm run serve` | Starts `python3 -m http.server 8080` |
| `npm run build:sw` | Regenerates `js/core/precache-manifest.js` — run after adding/removing files |
| `npm run check:offline` | Fails if the static frontend contains a remote `http(s)://` URL (only `data/references.json` is exempt). Run before every PR (see below) |
| `npm run test:unit` | Runs the Node unit tests in `tests/unit/` |
| `npm run test:e2e` | Runs the local headless-Chrome release smoke test (set `CHROME_BIN` outside macOS) |
| `npm run test:release` | Rebuilds the cache manifest, then runs unit, offline and browser-smoke checks |
| `npm run build:brand` | Regenerates the logo SVGs and PNG app icons |

## Folder map

```
index.html  about.html      Landing + about pages
login.html  app.html        Sign-in + authenticated app
manifest.webmanifest        PWA manifest
sw.js                       Service worker (offline cache)

css/
  tokens.css                Design tokens — colours, type, spacing (SHARED)
  base.css                  Fonts, reset, focus, a11y helpers   (SHARED)
  layout.css                App shell: sidebar, topbar, content (SHARED)
  components.css            Buttons, cards, badges, forms, …    (SHARED)
  print.css                 Printable reports                   (SHARED)
  pages/                    One file per page

js/
  app.js                    Bootstrap loaded by every page
  sw-register.js            Registers sw.js, exposes offline status
  core/                     config, event bus, environment check, utils (SHARED)
  components/icon.js        icon("name") → inline SVG             (SHARED)
  auth/ db/ services/ engine/ simulation/ pages/

vendor/                     Chart.js + Lucide icons, copied from npm
assets/                     fonts/, brand/, app-icons/, images/
data/                       team.json, references.json
scripts/                    Dev-time Node scripts (not shipped)
tests/browser/styleguide.html   ★ Every component, live
tests/manual/checklists.md  Manual QA checklists
docs/                       ARCHITECTURE.md, LICENSES.md
```

## Online, offline and API rules

Full policy: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (sections *API
policy*, *Python policy*, *Offline policy*, *check:offline scope*).

1. **No CDNs, no Google Fonts, no remote images/scripts/styles, no analytics.** Frontend assets live in this repo.
2. **APIs only when approved.**
   - Called from services through `js/core/api.js`.
   - HTTPS in production, `localhost` in development.
   - Pages never call APIs or database repositories directly.
   - Every online feature shows loading, handles timeouts and being offline, gives a clear error, and never shows invented data when a call fails.
   - No secrets in frontend code; passwords, hashes, salts, session objects and private journals are never sent.
3. **IndexedDB stays the primary data store.** An API computes things; it does not replace the database.
4. **Python only when a feature needs it**, as a small FastAPI service. There is no Python backend or Python dependency yet.
5. **Offline is optional but kept.** The service worker still caches the frontend. Online-only features must say so when offline.
6. npm is used **only** at development time; vendor files and fonts are copied into `vendor/` and `assets/fonts/` and committed. `node_modules/` is never needed to run the app.
7. Run `npm run check:offline` before every PR. It guards the static frontend against remote assets and unapproved URLs, and exempts only `data/references.json` (reference links shown to readers). It has **no API allowlist yet**: any remote URL in runtime code fails today. A narrow allowlist is added with the first approved endpoint.
8. Added, renamed or deleted a file? Run `npm run build:sw` so the service worker caches it.

## For contributors

- 👉 **[CONTRIBUTING.md](CONTRIBUTING.md)** — solo-project governance, branches, PR rules.
- 👉 **[AGENTS.md](AGENTS.md)** — strict rules for future AI-assisted sessions (safety rules, API and Python policy).
- 👉 **[Style guide](tests/browser/styleguide.html)** — open <http://localhost:8080/tests/browser/styleguide.html> and copy markup from there.
- 👉 **[Architecture](docs/ARCHITECTURE.md)** and **[Licences](docs/LICENSES.md)**.
- 👉 **[Demo guide](docs/DEMO.md)** — demo accounts, reset procedure and presentation flow.

## Reference data

`data/references.json` contains objects with `id`, `title`, `authors`,
`publisher`, `year`, `url`, `accessed`, and `verified`. Never invent citations.
New sources start with `"verified": false` and stay unverified until their
details have been checked against the real source (by the owner, while the
project is solo).

# Gemini AI Assistant (optional)

The dashboards work without an AI service. To enable the **AI Assistant**
(sidebar → AI Assistant), copy `.env.example` to `.env`, set
`GEMINI_API_KEY`, then run — instead of `npm run serve`:

```bash
npm run serve:ai
```

Open `http://localhost:8080` (stop any other server on port 8080 first, or
set `PORT`). With the Python server the AI page shows "AI server not
running". Never commit `.env` or place an API key in frontend JavaScript.
