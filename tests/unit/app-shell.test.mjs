// tests/unit/app-shell.test.mjs — Sprint 3: routing, role permissions and
// shell-level mission context. Pure modules only (no DOM).
// Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// js/db/index.js (imported by the mission service) expects these globals.
globalThis.self = globalThis;
globalThis.BroadcastChannel = class { postMessage() {} addEventListener() {} close() {} };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

const { ROUTES, DEFAULT_ROUTE } = await import("../../js/core/config.js");
const routes = await import("../../js/auth/routes.js");
const { checkRoute } = await import("../../js/auth/guard.js");
const { ROLES } = await import("../../js/db/index.js");
const { describeMission, getMissionContext, MISSION_UNAVAILABLE } = await import("../../js/services/mission-service.js");

const REQUIRED = ["#/overview", "#/physical", "#/wellbeing", "#/crew", "#/history", "#/simulation", "#/alerts", "#/reports", "#/settings"];
const ASTRONAUT_ROUTES = ["#/overview", "#/physical", "#/wellbeing", "#/history", "#/alerts", "#/reports", "#/settings"];
const CANONICAL = [ROLES.ASTRONAUT, ROLES.MEDICAL_OFFICER];
const paths = (list) => list.map((r) => r.path);
const astronaut = { role: "astronaut", userId: "u-haddad" };
const officer = { role: "medical_officer", userId: "u-medofficer" };

test("1. every required route exists exactly once (and no others)", () => {
  assert.deepEqual([...paths(ROUTES)].sort(), [...REQUIRED].sort());
  assert.equal(new Set(paths(ROUTES)).size, ROUTES.length);
  for (const r of ROUTES) {
    for (const field of ["label", "title", "icon"]) assert.ok(typeof r[field] === "string" && r[field], `${r.path}.${field}`);
  }
});

test("2. every route lists only canonical roles, at least one", () => {
  assert.deepEqual(CANONICAL, ["astronaut", "medical_officer"]);
  for (const r of ROUTES) {
    assert.ok(Array.isArray(r.roles) && r.roles.length > 0, r.path);
    for (const role of r.roles) assert.ok(CANONICAL.includes(role), `${r.path}: ${role}`);
    assert.equal(Boolean(r.moOnly), r.roles.length === 1 && r.roles[0] === "medical_officer", `${r.path} moOnly flag`);
  }
});

test("3–4. astronaut navigation excludes Crew Monitor and Simulation Center", () => {
  assert.deepEqual(paths(routes.routesForRole("astronaut")), ASTRONAUT_ROUTES);
  for (const hash of ["#/crew", "#/simulation"]) {
    assert.equal(routes.canAccessRoute("astronaut", hash), false, hash);
    assert.deepEqual(checkRoute(astronaut, hash).allowed, false, hash);
    assert.ok(checkRoute(astronaut, hash).route, `${hash} is a known route → Access denied, not a redirect`);
  }
});

test("5. medical_officer navigation includes every required route, in config order", () => {
  assert.deepEqual(paths(routes.routesForRole("medical_officer")), paths(ROUTES));
  for (const hash of REQUIRED) assert.equal(checkRoute(officer, hash).allowed, true, hash);
});

test("6. unknown routes are rejected for every role", () => {
  for (const hash of ["#/admin", "#/dashboard", "#/crewmonitor", "#/overview2", "#/Overview", "#/CREW"]) {
    assert.equal(routes.findRoute(hash), null, hash);
    for (const role of CANONICAL) assert.equal(routes.canAccessRoute(role, hash), false, `${role} ${hash}`);
  }
});

test("7. missing or empty routes resolve to the home route (#/overview)", () => {
  for (const hash of ["", "#", "#/", undefined, null]) {
    assert.equal(routes.findRoute(hash), null, String(hash));
    assert.equal(checkRoute(astronaut, hash).route, null, "→ shell replaces with home");
  }
  for (const role of CANONICAL) assert.equal(routes.homeRouteFor(role), "#/overview");
});

test("8. nested and query variants normalize to their base route only", () => {
  assert.equal(routes.normalizeRoute("#/crew/AH-01"), "#/crew");
  assert.equal(routes.normalizeRoute("#/history?range=7d"), "#/history");
  assert.equal(routes.normalizeRoute("#/alerts/ALT-0190/actions"), "#/alerts");
  for (const bad of ["#crew", "#//crew", "#/ crew", "#/crew#x", "#/crew%2F", "/crew", "crew", "#/-crew", "#/1crew", "#/crew\n", "#/crew\\x"]) {
    assert.equal(routes.normalizeRoute(bad), "", JSON.stringify(bad));
  }
});

test("9. external or malformed returnTo values are rejected", () => {
  const rejected = [
    "https://evil.example", "//evil.example", "javascript:alert(1)", "app.html#/overview", "/app.html",
    "#/overview?x=1", "#/crew/AH-01", "#/unknown", "#/", "", " #/overview", "#/overview ", "%23%2Foverview",
    null, undefined, 42, ["#/overview"], { toString: () => "#/overview" },
  ];
  for (const value of rejected) assert.equal(routes.safeReturnTo(value), null, String(value));
  for (const hash of REQUIRED) assert.equal(routes.safeReturnTo(hash), hash);
});

test("10. malformed hashes can't bypass the astronaut guard", () => {
  const attempts = [
    "#/crew/", "#/crew?role=medical_officer", "#/crew/../overview", "#/simulation/x", "#/simulation?",
    "#/CREW", "#/Crew", "#/crew%00", "#/crew\u0000", "#/c%72ew", " #/crew", "#/crew\t",
  ];
  for (const hash of attempts) {
    const { route, allowed } = checkRoute(astronaut, hash);
    assert.equal(allowed, false, JSON.stringify(hash));
    if (route) assert.ok(["#/crew", "#/simulation"].includes(route.path), "only ever the restricted route itself");
  }
  for (const role of ["medical-officer", "Medical Officer", "admin", "", undefined, null]) {
    assert.equal(routes.canAccessRoute(role, "#/crew"), false, String(role));
    assert.equal(checkRoute({ role }, "#/overview").allowed, false, `${role} gets no route at all`);
    assert.deepEqual(routes.routesForRole(role), []);
  }
  assert.equal(checkRoute(null, "#/overview").allowed, false, "no session, no access");
});

test("11. role names never use medical-officer, 'medical officer' or admin in shell code", () => {
  for (const file of ["js/core/config.js", "js/auth/routes.js", "js/auth/guard.js", "js/pages/app-shell.js", "js/services/mission-service.js", "app.html"]) {
    const text = read(file);
    assert.doesNotMatch(text, /medical-officer/, file);
    assert.doesNotMatch(text, /["']admin["']/i, file);
    assert.doesNotMatch(text, /role\s*[:=]+\s*["']medical officer["']/i, file);
  }
});

test("12. the default route is #/overview and open to both canonical roles", () => {
  assert.equal(DEFAULT_ROUTE, "#/overview");
  for (const role of CANONICAL) assert.equal(routes.canAccessRoute(role, DEFAULT_ROUTE), true, role);
});

// ---- Shell markup: no fake values -------------------------------------------

test("app.html has no hardcoded unread count or fake mission identifier", () => {
  const html = read("app.html");
  assert.doesNotMatch(html, /topbar__bell-count/, "no bell badge");
  assert.doesNotMatch(html, /\d+\s+unread/i, "no 'N unread' label");
  assert.doesNotMatch(html, /DEMO-1|ODYSSEY/, "mission name comes from the data, not the markup");
  assert.match(html, /data-mission-name/);
  assert.match(html, /data-mission-day/);
  assert.match(html, /Not a medical device/, "disclaimer stays visible");
  assert.match(html, /<main[^>]*id="main"/);
  assert.match(html, /class="skip-link" href="#main"/);
});

test("the shell imports the database only through services (never js/db directly)", () => {
  const shell = read("js/pages/app-shell.js");
  assert.doesNotMatch(shell, /\/db\//, "pages call services, not repositories");
  assert.doesNotMatch(shell, /innerHTML/);
  const service = read("js/services/mission-service.js");
  const imports = [...service.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["../db/index.js"]);
});

// ---- Mission context ---------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const TODAY = Date.UTC(2026, 10, 14, 15, 30); // 14 Nov 2026, 15:30 UTC
const START = Date.UTC(2026, 10, 14) - 146 * DAY; // seed: Mission Day 147 today

test("mission: seeded shape → name and Mission Day 147", () => {
  assert.deepEqual({ ...describeMission({ name: "ODYSSEY-7", startDate: START, missionDayOverride: 0 }, TODAY) }, { available: true, name: "ODYSSEY-7", missionDay: 147 });
  assert.equal(describeMission({ name: "ODYSSEY-7", startDate: START }, TODAY + DAY).missionDay, 148, "next UTC day");
  assert.equal(describeMission({ name: "ODYSSEY-7", startDate: TODAY }, TODAY).missionDay, 1, "start day is Day 1");
});

test("mission: a positive integer override wins; other overrides are ignored", () => {
  assert.equal(describeMission({ name: "M", startDate: START, missionDayOverride: 12 }, TODAY).missionDay, 12);
  for (const override of [0, -3, 1.5, "12", null]) {
    assert.equal(describeMission({ name: "M", startDate: START, missionDayOverride: override }, TODAY).missionDay, 147, String(override));
  }
});

test("mission: missing or malformed data → 'Not available', never invented", () => {
  for (const value of [null, undefined, "ODYSSEY-7", 7, [], {}, { name: "" }, { name: "   " }, { name: 7 }, { name: "x".repeat(41) }]) {
    assert.equal(describeMission(value, TODAY), MISSION_UNAVAILABLE, JSON.stringify(value));
  }
  assert.deepEqual({ ...MISSION_UNAVAILABLE }, { available: false, name: "Not available", missionDay: null });
  // A name but no usable date: show the name, not a made-up day.
  for (const startDate of [undefined, "2026-01-01", NaN, Infinity, TODAY + 3 * DAY]) {
    const m = describeMission({ name: "ODYSSEY-7", startDate }, TODAY);
    assert.equal(m.name, "ODYSSEY-7");
    assert.equal(m.missionDay, null, String(startDate));
  }
});

test("mission: getMissionContext without a valid role returns 'Not available' without reading the database", async () => {
  for (const session of [null, undefined, {}, { role: "admin" }, { role: "medical-officer" }]) {
    assert.equal(await getMissionContext(session), MISSION_UNAVAILABLE);
  }
});

test("mission: getMissionContext never throws when the database is unavailable", async () => {
  // Node has no IndexedDB, so settingsRepo.get() fails → safe fallback.
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await getMissionContext(astronaut), MISSION_UNAVAILABLE);
    assert.equal(await getMissionContext(officer), MISSION_UNAVAILABLE);
  } finally {
    console.warn = warn;
  }
});

// ---- Sprint 4: route views ------------------------------------------------------

test("app-shell route views are chosen by route AND role; every other route keeps its placeholder", () => {
  const shell = read("js/pages/app-shell.js");
  assert.match(shell, /import \{ renderAstronautOverview \} from "\.\/astronaut-overview\.js";/);
  assert.match(shell, /import \{ renderMedicalOfficerOverview \} from "\.\/officer-overview\.js";/);
  assert.match(shell, /import \{ renderCrewMonitor \} from "\.\/crew-monitor\.js";/);
  assert.match(shell, /import \{ renderPhysicalHealth \} from "\.\/physical-health\.js";/);
  assert.match(shell, /import \{ renderWellbeing \} from "\.\/wellbeing\.js";/);
  assert.match(shell, /import \{ renderSimulationCenter \} from "\.\/simulation-center\.js";/);
  const map = /const ROUTE_VIEWS = Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(shell);
  assert.ok(map, "ROUTE_VIEWS map exists");
  const entries = [...map[1].matchAll(/"(#\/[a-z-]+)":\s*Object\.freeze\(\{([^}]*)\}\)/g)].map((m) => [
    m[1],
    Object.fromEntries([...m[2].matchAll(/(\w+):\s*(\w+)/g)].map((x) => [x[1], x[2]])),
  ]);
  assert.deepEqual(entries, [
    ["#/overview", { astronaut: "renderAstronautOverview", medical_officer: "renderMedicalOfficerOverview" }],
    ["#/crew", { medical_officer: "renderCrewMonitor" }],
    ["#/physical", { astronaut: "renderPhysicalHealth", medical_officer: "renderPhysicalHealth" }],
    ["#/wellbeing", { astronaut: "renderWellbeing", medical_officer: "renderWellbeing" }],
    ["#/simulation", { medical_officer: "renderSimulationCenter" }],
  ]);
  // Sprint 4 astronaut Overview unchanged; no astronaut view for #/crew.
  assert.equal(entries[0][1].astronaut, "renderAstronautOverview");
  assert.ok(!("astronaut" in entries[1][1]), "astronauts have no #/crew view");
  assert.ok(!("astronaut" in entries[4][1]), "astronauts have no #/simulation view (Sprint 7)");
  // Unmapped routes still render placeholderView, and route guards run before any view.
  assert.match(shell, /const renderView = ROUTE_VIEWS\[route\.path\]\?\.\[current\.role\];[\s\S]*?else \{\s*clear\(view\)\.append\(placeholderView\(route\)\);/);
  assert.ok(shell.indexOf("if (!allowed)") < shell.indexOf("const renderView = ROUTE_VIEWS"), "guard runs before any view");
  for (const r of ROUTES.filter((x) => !["#/overview", "#/crew", "#/physical", "#/wellbeing", "#/simulation"].includes(x.path))) assert.ok(!entries.some(([p]) => p === r.path), r.path);
});

test("30. astronauts can't reach #/crew or any nested crew-detail route (Access denied before any view)", () => {
  const astronaut = { role: "astronaut", userId: "u-haddad" };
  const officer = { role: "medical_officer", userId: "u-medofficer" };
  for (const hash of ["#/crew", "#/crew/AH-01", "#/crew/AH-04", "#/crew/a-01", "#/crew/AH-01/x", "#/crew?x=1"]) {
    const a = checkRoute(astronaut, hash);
    assert.equal(a.allowed, false, hash);
    assert.equal(a.route.path, "#/crew", `${hash} → Access denied for the crew route`);
    assert.equal(checkRoute(officer, hash).allowed, true, hash);
  }
});

test("app-shell aborts the previous view on every navigation and on logout (no stale overwrite)", () => {
  const shell = read("js/pages/app-shell.js");
  const render = /function renderRoute\([\s\S]*?\n  \}\n/.exec(shell)[0];
  const abortAt = render.indexOf("viewController?.abort()");
  assert.ok(abortAt > 0, "renderRoute aborts the previous view");
  assert.ok(abortAt < render.indexOf("checkRoute("), "…before deciding what to render");
  assert.match(render, /viewController = new AbortController\(\);\s*renderView\(clear\(view\), current, \{ signal: viewController\.signal, hash: location\.hash, focus \}\);/);
  assert.match(/function leave\([\s\S]*?\n  \}\n/.exec(shell)[0], /viewController\?\.abort\(\)/);
});

test("pages never import the database (login.js is the one documented Sprint 2 exception)", () => {
  const dir = join(ROOT, "js/pages");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const source = read(`js/pages/${file}`);
    const imports = [...source.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    const dbImports = imports.filter((p) => p.includes("/db/"));
    if (file === "login.js") assert.deepEqual(dbImports, ["../db/index.js"], "login.js: only the public index");
    else assert.deepEqual(dbImports, [], file);
  }
});

test("52. Sprint 6 keeps existing guards: astronauts still denied #/crew and #/simulation; nested health routes normalize to their base", () => {
  const astronaut = { role: "astronaut", userId: "u-haddad" };
  const officer = { role: "medical_officer", userId: "u-medofficer" };
  for (const hash of ["#/crew", "#/crew/AH-01", "#/simulation"]) assert.equal(checkRoute(astronaut, hash).allowed, false, hash);
  for (const hash of ["#/physical/AH-01", "#/wellbeing/AH-04", "#/physical/a-01"]) {
    // Allowed at route level for both roles — the PAGE then shows "not found" to astronauts (tested in health-pages.test.mjs).
    assert.equal(checkRoute(astronaut, hash).allowed, true, hash);
    assert.equal(checkRoute(officer, hash).allowed, true, hash);
    assert.ok(["#/physical", "#/wellbeing"].includes(checkRoute(officer, hash).route.path));
  }
});
