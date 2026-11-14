// js/auth/guard.js
// Page and route guards. Both pages use the SAME getSession() check, so they
// can never disagree and bounce the user back and forth (no redirect loop):
//   app.html   — no valid session  → login.html
//   login.html — valid session     → app.html#/overview (or a safe returnTo)
//   app.html#/crew as an astronaut → stays in the app, shows "Access denied"
//
// We use location.replace() so the Back button doesn't return to a page that
// would immediately redirect again.

import { getSession } from "./session.js";
import { canAccessRoute, findRoute, homeRouteFor, safeReturnTo } from "./routes.js";

export const LOGIN_PAGE = "login.html";
export const APP_PAGE = "app.html";

/**
 * Go to the login page. `returnTo` is kept only if it is a known in-app
 * route (e.g. "#/history"); anything else is dropped.
 */
export function redirectToLogin({ returnTo } = {}) {
  const safe = safeReturnTo(returnTo);
  location.replace(safe ? `${LOGIN_PAGE}?returnTo=${encodeURIComponent(safe)}` : LOGIN_PAGE);
}

/**
 * Use at the top of app pages. Returns the session, or redirects to the
 * login page (remembering the current route) and returns null.
 */
export function requireSession() {
  const session = getSession();
  if (!session) redirectToLogin({ returnTo: location.hash });
  return session;
}

/**
 * Like requireSession(), but also checks the role.
 * @returns {{ session: object|null, allowed: boolean }}
 *   session null → already redirecting to login;
 *   allowed false → signed in but the page must show "Access denied".
 */
export function requireRole(...allowedRoles) {
  const session = requireSession();
  return { session, allowed: Boolean(session && allowedRoles.includes(session.role)) };
}

/**
 * Check an in-app hash route for the signed-in user.
 * @returns {{ route: object|null, allowed: boolean }}
 */
export function checkRoute(session, hash) {
  const route = findRoute(hash);
  return { route, allowed: Boolean(session && route && canAccessRoute(session.role, hash)) };
}

/**
 * For login.html: if already signed in, go to the app and return true.
 * Honors ?returnTo=#/route only when it is a known route this role may open.
 */
export function redirectAuthenticatedUser() {
  const session = getSession();
  if (!session) return false;
  const requested = safeReturnTo(new URLSearchParams(location.search).get("returnTo"));
  const target = requested && canAccessRoute(session.role, requested) ? requested : homeRouteFor(session.role);
  location.replace(`${APP_PAGE}${target}`);
  return true;
}
