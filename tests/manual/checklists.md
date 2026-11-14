# Manual test checklists

Run these before merging a PR that changes pages, and before every demo.
Always test through a local server: `npm run serve` → <http://localhost:8080>.

## 1. Every page (index, about, login, app, style guide)

- [ ] Page loads with no console errors or warnings
- [ ] Text is in **Inter** (DevTools → Elements → Computed → *Rendered Fonts*)
- [ ] Icons render (no empty squares)
- [ ] Favicon shows in the browser tab
- [ ] Footer disclaimer is visible
- [ ] Press <kbd>Tab</kbd> once → "Skip to main content" appears and works
- [ ] Every interactive element has a visible orange focus ring
- [ ] At 375px wide nothing overflows horizontally

## 2. Offline

1. Load <http://localhost:8080/index.html> once (service worker installs).
2. DevTools → Application → Service Workers: status is **activated**.
3. DevTools → Network → tick **Offline**.
4. Reload index, login, app and about → all still load with fonts and icons.
5. DevTools → Network with "3rd-party requests" filter → **zero** requests to any other host.

## 3. App shell (app.html)

- [ ] Sidebar shows 9 items; Crew Monitor and Simulation Center have the "MO" tag
- [ ] Active item has the orange bar, tint and orange icon
- [ ] Below 1024px: sidebar hides; the menu button opens it as a drawer; clicking the dark overlay or pressing <kbd>Esc</kbd> closes it
- [ ] Offline status card in the sidebar footer reads "Online · Offline-ready" once cached, and "Offline mode" when the network is off

## 4. Opened the wrong way

- [ ] Double-click `index.html` in Finder/Explorer (file://) → amber warning bar asks you to run a local server

## 5. Print (Team 1 reports)

- [ ] <kbd>Ctrl/Cmd</kbd>+<kbd>P</kbd> on app.html → white page, black text, no sidebar or topbar
