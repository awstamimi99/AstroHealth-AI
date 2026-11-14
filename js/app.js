// js/app.js
// SHARED. Small bootstrap that EVERY page loads:
//   <script type="module" src="js/app.js"></script>
//
// It:
//   1. warns if the page was opened via file:// (environment.js)
//   2. turns <i data-icon="name"> placeholders into Lucide SVG icons
//   3. registers the service worker (offline support)
//   4. keeps any [data-offline-status] element up to date (sidebar card)
//   5. wires the mobile sidebar drawer ([data-drawer-toggle])
//
// Page-specific code goes in its own module (e.g. js/pages/landing.js),
// loaded with a second <script type="module"> tag.

import { checkEnvironment } from "./core/environment.js";
import { hydrateIcons, icon } from "./components/icon.js";
import { registerServiceWorker, onSwStatus } from "./sw-register.js";
import { $, $$, clear } from "./core/utils/dom.js";

// (The start-up calls are at the BOTTOM of this file, after every
// function and constant they use has been defined.)

// ---- Offline indicator ----------------------------------------------------
// Markup (see app.html):
//   <div class="offline-card" data-offline-status>
//     <span class="offline-card__icon"></span>
//     <div><p class="offline-card__title"></p><p class="offline-card__text"></p></div>
//   </div>
const SW_TEXT = {
  active: "All data stored on this device",
  installing: "Preparing offline copy…",
  unsupported: "Offline mode unavailable here",
  error: "Offline copy failed — see console",
};

function initOfflineStatus() {
  const cards = $$("[data-offline-status]");
  if (!cards.length) return;

  let swStatus = "installing";
  const render = () => {
    const online = navigator.onLine;
    for (const card of cards) {
      const iconBox = $(".offline-card__icon", card);
      const title = $(".offline-card__title", card);
      const text = $(".offline-card__text", card);
      if (iconBox) clear(iconBox).append(icon(online ? "wifi" : "wifi-off"));
      if (title) title.textContent = online ? "Online · Offline-ready" : "Offline mode";
      if (text) text.textContent = SW_TEXT[swStatus] || "";
      card.dataset.state = swStatus;
    }
  };

  onSwStatus((status) => {
    swStatus = status;
    render();
  });
  window.addEventListener("online", render);
  window.addEventListener("offline", render);
}

// ---- Mobile drawer --------------------------------------------------------
// Below 1024px the sidebar slides in when [data-drawer-toggle] is clicked.
function initDrawer() {
  const shell = $(".app-shell");
  if (!shell) return;
  const toggles = $$("[data-drawer-toggle]");

  const setOpen = (open) => {
    shell.classList.toggle("is-open", open);
    for (const t of toggles) t.setAttribute("aria-expanded", String(open));
  };

  for (const t of toggles) {
    t.addEventListener("click", () => setOpen(!shell.classList.contains("is-open")));
  }
  $(".sidebar-scrim", shell)?.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setOpen(false);
  });
}

// ---- Start-up ---------------------------------------------------------------
checkEnvironment();
hydrateIcons();
initOfflineStatus();
initDrawer();
registerServiceWorker();
