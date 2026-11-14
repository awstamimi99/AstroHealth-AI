## What does this PR do?

<!-- One or two sentences. Link the issue: Closes #123 -->

## Area

- [ ] Authenticated app (login / app / dashboards)
- [ ] Public site (landing / about)
- [ ] Database (`js/db/`, `docs/DATA-MODEL.md`) → doc, mock and tests updated together
- [ ] Core/shared files (tokens, base, layout, components, js/core, js/components, assets, vendor, sw.js, manifest) → full test suite and relevant checklists run
- [ ] Python/API → architecture documented, security reviewed against the API policy, tests added

Reviewer approval is optional (solo project).

## Screenshots

<!-- Desktop + mobile (< 1024px) screenshots of the change. -->

## Checklist

- [ ] Local-only features still work offline (DevTools → Network → "Offline", reload); online-only features show a clear "needs internet" message instead of breaking
- [ ] No errors or warnings in the browser console
- [ ] Uses design tokens (`var(--…)`) — no hard-coded colours, sizes or fonts
- [ ] Status shown as colour + icon + text (orange is never used for "warning")
- [ ] No remote assets (CDN, fonts, images, analytics); `npm run check:offline` passed
- [ ] Any API call follows the API policy in `docs/ARCHITECTURE.md`: approved endpoint, HTTPS (or localhost in dev), loading + timeout + offline + error states, no fabricated data on failure, no secrets or private data sent
- [ ] `npm run test:unit` passed
- [ ] Ran `npm run build:sw` if I added, renamed or deleted runtime files
- [ ] No untrusted strings inserted with `innerHTML` (use `el()` from `js/core/utils/dom.js`)
- [ ] Keyboard-accessible (Tab through it; focus ring is visible)
- [ ] Disclaimer footer still present
