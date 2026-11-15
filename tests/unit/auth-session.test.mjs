// Unit tests for js/auth/* — run with: npm run test:unit
//
// The pure modules (session-core.js, routes.js) import directly. session.js
// and guard.js expect a browser, so we install tiny stand-ins for
// localStorage, location, history and BroadcastChannel BEFORE importing them.
// Credentials are checked against js/db/mock-repositories.js, which uses the
// same seed data and the same PBKDF2 password code as the real database.

import test from "node:test";
import assert from "node:assert/strict";

// ---- Browser stand-ins -------------------------------------------------------
class MemoryStorage {
  #data = new Map();
  getItem(key) { return this.#data.has(key) ? this.#data.get(key) : null; }
  setItem(key, value) { this.#data.set(key, String(value)); }
  removeItem(key) { this.#data.delete(key); }
  clear() { this.#data.clear(); }
}
const redirects = [];
globalThis.self = globalThis;
globalThis.BroadcastChannel = class { postMessage() {} addEventListener() {} close() {} };
globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage(); // this tab's storage (tab-only sessions)
globalThis.location = {
  hash: "", search: "", pathname: "/app.html",
  replace(url) { redirects.push(url); },
};

const { SESSION_KEY, ROUTES } = await import("../../js/core/config.js");
const core = await import("../../js/auth/session-core.js");
const routes = await import("../../js/auth/routes.js");
const session = await import("../../js/auth/session.js");
const guard = await import("../../js/auth/guard.js");
const { usersRepo, resetMock } = await import("../../js/db/mock-repositories.js");
const { ROLES } = await import("../../js/db/constants.js");

await resetMock();
const login = (u, p) => usersRepo.verifyPassword(u, p);
const reset = () => { localStorage.clear(); sessionStorage.clear(); redirects.length = 0; location.hash = ""; location.search = ""; };

// ---- 1–6: credentials (through the repository API) ----------------------------

test("1. haddad / demo signs in as astronaut a-01", async () => {
  const user = await login("haddad", "demo");
  assert.equal(user.role, "astronaut");
  assert.equal(user.astronautId, "a-01");
});

test("2–3. medofficer and medbackup / demo sign in as medical_officer", async () => {
  for (const name of ["medofficer", "medbackup"]) {
    const user = await login(name, "demo");
    assert.ok(user, name);
    assert.equal(user.role, "medical_officer");
    assert.equal(user.astronautId, "");
  }
});

test("4–5. wrong username or wrong password fails", async () => {
  assert.equal(await login("nobody", "demo"), null);
  assert.equal(await login("haddad", "wrong"), null);
  assert.equal(await login("haddad", "DEMO"), null); // passwords are case-sensitive
});

test("6. usernames are case-insensitive (documented repository behaviour)", async () => {
  assert.equal((await login("  HadDad ", "demo")).username, "haddad");
});

// ---- 7–11: session contents and validation ------------------------------------

test("7. the session holds no password, passwordHash or salt", async () => {
  reset();
  const user = await login("haddad", "demo");
  session.createSession(user);
  const raw = localStorage.getItem(SESSION_KEY);
  assert.ok(raw);
  assert.doesNotMatch(raw, /password|salt|demo"/i);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(),
    ["astronautId", "createdAt", "displayName", "expiresAt", "role", "userId", "username", "version"]);
});

test("createSession refuses a user object that still has secrets", () => {
  const unsafe = { id: "u-x", username: "x", displayName: "X", role: "astronaut", astronautId: "a-01", passwordHash: "h", salt: "s" };
  assert.throws(() => session.createSession(unsafe), /safe user/);
});

test("8. malformed or tampered JSON returns null safely (and is removed)", () => {
  reset();
  for (const bad of ["{not json", "null", "[]", '"text"', "{}"]) {
    localStorage.setItem(SESSION_KEY, bad);
    assert.equal(session.getSession(), null, bad);
    assert.equal(localStorage.getItem(SESSION_KEY), null, `${bad} removed`);
  }
});

test("9. unknown roles are rejected (including medical-officer with a hyphen)", () => {
  const now = Date.now();
  const base = { version: 1, userId: "u", username: "u", displayName: "U", astronautId: "", createdAt: now, expiresAt: now + 1000 };
  for (const role of ["medical-officer", "admin", "", undefined]) {
    assert.ok(core.findSessionProblem({ ...base, role }, now), String(role));
    assert.equal(core.parseSession(JSON.stringify({ ...base, role }), now), null);
  }
  assert.throws(() => core.buildSession({ id: "u", username: "u", displayName: "U", role: "medical-officer", astronautId: "" }));
});

test("10. an astronaut without astronautId is rejected", () => {
  assert.throws(() => core.buildSession({ id: "u", username: "u", displayName: "U", role: ROLES.ASTRONAUT, astronautId: "" }), /astronautId/);
  const now = Date.now();
  const s = { version: 1, userId: "u", username: "u", displayName: "U", role: "astronaut", astronautId: "", createdAt: now, expiresAt: now + 1000 };
  assert.equal(core.parseSession(JSON.stringify(s), now), null);
});

test("11. a medical_officer session has astronautId \"\"", async () => {
  reset();
  const s = session.createSession(await login("medofficer", "demo"));
  assert.equal(s.astronautId, "");
  assert.equal(s.role, "medical_officer");
  const tampered = { ...s, astronautId: "a-01" };
  assert.equal(core.parseSession(JSON.stringify(tampered)), null);
});

test("expired sessions return null and are removed", () => {
  reset();
  const past = Date.now() - core.SESSION_TTL_MS - 1000;
  const old = core.buildSession({ id: "u-haddad", username: "haddad", displayName: "Cmdr. Sami Haddad", role: "astronaut", astronautId: "a-01" }, past);
  localStorage.setItem(SESSION_KEY, JSON.stringify(old));
  assert.equal(session.getSession(), null);
  assert.equal(localStorage.getItem(SESSION_KEY), null);
});

test("getSession returns a NEW object each time (no shared mutable state)", async () => {
  reset();
  session.createSession(await login("haddad", "demo"));
  const a = session.getSession();
  a.role = "medical_officer";
  assert.equal(session.getSession().role, "astronaut");
  assert.ok(session.hasRole("astronaut"));
  assert.equal(session.hasRole("medical_officer"), false);
  assert.equal(session.hasRole("medical-officer"), false);
});

// ---- 12–13: persistence and logout -----------------------------------------------

test("12. a valid session survives a 'refresh' (read back from storage)", async () => {
  reset();
  const created = session.createSession(await login("haddad", "demo"));
  // A page reload = a fresh getSession() reading the same storage.
  assert.deepEqual(session.getSession(), created);
  assert.ok(session.isAuthenticated());
});

test("13. logout clears the session and notifies listeners", async () => {
  reset();
  session.createSession(await login("medofficer", "demo"));
  const seen = [];
  const stop = session.onSessionChange((s) => seen.push(s));
  session.clearSession();
  stop();
  assert.equal(localStorage.getItem(SESSION_KEY), null);
  assert.equal(session.isAuthenticated(), false);
  assert.deepEqual(seen, [null]);
});

// ---- Tab-only sessions (Live control demo: two users side by side) -------------------

test("tab-only sign-in: this tab uses its own session; the shared one is left alone", async () => {
  reset();
  const shared = session.createSession(await login("medofficer", "demo"));
  const own = session.createSession(await login("reyes", "demo"), { tabOnly: true });
  assert.equal(JSON.parse(localStorage.getItem(SESSION_KEY)).userId, shared.userId, "other tabs keep the Medical Officer");
  assert.equal(JSON.parse(sessionStorage.getItem(SESSION_KEY)).userId, own.userId);
  assert.equal(session.getSession().userId, "u-reyes", "the tab-only session wins in its tab");
  assert.equal(session.isTabOnlySession(), true);
  for (const secret of ["password", "passwordHash", "salt"]) assert.ok(!(secret in session.getSession()), secret);
});

test("tab-only sign-out clears only this tab; a normal sign-in replaces a tab-only session", async () => {
  reset();
  session.createSession(await login("medofficer", "demo"));
  session.createSession(await login("reyes", "demo"), { tabOnly: true });
  session.clearSession();
  assert.equal(sessionStorage.getItem(SESSION_KEY), null);
  assert.equal(session.getSession().userId, "u-medofficer", "the shared session is still there");
  assert.equal(session.isTabOnlySession(), false);

  session.createSession(await login("chen", "demo"), { tabOnly: true });
  session.createSession(await login("haddad", "demo"));
  assert.equal(sessionStorage.getItem(SESSION_KEY), null, "normal sign-in removed the tab-only session");
  assert.equal(session.getSession().userId, "u-haddad");
});

test("an expired or tampered tab-only session is removed and never falls back silently to a wrong user", async () => {
  reset();
  sessionStorage.setItem(SESSION_KEY, "{not json");
  assert.equal(session.getSession(), null);
  assert.equal(sessionStorage.getItem(SESSION_KEY), null, "broken tab session removed");
});

// ---- 14–15: page redirects ----------------------------------------------------------

test("14. app.html without a session redirects to login.html", () => {
  reset();
  location.hash = "#/history";
  assert.equal(guard.requireSession(), null);
  assert.deepEqual(redirects, ["login.html?returnTo=%23%2Fhistory"]);
});

test("15. login.html with a session redirects to app.html#/overview", async () => {
  reset();
  session.createSession(await login("haddad", "demo"));
  assert.equal(guard.redirectAuthenticatedUser(), true);
  assert.deepEqual(redirects, ["app.html#/overview"]);
});

test("login.html with no session stays put (no redirect loop)", () => {
  reset();
  assert.equal(guard.redirectAuthenticatedUser(), false);
  assert.deepEqual(redirects, []);
});

test("returnTo: only known in-app routes the role may open are honoured", async () => {
  reset();
  session.createSession(await login("haddad", "demo"));
  location.search = "?returnTo=%23%2Fhistory";
  guard.redirectAuthenticatedUser();
  location.search = "?returnTo=%23%2Fcrew"; // astronaut may not open it
  guard.redirectAuthenticatedUser();
  location.search = "?returnTo=https%3A%2F%2Fevil.example";
  guard.redirectAuthenticatedUser();
  assert.deepEqual(redirects, ["app.html#/history", "app.html#/overview", "app.html#/overview"]);
  for (const bad of ["https://evil.example", "//evil.example", "javascript:alert(1)", "#/nope", "#/crew/../x", "app.html#/crew", null]) {
    assert.equal(routes.safeReturnTo(bad), null, String(bad));
  }
});

// ---- 16–18: route permissions ----------------------------------------------------

test("16–17. an astronaut cannot open Crew Monitor or Simulation Center", async () => {
  reset();
  const astronaut = session.createSession(await login("haddad", "demo"));
  for (const hash of ["#/crew", "#/simulation", "#/crew/AH-02", "#/simulation?run=1"]) {
    assert.equal(guard.checkRoute(astronaut, hash).allowed, false, hash);
  }
  const navPaths = routes.routesForRole("astronaut").map((r) => r.path);
  assert.ok(!navPaths.includes("#/crew") && !navPaths.includes("#/simulation"));
  assert.equal(guard.requireRole(ROLES.MEDICAL_OFFICER).allowed, false);
});

test("18. a medical officer can open both restricted routes", async () => {
  reset();
  const mo = session.createSession(await login("medofficer", "demo"));
  assert.ok(guard.checkRoute(mo, "#/crew").allowed);
  assert.ok(guard.checkRoute(mo, "#/simulation").allowed);
  assert.equal(guard.requireRole(ROLES.MEDICAL_OFFICER).allowed, true);
});

test("astronaut keeps access to their own areas", () => {
  for (const hash of ["#/overview", "#/physical", "#/wellbeing", "#/history", "#/alerts", "#/reports", "#/settings"]) {
    assert.ok(routes.canAccessRoute("astronaut", hash), hash);
  }
  assert.equal(routes.canAccessRoute("astronaut", "#/unknown"), false);
});

test("ROUTES use exactly 'medical_officer' (never 'medical-officer')", () => {
  for (const route of ROUTES) {
    for (const role of route.roles) assert.ok(core.VALID_ROLES.includes(role), `${route.path}: ${role}`);
  }
});

// ---- display helpers ----------------------------------------------------------------

test("role labels and avatar initials", () => {
  assert.equal(core.roleLabel("medical_officer"), "Medical Officer");
  assert.equal(core.roleLabel("astronaut"), "Astronaut");
  assert.equal(core.initialsOf("Cmdr. Sami Haddad"), "SH");
  assert.equal(core.initialsOf("Dr. Lena Ortiz"), "LO");
  assert.equal(core.initialsOf("Mei Chen"), "MC");
  assert.equal(core.initialsOf(""), "?");
});
