# Contributing to AstroHealth AI

AstroHealth AI is a **solo project**, owned and maintained by
**awstamimi99**. There are no Team 1 / Team 2 roles and no cross-team review
requirements. The owner may work across every area of the repository. Branch
names such as `team1/*` and `team2/*` are historical only.

GitHub collaborator permissions are managed in the repository settings, not
in these documents.

## Areas of the repository

| Area | Files | Extra care |
| --- | --- | --- |
| **Authenticated app** | `login.html`, `app.html`, `js/auth/`, `js/services/`, `js/engine/`, `js/simulation/`, app files in `js/pages/` and `css/pages/` | Role and route rules (canonical roles only) |
| **Public site** | `index.html`, `about.html`, landing/about CSS and JS, `data/team.json`, `data/references.json`, `assets/images/` | Citations are never invented |
| **Database** | `js/db/`, `docs/DATA-MODEL.md` | Contract changes update the doc, the mock and the tests together |
| **Core / shared foundation** | `css/tokens.css`, `css/base.css`, `css/layout.css`, `css/components.css`, `js/components/`, `js/core/`, `assets/fonts/`, `assets/brand/`, `vendor/`, `sw.js`, `manifest.webmanifest` | Used by every page. Run the full test suite and the relevant checklists |

Need a new shared component? Add it to `css/components.css` **and** to
`tests/browser/styleguide.html` in the same PR.

## Module contracts

- The landing page's **"Launch Dashboard"** button links to `login.html`.
- The session lives in `localStorage["astrohealth.session"]` (`SESSION_KEY` in `js/core/config.js`).
  - **Only `js/auth/` writes it** (login/logout).
  - Other code (e.g. the landing page) may only **read** it.
- Stores, fields, keys, indexes, migrations and exact repository function
  signatures are documented in `docs/DATA-MODEL.md`. Any database contract
  change updates that file, `js/db/mock-repositories.js` and the relevant tests
  in the same change.
- Repositories only read and write data. Services (`js/services/`) own
  permissions, validation, timeline logging, risk rules, and events.
- `js/db/mock-repositories.js` keeps the documented repository signatures for
  tests and prototyping.
- Every page keeps the footer disclaimer:
  *Research & educational prototype · Not a medical device · Not affiliated with or endorsed by NASA · All health data synthetic.*

## Workflow

1. For feature work, branch from `main` and open a pull request
   (recommended). Use a short descriptive name, e.g. `feature/crew-monitor`,
   `fix/drawer-focus`, `docs/api-policy`. Existing `team1/*` and `team2/*`
   branches are historical names.
2. Keep PRs **small** (one page section / one feature).
3. Use the PR template. Reviewer approval is **optional** while the project is
   solo; the owner may merge their own PR once the checks below pass.
4. Core/shared files, database contract changes and Python/API changes need
   the extra steps in the table above and in `docs/ARCHITECTURE.md`. They don't
   need a second reviewer.
5. Before every PR (and before merging):
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
