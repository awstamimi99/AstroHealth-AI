## What does this PR do?

<!-- One or two sentences. Link the issue: Closes #123 -->

## Team

- [ ] Team 1 (login / app / dashboards)
- [ ] Team 2 (landing / about)
- [ ] Shared files touched (tokens, base, layout, components, js/core, js/components, assets, vendor, sw.js, manifest) → **needs one reviewer from EACH team**

## Screenshots

<!-- Desktop + mobile (< 1024px) screenshots of the change. -->

## Checklist

- [ ] Works offline (DevTools → Network → "Offline", reload — page still works)
- [ ] No errors or warnings in the browser console
- [ ] Uses design tokens (`var(--…)`) — no hard-coded colours, sizes or fonts
- [ ] Status shown as colour + icon + text (orange is never used for "warning")
- [ ] No remote URLs; `npm run check:offline` passed
- [ ] Ran `npm run build:sw` if I added, renamed or deleted runtime files
- [ ] No untrusted strings inserted with `innerHTML` (use `el()` from `js/core/utils/dom.js`)
- [ ] Keyboard-accessible (Tab through it; focus ring is visible)
- [ ] Disclaimer footer still present
