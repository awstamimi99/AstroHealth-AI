# AstroHealth AI — AI contributor rules

AstroHealth AI is an offline-first, rule-based astronaut health monitoring
prototype by RSS AstroMinds. It is for research and education only, is not a
medical device, is not affiliated with or endorsed by NASA, and uses synthetic
data. Never claim clinical validity or machine-learning capabilities.

## Hard constraints

- Use HTML5, CSS3, and readable vanilla JavaScript ES modules only. No framework,
  bundler, TypeScript, remote API, analytics, CDN, remote font, or remote asset.
- Runtime must work from `python3 -m http.server 8080` with no build step.
- Never insert untrusted strings with `innerHTML`; use `el()` and `textContent`.
- Use tokens from `css/tokens.css` and components from `css/components.css`.
  Check `tests/browser/styleguide.html` before adding new UI patterns.
- Orange is for brand and interaction, never warning. Status always needs color,
  an icon, and text.
- Never fabricate citations. Risk detection is deterministic and rule-based.

## Ownership

| Area | Owner |
| --- | --- |
| Login and dashboards: `login.html`, `app.html`, `js/auth/`, `js/services/`, `js/engine/`, `js/simulation/`, app files in `js/pages/` and `css/pages/` | Team 1 |
| Website and database: `index.html`, `about.html`, landing/about CSS and JS, `data/`, `assets/images/`, `js/db/` | Team 2 |
| Design system, core JS, fonts, brand, vendor files, service worker, manifest, and `docs/DATA-MODEL.md` | Shared |

Only edit files owned by the team named in the task unless explicitly told
otherwise. Shared changes require one reviewer from each team. Team 2 documents
the database contract in `docs/DATA-MODEL.md`; Team 1 must review schema PRs.

Before a PR, run `npm run check:offline`. After adding, renaming, or deleting
runtime files, also run `npm run build:sw`.
