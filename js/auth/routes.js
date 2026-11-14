// js/auth/routes.js
// PURE route-permission helpers — the ONE place that decides which role may
// open which app route. Uses ROUTES from js/core/config.js. No browser APIs,
// so Node unit tests can import it.
//
// Route-level rules only. Data-level privacy (an astronaut seeing only their
// own data, the Medical Officer never seeing private journals or unshared
// check-ins) must ALSO be enforced by Team 1's services when pages are built.

import { ROUTES, DEFAULT_ROUTE } from "../core/config.js";

export { ROUTES, DEFAULT_ROUTE };

/** "#/crew", "#/crew/AH-01" or "#/crew?x=1" → "#/crew". Anything else → "". */
export function normalizeRoute(hash) {
  const match = /^#\/([a-z][a-z0-9-]*)(?:[/?].*)?$/.exec(String(hash || ""));
  return match ? `#/${match[1]}` : "";
}

/** The ROUTES entry for a hash, or null if unknown. */
export function findRoute(hash) {
  const path = normalizeRoute(hash);
  return ROUTES.find((route) => route.path === path) || null;
}

/** May this role open this route? Unknown routes → false. */
export function canAccessRoute(role, hash) {
  const route = findRoute(hash);
  return Boolean(route && route.roles.includes(role));
}

/** Routes shown in this role's navigation (same order as ROUTES). */
export function routesForRole(role) {
  return ROUTES.filter((route) => route.roles.includes(role));
}

/** Where a role lands after sign-in: DEFAULT_ROUTE, or its first allowed route. */
export function homeRouteFor(role) {
  if (canAccessRoute(role, DEFAULT_ROUTE)) return DEFAULT_ROUTE;
  return routesForRole(role)[0]?.path || DEFAULT_ROUTE;
}

/**
 * Validate a "return to" location. ONLY a known in-app hash route like
 * "#/history" is accepted — never a URL, path or other site, so the login
 * page can't be abused to redirect somewhere else.
 * @returns {string|null} the route path, or null
 */
export function safeReturnTo(value) {
  if (typeof value !== "string") return null;
  if (!/^#\/[a-z][a-z0-9-]*$/.test(value)) return null;
  return findRoute(value) ? value : null;
}
