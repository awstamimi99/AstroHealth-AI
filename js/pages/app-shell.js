// js/pages/app-shell.js — authentication + role-aware shell for app.html (Team 1)
//
// 1. No valid session → redirect to login.html (before the shell is shown).
// 2. Show the signed-in user (name, role, initials) and ONLY the nav items
//    their role may use (from ROUTES in js/core/config.js).
// 3. Guard every hash route: typing app.html#/crew as an astronaut shows an
//    accessible "Access denied" view — hiding the link is not enough.
// 4. Logout (here or in another tab) clears the session and returns to login.
//
// Dashboards are NOT built here — each allowed route shows a placeholder
// until its page is implemented.

import { requireSession, redirectToLogin, checkRoute } from "../auth/guard.js";
import { clearSession, onSessionChange, roleLabel, initialsOf } from "../auth/session.js";
import { routesForRole, homeRouteFor } from "../auth/routes.js";
import { icon } from "../components/icon.js";
import { el, $, $$, clear } from "../core/utils/dom.js";

const APP_NAME = "AstroHealth AI";
const session = requireSession(); // redirects to login.html when null
if (session) startShell(session);

function startShell(current) {
  const shell = $("[data-auth-shell]");
  const nav = $("[data-nav]");
  const view = $("[data-route-view]");
  const title = $("#page-title");

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

  // ---- Route views ------------------------------------------------------------------
  function placeholderView(route) {
    return el("div", { class: "card" }, [
      el("div", { class: "state" }, [
        el("span", { class: "state__icon" }, icon(route.icon)),
        el("p", { class: "state__title" }, route.title),
        el("p", { class: "state__text" }, "This dashboard will be built in a later sprint."),
      ]),
    ]);
  }

  function accessDeniedView(route) {
    const home = homeRouteFor(current.role);
    const heading = el("h2", { class: "state__title", id: "access-denied-title", tabindex: "-1" }, "Access denied");
    const view = el("div", { class: "card", role: "alert", "aria-labelledby": "access-denied-title" }, [
      el("div", { class: "state state--error" }, [
        el("span", { class: "state__icon" }, icon("lock")),
        heading,
        el("p", { class: "state__text" }, `${route.title} is available to the Medical Officer only. You are signed in as ${roleLabel(current.role)}.`),
        el("a", { class: "btn btn--secondary btn--sm", href: home }, [icon("arrow-right"), "Go to Overview"]),
      ]),
    ]);
    return { view, heading };
  }

  /** Render the view for location.hash. `focus` moves focus for keyboard/screen-reader users. */
  function renderRoute({ focus = false } = {}) {
    const { route, allowed } = checkRoute(current, location.hash);

    // Unknown or missing route → the role's home route (replace, no history entry).
    if (!route) {
      history.replaceState(null, "", `${location.pathname}${location.search}${homeRouteFor(current.role)}`);
      return renderRoute({ focus });
    }

    shell.classList.remove("is-open"); // close the mobile drawer after navigating
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
    clear(view).append(placeholderView(route));
    if (focus) title.focus();
  }

  // ---- Logout -----------------------------------------------------------------------------
  function leave() {
    showUser(null); // remove user info from the screen immediately
    clear(nav);
    clear(view);
    redirectToLogin();
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
  window.addEventListener("hashchange", () => renderRoute({ focus: true }));
  shell.style.visibility = ""; // session confirmed — show the app
}
