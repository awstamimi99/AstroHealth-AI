# Contributing to AstroHealth AI

Two teams build on one shared foundation. This file says who owns what and
how changes get in.

## Team ownership

| Area | Owner | Files |
| --- | --- | --- |
| **Authenticated app** | **Team 1** | `login.html`, `app.html`, `js/auth/`, `js/db/`, `js/services/`, `js/engine/`, `js/simulation/`, `js/pages/` (app pages), `css/pages/` (app pages) |
| **Public site** | **Team 2** | `index.html`, `about.html`, `css/pages/landing.css`, `css/pages/about.css`, `js/pages/landing.js`, `data/team.json`, `data/references.json`, `assets/images/` |
| **Shared foundation** | **Both** — PR needs **one reviewer from each team** | `css/tokens.css`, `css/base.css`, `css/layout.css`, `css/components.css`, `js/components/`, `js/core/`, `assets/fonts/`, `assets/brand/`, `vendor/`, `sw.js`, `manifest.webmanifest` |

Need a new shared component? Add it to `css/components.css` **and** to
`tests/browser/styleguide.html` in the same PR.

## Team contract

- The landing page's **"Launch Dashboard"** button links to `login.html`.
- The session lives in `localStorage["astrohealth.session"]` (`SESSION_KEY` in `js/core/config.js`).
  - **Only Team 1 writes it** (login/logout in `js/auth/`).
  - **Team 2 may only read it** (e.g. to show "Continue to dashboard").
- Every page keeps the footer disclaimer:
  *Research & educational prototype · Not a medical device · Not affiliated with or endorsed by NASA · All health data synthetic.*

## Workflow

1. Never push to `main` directly.
2. Branch from `main`:
   - Team 1: `team1/<task>` — e.g. `team1/login-form`
   - Team 2: `team2/<task>` — e.g. `team2/landing-hero`
3. Keep PRs **small** (one page section / one feature).
4. Open a PR using the template; **at least 1 review** before merging
   (shared files: one reviewer from each team).
5. Before every PR:
   ```bash
   npm run check:offline     # must pass
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
- **No remote URLs** in HTML/CSS/JS — no CDNs, Google Fonts, remote images or APIs.
- **No untrusted strings in `innerHTML`.** Build DOM with `el()` from `js/core/utils/dom.js`.
- Vanilla JS ES modules (`<script type="module">`), no frameworks, no bundler.
- Keep code simple and commented — other students need to read it.
- Icons: `icon("name")` from `js/components/icon.js`. Missing icon? Add the name
  to `scripts/build-icons.mjs`, run `npm run setup`, commit `vendor/lucide/icons.js`.
- Synthetic data must be visibly labelled with `.sim-tag`.
- Citations in `data/references.json`: never invented; new entries start `"verified": false`
  (see `docs/ARCHITECTURE.md`).
