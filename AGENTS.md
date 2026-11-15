# AstroHealth AI — AI contributor rules

AstroHealth AI is an online-capable, rule-based astronaut health monitoring
prototype by RSS AstroMinds, with optional offline support. It is for research
and education only, is not a medical device, is not affiliated with or
endorsed by NASA, and uses synthetic data. Never claim clinical validity or
machine-learning capabilities.

## Hard constraints

- Frontend: HTML5, CSS3, and readable vanilla JavaScript ES modules only. No
  framework, bundler, or TypeScript. Never rewrite the UI in Python or a
  framework.
- The static frontend must keep working from `python3 -m http.server 8080`
  with no build step.
- No analytics, CDN, remote font, or remote script/style/image asset. Keep
  them in `vendor/` and `assets/`.
- APIs are allowed only under the controlled API policy in
  `docs/ARCHITECTURE.md`:
  - approved endpoints only, called by `js/services/` through the shared
    client `js/core/api.js` (pages never call APIs or repositories directly);
  - HTTPS in production, `localhost` in development;
  - loading, timeout, offline and clear error states;
  - never fabricated data when a call fails;
  - never send passwords, hashes, salts, the session, or private journal text.
- IndexedDB (`js/db/`) stays the primary data store. Don't move data to a
  server, replace the database, or break the frozen API in
  `docs/DATA-MODEL.md`. Pages import data through services; services import
  only `js/db/index.js`.
- Python is allowed only when a real feature needs it, as a small stateless
  API (FastAPI preferred). Candidates are analysis, the risk engine,
  simulation, reports, or data integration. Don't create a Python backend or
  add a dependency before then. See the Python policy in
  `docs/ARCHITECTURE.md`. No Python backend or Python dependency exists yet.
- Offline support (`sw.js`) is an optional feature, not a requirement for
  every feature. Don't remove the service worker. An online-only feature must
  say so when offline and must not break the rest of the app.
- Never insert untrusted strings with `innerHTML`; use `el()` and `textContent`.
- Use tokens from `css/tokens.css` and components from `css/components.css`.
  Check `tests/browser/styleguide.html` before adding new UI patterns.
- Red is for brand and interaction, never a health state. Critical uses its own
  raspberry-magenta colour with its icon and label. Status always needs color,
  an icon, and text.
- Never fabricate citations. Risk detection is deterministic, rule-based and
  explainable (which rule, which values, which thresholds), including when
  computed by a Python service.
- Canonical roles are exactly `astronaut` and `medical_officer`. Never use
  `medical-officer` or `admin`. "Medical Officer" is a display label only.
- All astronaut health, medical, mission, and simulation records are
  synthetic. Real astronaut health or medical records are never permitted.
  Verified public NASA resources and research references may be real, and
  must be clearly attributed. Never fabricate citations: new references start
  `"verified": false` (see `docs/ARCHITECTURE.md`).
- Keep the disclaimer on every page: research & educational prototype, not a
  medical device, not affiliated with or endorsed by NASA. Never claim NASA
  affiliation, NASA endorsement, or clinical validity.

## Project governance (solo project)

AstroHealth AI is a solo project, owned and maintained by **awstamimi99**.
There are no Team 1 / Team 2 roles and no cross-team review requirements.
Branch names such as `team1/*` and `team2/*` are historical only.

- The owner may work across every area of the repository. Still keep each
  change focused on the task you were given.
- **Core and shared files** need extra care and the full test run (unit tests,
  `check:offline`, and the relevant browser/manual checklists). They do not
  need anyone else's approval. These are the design system (`css/tokens.css`,
  `base.css`, `layout.css`, `components.css`), `js/core/`, `js/components/`,
  `sw.js`, `manifest.webmanifest`, fonts, brand and vendor files.
- **Database contract changes** (`js/db/`, `docs/DATA-MODEL.md`) must update
  `docs/DATA-MODEL.md`, the mock repositories and the relevant tests in the
  same change, and follow the migration rules there.
- **Python/API changes** need documented architecture (endpoints, payloads,
  errors) in `docs/ARCHITECTURE.md`, a security review against the API policy,
  and tests.
- Pull requests are recommended for feature work. Reviewer approval is
  optional while the project is solo.
- GitHub collaborator permissions are managed in the repository settings, not
  in these documents. Changing them is outside the scope of documentation
  tasks.

Before a PR, run `npm run test:unit` and `npm run check:offline`. The check
protects the static frontend from remote assets and unapproved URLs. It
exempts exactly one file, `data/references.json` (reference links shown to
readers).

It has **no API allowlist yet**, so any remote URL in runtime code fails
today, including an API endpoint. A narrow allowlist (described in
`docs/ARCHITECTURE.md`, not implemented) is added only with the first
approved remote endpoint. Never weaken the check broadly.

After adding, renaming, or deleting runtime files, also run `npm run build:sw`.
