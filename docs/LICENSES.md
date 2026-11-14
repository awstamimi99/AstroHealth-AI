# Third-party licences

All third-party files are copied into this repository at development time
(`npm run setup`) so the app runs fully offline. Their licence files are kept
next to them.

| Component | Version | Licence | Location in repo | Licence file |
| --- | --- | --- | --- | --- |
| [Chart.js](https://www.chartjs.org/) | 4.x | MIT | `vendor/chart.js/chart.umd.min.js` | `vendor/chart.js/LICENSE.md` |
| [Lucide](https://lucide.dev/) icons (via `lucide-static`) | 1.x | ISC | `vendor/lucide/icons.js` (curated subset) | `vendor/lucide/LICENSE` |
| [Inter](https://rsms.me/inter/) (via `@fontsource/inter`) | 5.x | SIL Open Font License 1.1 | `assets/fonts/inter/` (latin 400/500/600/700) | `assets/fonts/inter/LICENSE` |
| [JetBrains Mono](https://www.jetbrains.com/lp/mono/) (via `@fontsource/jetbrains-mono`) | 5.x | SIL Open Font License 1.1 | `assets/fonts/jetbrains-mono/` (latin 400/500/600) | `assets/fonts/jetbrains-mono/LICENSE` |

Exact versions are pinned in `package-lock.json`.

Dev-only tool (not shipped): `@resvg/resvg-js` (MPL-2.0) renders the PNG app
icons in `scripts/build-brand.mjs`.

## Brand

The AstroHealth AI logo (`assets/brand/`) is original work by the team. Its
heartbeat line is the Lucide "activity" icon (ISC). **No NASA logo, insignia
or mission patch is used.** AstroHealth AI is not affiliated with or endorsed
by NASA.
