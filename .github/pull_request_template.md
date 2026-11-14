## What does this PR do?

<!-- One or two sentences. Link the issue: Closes #123 -->

## Team

- [ ] Team 1 (login / app / dashboards)
- [ ] Team 2 (landing / about)
- [ ] Shared files touched (tokens, base, layout, components, js/core, js/components, assets, vendor, sw.js, manifest) → **needs one reviewer from EACH team**

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
