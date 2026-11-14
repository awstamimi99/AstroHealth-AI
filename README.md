# AstroHealth AI

**Autonomous health risk detection and response during communication-limited space missions.**

AstroHealth AI is an offline-first web app for monitoring astronaut health when
the crew can't count on a live link to Earth. It runs entirely in the browser,
stores everything on the device, and keeps working with no network at all.

A student project for the NASA Space Apps Challenge, by team **RSS AstroMinds**.

> ⚠️ **Research & educational prototype · Not a medical device · Not affiliated
> with or endorsed by NASA · All health data synthetic.**
> Do not use it to make real medical decisions.

## Requirements

| Tool | Needed for |
| --- | --- |
| git | getting the code |
| python3 | running the local web server (any static server works) |
| Node.js 18+ and npm | **only** for setup scripts — never at runtime |

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
| `npm run check:offline` | Fails if any runtime file references a remote `http(s)://` URL — run before every PR |
| `npm run build:brand` | Regenerates the logo SVGs and PNG app icons |

## Folder map

```
index.html  about.html      Landing + about pages            (Team 2)
login.html  app.html        Sign-in + authenticated app      (Team 1)
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
  auth/ db/ services/ engine/ simulation/ pages/   (Team 1, + Team 2's landing.js)

vendor/                     Chart.js + Lucide icons, copied from npm
assets/                     fonts/, brand/, app-icons/, images/
data/                       team.json, references.json          (Team 2)
scripts/                    Dev-time Node scripts (not shipped)
tests/browser/styleguide.html   ★ Every component, live
tests/manual/checklists.md  Manual QA checklists
docs/                       ARCHITECTURE.md, LICENSES.md
```

## Offline rules

1. **No CDNs, no Google Fonts, no remote images/scripts/styles.** Everything lives in this repo.
2. npm is used **only** at development time to download packages; files are copied into `vendor/` and `assets/fonts/` and committed. `node_modules/` is git-ignored and never needed to run the app.
3. Run `npm run check:offline` before every PR — CI-style guard against remote URLs.
4. Added, renamed or deleted a file? Run `npm run build:sw` so the service worker caches it.

## For contributors

- 👉 **[CONTRIBUTING.md](CONTRIBUTING.md)** — team ownership, branches, PR rules.
- 👉 **[Style guide](tests/browser/styleguide.html)** — open <http://localhost:8080/tests/browser/styleguide.html> and copy markup from there.
- 👉 **[Architecture](docs/ARCHITECTURE.md)** and **[Licences](docs/LICENSES.md)**.
