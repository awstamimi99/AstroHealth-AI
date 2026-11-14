// js/pages/app-shell.js — authentication + role-aware shell for app.html (Team 1)
//
// 1. No valid session → redirect to login.html (before the shell is shown).
// 2. Show the signed-in user (name, role, initials) and ONLY the nav items
//    their role may use (from ROUTES in js/core/config.js).
// 3. Guard every hash route: typing app.html#/crew as an astronaut shows an
//    accessible "Access denied" view — hiding the link is not enough.
// 4. Logout (here or in another tab) clears the session and returns to login.
//    The session is re-checked on every navigation and when the tab regains
//    focus, so an expired session also returns to login.
// 5. Mission name + Mission Day come from the seeded settings record via
//    js/services/mission-service.js ("Not available" if it can't be read).
//
// 6. Route views (ROUTE_VIEWS below) are chosen by route AND role:
//    #/overview → astronaut Overview (astronaut) or crew summary (Medical
//    Officer); #/crew (incl. #/crew/AH-0n) → Crew Monitor (Medical Officer);
//    #/physical and #/wellbeing (incl. /AH-0n) → both roles (Sprint 6);
//    #/simulation → Simulation Center (Medical Officer only, Sprint 7);
//    #/alerts (incl. /ALT-0nnn) → Alerts, both roles (Sprint 8);
//    #/history (incl. /AH-0n), #/reports (incl. /AH-0n), #/settings → both
//    roles (Sprint 9). Personal display preferences are applied at startup.
//    Every other route still shows a placeholder until its sprint. Each
//    navigation aborts the previous view's async work, so a late result can
//    never overwrite the route that is now on screen.
//
// Dashboards are NOT built here. The mobile drawer is handled by js/app.js.

import { requireSession, redirectToLogin, checkRoute } from "../auth/guard.js";
import { getSession, clearSession, onSessionChange, roleLabel, initialsOf } from "../auth/session.js";
import { routesForRole, homeRouteFor, findRoute } from "../auth/routes.js";
import { getMissionContext } from "../services/mission-service.js";
import { renderAstronautOverview } from "./astronaut-overview.js";
import { renderMedicalOfficerOverview } from "./officer-overview.js";
import { renderCrewMonitor } from "./crew-monitor.js";
import { renderPhysicalHealth } from "./physical-health.js";
import { renderWellbeing } from "./wellbeing.js";
import { renderSimulationCenter } from "./simulation-center.js";
import { renderAlerts } from "./alerts.js";
import { renderHistory } from "./history.js";
import { renderReports } from "./reports.js";
import { renderSettings } from "./settings.js";
import { preferences } from "../core/preferences.js";
import { APP_NAME } from "../core/config.js";
import { icon } from "../components/icon.js";
import { el, $, $$, clear } from "../core/utils/dom.js";

/**
 * Routes with a real view, per role. Anything not listed shows the
 * placeholder. Route guards (checkRoute) still run first, so e.g. an
 * astronaut never reaches the Crew Monitor view.
 */
const ROUTE_VIEWS = Object.freeze({
  "#/overview": Object.freeze({ astronaut: renderAstronautOverview, medical_officer: renderMedicalOfficerOverview }),
  "#/crew": Object.freeze({ medical_officer: renderCrewMonitor }),
  "#/physical": Object.freeze({ astronaut: renderPhysicalHealth, medical_officer: renderPhysicalHealth }),
  "#/wellbeing": Object.freeze({ astronaut: renderWellbeing, medical_officer: renderWellbeing }),
  "#/simulation": Object.freeze({ medical_officer: renderSimulationCenter }),
  "#/alerts": Object.freeze({ astronaut: renderAlerts, medical_officer: renderAlerts }),
  "#/history": Object.freeze({ astronaut: renderHistory, medical_officer: renderHistory }),
  "#/reports": Object.freeze({ astronaut: renderReports, medical_officer: renderReports }),
  "#/settings": Object.freeze({ astronaut: renderSettings, medical_officer: renderSettings }),
});

const session = requireSession(); // redirects to login.html when null
if (session) startShell(session);

function startShell(current) {
  // Personal display preferences (browser-only, per user; presentation only).
  preferences.apply(current.userId);
  preferences.subscribe(current.userId, () => {});
  const shell = $("[data-auth-shell]");
  const nav = $("[data-nav]");
  const view = $("[data-route-view]");
  const title = $("#page-title");
  /** Aborts the current route view's async work on the next navigation. */
  let viewController = null;

  // ---- Signed-in user -------------------------------------------------------
  function showUser(user) {
    $("[data-user-name]").textContent = user ? user.displayName : "";
    $("[data-user-role]").textContent = user ? roleLabel(user.role) : "";
    $("[data-user-initials]").textContent = user ? initialsOf(user.displayName) : "";
  }

  // ---- Navigation: only routes this role may open -------------------------------
  function renderNav() {
    clear(nav).append(
      ...routesForRole(current.role).map((route) =>
        el("li", {}, [
          el("a", { class: "nav__item", href: route.path, dataset: { route: route.path } }, [
            icon(route.icon),
            el("span", { class: "nav__label" }, route.label),
            route.moOnly ? el("span", { class: "nav__tag", title: "Medical Officer only" }, "MO") : null,
          ]),
        ])
      )
    );
  }

  function markActive(path) {
    for (const link of $$(".nav__item[data-route]", nav)) {
      const active = link.dataset.route === path;
      link.classList.toggle("is-active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }

  // ---- Mission context (synthetic seed data, never invented here) ----------------
  async function showMission() {
    const mission = await getMissionContext(current);
    $("[data-mission-name]").textContent = mission.name;
    $("[data-mission-day]").textContent = mission.missionDay ? String(mission.missionDay) : "Not available";
  }

  // ---- Route views ------------------------------------------------------------------
  // Placeholders only: no metrics, forms or alerts until each dashboard sprint.
  function placeholderView(route) {
    return el("section", { class: "card", "aria-labelledby": "route-placeholder-title" }, [
      el("div", { class: "state" }, [
        el("span", { class: "state__icon" }, icon(route.icon)),
        el("h2", { class: "state__title", id: "route-placeholder-title" }, route.title),
        el("p", { class: "state__text" }, `The ${route.title} section will be completed in a later sprint. No health data is shown here yet.`),
      ]),
    ]);
  }

  /** "Medical Officer", or "Astronaut and Medical Officer", from the route's own roles. */
  function allowedRolesText(route) {
    return route.roles.map(roleLabel).join(" and ");
  }

  function accessDeniedView(route) {
    const home = homeRouteFor(current.role);
    const homeLabel = findRoute(home)?.label || "home";
    const heading = el("h2", { class: "state__title", id: "access-denied-title", tabindex: "-1" }, "Access denied");
    const view = el("div", { class: "card", role: "alert", "aria-labelledby": "access-denied-title" }, [
      el("div", { class: "state state--error" }, [
        el("span", { class: "state__icon" }, icon("lock")),
        heading,
        el("p", { class: "state__text" }, `${route.title} is available to the ${allowedRolesText(route)} role only. You are signed in as ${roleLabel(current.role)}.`),
        el("a", { class: "btn btn--secondary btn--sm", href: home }, [icon("arrow-right"), `Go to ${homeLabel}`]),
      ]),
    ]);
    return { view, heading };
  }

  /** Render the view for location.hash. `focus` moves focus for keyboard/screen-reader users. */
  function renderRoute({ focus = false } = {}) {
    if (!stillSignedIn()) return;
    viewController?.abort(); // a late result from the previous view is ignored
    viewController = null;
    const { route, allowed } = checkRoute(current, location.hash);

    // Unknown or missing route → the role's home route (replace, no history entry).
    if (!route) {
      history.replaceState(null, "", `${location.pathname}${location.search}${homeRouteFor(current.role)}`);
      return renderRoute({ focus });
    }

    if (!allowed) {
      const { view: denied, heading } = accessDeniedView(route);
      title.textContent = "Access denied";
      document.title = `Access denied — ${APP_NAME}`;
      markActive("");
      clear(view).append(denied);
      if (focus) heading.focus();
      return;
    }

    title.textContent = route.title;
    document.title = `${route.title} — ${APP_NAME}`;
    markActive(route.path);
    const renderView = ROUTE_VIEWS[route.path]?.[current.role];
    if (renderView) {
      viewController = new AbortController();
      renderView(clear(view), current, { signal: viewController.signal, hash: location.hash, focus });
    } else {
      clear(view).append(placeholderView(route));
    }
    if (focus) title.focus();
  }

  // ---- Logout -----------------------------------------------------------------------------
  /** Hide everything personal, then go to login (optionally back to `returnTo` afterwards). */
  function leave({ returnTo } = {}) {
    viewController?.abort();
    shell.style.visibility = "hidden";
    showUser(null); // remove user info from the screen immediately
    clear(nav);
    clear(view);
    redirectToLogin({ returnTo });
  }

  /** Expired, removed or replaced session → leave and return false. */
  function stillSignedIn() {
    const latest = getSession();
    if (latest && latest.userId === current.userId) return true;
    if (latest) location.reload(); // another user signed in meanwhile
    else leave({ returnTo: location.hash });
    return false;
  }

  $("[data-logout]").addEventListener("click", () => {
    clearSession(); // the IndexedDB data is NOT touched
    leave();
  });

  // Signed out (or someone else signed in) in another tab → follow along.
  onSessionChange((session) => {
    if (!session) leave();
    else if (session.userId !== current.userId) location.reload();
  });

  // ---- Start ---------------------------------------------------------------------------------
  showUser(current);
  renderNav();
  renderRoute();
  showMission();
  window.addEventListener("hashchange", () => renderRoute({ focus: true }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") stillSignedIn();
  });
  shell.style.visibility = ""; // session confirmed — show the app
}
