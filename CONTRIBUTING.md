# Contributing to AstroHealth AI

Two teams build on one shared foundation. This file says who owns what and
how changes get in.

## Team ownership

| Area | Owner | Files |
| --- | --- | --- |
| **Authenticated app** | **Team 1** | `login.html`, `app.html`, `js/auth/`, `js/services/`, `js/engine/`, `js/simulation/`, `js/pages/` (app pages), `css/pages/` (app pages) |
| **Public site + database** | **Team 2** | `index.html`, `about.html`, `css/pages/landing.css`, `css/pages/about.css`, `js/pages/landing.js`, `data/team.json`, `data/references.json`, `assets/images/`, `js/db/` |
| **Shared foundation** | **Both** — PR needs **one reviewer from each team** | `css/tokens.css`, `css/base.css`, `css/layout.css`, `css/components.css`, `js/components/`, `js/core/`, `assets/fonts/`, `assets/brand/`, `vendor/`, `sw.js`, `manifest.webmanifest`, `docs/DATA-MODEL.md` |

Need a new shared component? Add it to `css/components.css` **and** to
`tests/browser/styleguide.html` in the same PR.

## Team contract

- The landing page's **"Launch Dashboard"** button links to `login.html`.
- The session lives in `localStorage["astrohealth.session"]` (`SESSION_KEY` in `js/core/config.js`).
  - **Only Team 1 writes it** (login/logout in `js/auth/`).
  - **Team 2 may only read it** (e.g. to show "Continue to dashboard").
- Team 2 documents stores, fields, keys, indexes, and exact repository function
  signatures in `docs/DATA-MODEL.md` before implementing IndexedDB. A Team 1
  reviewer must approve database schema PRs.
- Repositories only read and write data. Team 1 services own permissions,
  validation, timeline logging, risk rules, and events.
- Until the real database is merged, Team 1 may use
  `js/db/mock-repositories.js` with the documented repository signatures.
- Every page keeps the footer disclaimer:
  *Research & educational prototype · Not a medical device · Not affiliated with or endorsed by NASA · All health data synthetic.*

## Workflow

1. Never push to `main` directly.
2. Branch from `main`:
   - Team 1: `team1/<task>` — e.g. `team1/login-form`
   - Team 2: `team2/<task>` — e.g. `team2/landing-hero`
3. Keep PRs **small** (one page section / one feature).
4. Open a PR using the template; **at least 1 review** before merging
   (shared files: one reviewer from each team; database schema changes also
   require a Team 1 reviewer).
5. Before every PR:
   ```bash
   npm run test:unit         # must pass
   npm run check:offline     # must pass (static frontend: no remote assets)
   npm run build:sw          # if you added/removed/renamed files
   ```
   and go through `tests/manual/checklists.md` for the pages you touched.

### Commit messages

Short, imperative, prefixed with the area:

```
landing: add hero section with launch button
auth: store session after successful login
tokens: add --color-info-tint
fix(sidebar): close drawer on Escape
```

## Code rules

- **No hard-coded colours.** Use tokens: `color: var(--color-text-2);` — never `#A4ACB9`.
  Same for spacing, radii, font sizes and z-index.
- **Orange = brand/interaction only.** Never use orange to mean "warning".
  Every status shows **colour + icon + text**.
- **No remote assets** in HTML/CSS/JS: no CDNs, Google Fonts, remote images, scripts, styles or analytics.
- **APIs only under the API policy** in `docs/ARCHITECTURE.md`:
  - approved endpoints only, called by `js/services/` through `js/core/api.js` (pages never call APIs or repositories directly);
  - HTTPS in production, `localhost` in development;
  - loading, timeout, offline and clear error states;
  - no fabricated data on failure;
  - never send passwords, hashes, salts, the session or private journal text.
- **IndexedDB stays the primary data store.** Don't move data to a server or break the `js/db/index.js` API.
- **Python** only when a feature needs it, as a small FastAPI service (see the Python policy). There is no Python backend or dependency yet.
- **Offline support is optional but kept.** Don't remove the service worker; online-only features must say so when offline.
- **No untrusted strings in `innerHTML`.** Build DOM with `el()` from `js/core/utils/dom.js`.
- Vanilla JS ES modules (`<script type="module">`), no frameworks, no bundler. The UI is never rewritten in Python.
- Keep code simple and commented — other students need to read it.
- Icons: `icon("name")` from `js/components/icon.js`. Missing icon? Add the name
  to `scripts/build-icons.mjs`, run `npm run setup`, commit `vendor/lucide/icons.js`.
- All astronaut health, medical, mission and simulation records are synthetic; real astronaut health or medical records are never permitted. Synthetic data must be visibly labelled with `.sim-tag`.
- Verified public NASA resources and research references may be real, and must be clearly attributed.
- Citations in `data/references.json`: never invented; new entries start `"verified": false`
  (see `docs/ARCHITECTURE.md`).
