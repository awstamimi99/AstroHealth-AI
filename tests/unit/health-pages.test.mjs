// tests/unit/health-pages.test.mjs — #/physical and #/wellbeing page modules (Sprint 6),
// on the shared fake DOM. Ready data comes from the real services over the seeded mock.
// Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { FakeElement, all, byClass, byTag, byId, sectionOf } from "./fake-dom.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const physicalPage = await import("../../js/pages/physical-health.js");
const wellbeingPage = await import("../../js/pages/wellbeing.js");
const { parseHealthRoute } = await import("../../js/components/health-view.js");
const physSvc = await import("../../js/services/physical-health-service.js");
const wbSvc = await import("../../js/services/wellbeing-service.js");
const mock = await import("../../js/db/mock-repositories.js");

const NOW = Date.UTC(2026, 10, 14, 15, 30);
const REYES = { role: "astronaut", userId: "u-reyes", astronautId: "a-04", displayName: "Jonas Reyes" };
const HADDAD = { role: "astronaut", userId: "u-haddad", astronautId: "a-01", displayName: "Cmdr. Sami Haddad" };
const MO = { role: "medical_officer", userId: "u-medofficer", astronautId: "", displayName: "Dr. Lena Ortiz" };
const BANNED = /\b(healthy|unhealthy|safe\b|normal|abnormal|diagnosed|medically cleared|fit for duty|risk score|health score|depression|anxiety)/i;

await mock.resetMock({ now: NOW });
const repos = { usersRepo: mock.usersRepo, astronautsRepo: mock.astronautsRepo, measurementsRepo: mock.measurementsRepo, dailySummariesRepo: mock.dailySummariesRepo, alertsRepo: mock.alertsRepo, wellbeingRepo: mock.wellbeingRepo, cognitiveRepo: mock.cognitiveRepo, eventsRepo: mock.eventsRepo };
const physical = physSvc.createPhysicalHealthService({ repos });
const wellbeing = wbSvc.createWellbeingService({ repos, withTransaction: mock.withTransaction });
const PHYS_REYES = await physical.getOwnPhysicalHealth(REYES, { now: NOW });
const PHYS_MO_CHEN = await physical.getCrewMemberPhysicalHealth(MO, "AH-03", { now: NOW });
const PICKER = await physical.listCrewForPhysicalSelection(MO, { now: NOW });
const WB_HADDAD = await wellbeing.getOwnWellbeing(HADDAD, { now: NOW });
const WB_MO_HADDAD = await wellbeing.getCrewMemberSharedWellbeing(MO, "AH-01", { now: NOW });

const flush = () => new Promise((r) => setTimeout(r, 0));
function counting(value) {
  const fn = async (...args) => { fn.calls.push(args); return typeof value === "function" ? value(...args) : value; };
  fn.calls = [];
  return fn;
}
function deferredFn() {
  const calls = [];
  const fn = (...args) => new Promise((resolve) => calls.push({ args, resolve }));
  return { fn, calls };
}
const radiosNamed = (root, name) => all(root, (e) => e.tagName === "INPUT" && e.getAttribute("name") === name);
function answerAll(root, values = { mood: 4, stress: 3, sleepQuality: 4, fatigue: 2, isolation: 1, wellbeing: 4 }, share = "private") {
  for (const [field, v] of Object.entries(values)) for (const r of radiosNamed(root, field)) r.checked = r.getAttribute("value") === String(v);
  for (const r of radiosNamed(root, "share")) r.checked = share !== null && r.getAttribute("value") === share; // null = leave unanswered
}
const form = (root) => byTag(root, "form")[0];

// =====================================================================================
// Routing
// =====================================================================================

test("41–42. strict route parsing for #/physical and #/wellbeing", () => {
  for (const base of ["physical", "wellbeing"]) {
    assert.deepEqual(parseHealthRoute(`#/${base}`, base), { view: "base" });
    assert.deepEqual(parseHealthRoute(`#/${base}?x=1`, base), { view: "base" });
    assert.deepEqual(parseHealthRoute(`#/${base}/AH-04`, base), { view: "detail", crewId: "AH-04" });
    for (const bad of [`#/${base}/a-04`, `#/${base}/AH-4`, `#/${base}/ah-04`, `#/${base}/AH-004`, `#/${base}/AH-04/`, `#/${base}/AH-04/x`, `#/${base}/AH-04?x`, `#/${base}/`, `#/${base}/u-reyes`, "", null]) {
      assert.deepEqual(parseHealthRoute(bad, base), { view: "invalid" }, String(bad));
    }
  }
  assert.deepEqual(parseHealthRoute("#/wellbeing/AH-01", "physical"), { view: "invalid" }, "other base never matches");
});

test("43. astronaut nested URLs show not-found and call no service at all", async () => {
  for (const hash of ["#/physical/AH-01", "#/physical/a-01", "#/physical/AH-04"]) {
    const loaders = { loadOwn: counting(PHYS_REYES), loadCrewMember: counting(PHYS_MO_CHEN), listCrew: counting(PICKER) };
    const c = new FakeElement("div");
    await physicalPage.createPhysicalHealthRenderer(loaders)(c, REYES, { hash });
    assert.match(c.textContent, /Crew member not found/);
    assert.equal(loaders.loadOwn.calls.length + loaders.loadCrewMember.calls.length + loaders.listCrew.calls.length, 0, hash);
    assert.doesNotMatch(c.textContent, /Reyes|Chen|Haddad|bpm/);
  }
  for (const hash of ["#/wellbeing/AH-01", "#/wellbeing/x"]) {
    const loaders = { loadOwn: counting(WB_HADDAD), saveCheckin: counting({}), loadShared: counting(WB_MO_HADDAD), listCrew: counting(PICKER) };
    const c = new FakeElement("div");
    await wellbeingPage.createWellbeingRenderer(loaders)(c, REYES, { hash });
    assert.match(c.textContent, /Crew member not found/);
    assert.equal(Object.values(loaders).reduce((n, f) => n + f.calls.length, 0), 0, hash);
  }
});

test("44. officer base routes show the picker: names + public crew IDs only, nested links", async () => {
  for (const [render, base] of [
    [physicalPage.createPhysicalHealthRenderer({ loadOwn: counting(null), loadCrewMember: counting(null), listCrew: counting(PICKER) }), "physical"],
    [wellbeingPage.createWellbeingRenderer({ loadOwn: counting(null), saveCheckin: counting(null), loadShared: counting(null), listCrew: counting(PICKER) }), "wellbeing"],
  ]) {
    const c = new FakeElement("div");
    await render(c, MO, { hash: `#/${base}` });
    const links = byTag(c, "a").map((a) => [a.getAttribute("href"), a.textContent]);
    assert.deepEqual(links, [[`#/${base}/AH-01`, "Sami Haddad · AH-01"], [`#/${base}/AH-02`, "Aisha Karim · AH-02"], [`#/${base}/AH-03`, "Mei Chen · AH-03"], [`#/${base}/AH-04`, "Jonas Reyes · AH-04"]]);
    assert.doesNotMatch(c.textContent, /bpm|ALT-|Mood/);
  }
  const invalid = new FakeElement("div");
  const loaders = { loadOwn: counting(null), loadCrewMember: counting(null), listCrew: counting(PICKER) };
  await physicalPage.createPhysicalHealthRenderer(loaders)(invalid, MO, { hash: "#/physical/a-04" });
  assert.match(invalid.textContent, /Crew member not found/);
  assert.equal(loaders.loadCrewMember.calls.length + loaders.listCrew.calls.length, 0);
});

// =====================================================================================
// Physical page
// =====================================================================================

test("physical (astronaut): sections, baseline sentences, 7/30 toggle, data tables, no banned wording", async () => {
  const c = new FakeElement("div");
  await physicalPage.createPhysicalHealthRenderer({ loadOwn: counting(PHYS_REYES), loadCrewMember: counting(null), listCrew: counting(null) })(c, REYES, { hash: "#/physical" });
  const order = all(c, (e) => e.tagName === "SECTION").map((s) => s.getAttribute("aria-labelledby"));
  assert.deepEqual(order, ["physical-title", "physical-body-map-title", "physical-latest-title", "physical-trends-title", "physical-quality-title", "physical-alerts-title"]);
  assert.equal(byId(c, "physical-title").textContent, "Your physical health");
  const latest = sectionOf(c, "physical-latest-title");
  assert.match(latest.textContent, /\d+ bpm (above|below) the stored personal baseline of \d+ bpm\.|The same as the stored personal baseline/);
  assert.match(latest.textContent, /Systolic: .*Diastolic: /);
  assert.match(latest.textContent, /not a clinical assessment/);
  const trends = sectionOf(c, "physical-trends-title");
  const rows = () => byTag(byTag(sectionOf(c, "physical-trends-title"), "table")[0], "tr").length - 1;
  assert.equal(rows(), 7, "7-day view by default");
  const [b7, b30] = byTag(trends, "button");
  assert.equal(b7.getAttribute("aria-pressed"), "true");
  b30.click();
  assert.equal(rows(), 30);
  assert.equal(byTag(sectionOf(c, "physical-trends-title"), "button")[1].getAttribute("aria-pressed"), "true");
  assert.ok(byClass(c, "health-bars").every((b) => b.getAttribute("aria-hidden") === "true"));
  assert.match(sectionOf(c, "physical-trends-title").textContent, /include readings marked suspect/);
  assert.match(sectionOf(c, "physical-alerts-title").textContent, /ALT-0190/);
  assert.doesNotMatch(c.textContent, BANNED);
  assert.doesNotMatch(c.textContent, /steps|activity/i);
});

test("physical (officer): read-only header with links; focus on the name after in-app navigation", async () => {
  globalThis.document.activeElement = null;
  const c = new FakeElement("div");
  await physicalPage.createPhysicalHealthRenderer({ loadOwn: counting(null), loadCrewMember: counting(PHYS_MO_CHEN), listCrew: counting(null) })(c, MO, { hash: "#/physical/AH-03", focus: true });
  assert.equal(byId(c, "physical-title").textContent, "Mei Chen · AH-03");
  assert.equal(globalThis.document.activeElement, byId(c, "physical-title"));
  assert.match(c.textContent, /read-only view/);
  assert.deepEqual(byTag(sectionOf(c, "physical-title"), "a").map((a) => a.getAttribute("href")), ["#/crew/AH-03", "#/wellbeing/AH-03", "#/physical"]);
});

test("45. database strings are inserted as text, never markup", async () => {
  const data = structuredClone(PHYS_REYES);
  data.profile.name = "<img src=x onerror=alert(1)>";
  data.alerts.items[0].explanation = "<script>alert(2)</script>";
  const c = new FakeElement("div");
  await physicalPage.createPhysicalHealthRenderer({ loadOwn: counting(data), loadCrewMember: counting(null), listCrew: counting(null) })(c, REYES, { hash: "#/physical" });
  assert.equal(byTag(c, "img").length + byTag(c, "script").length, 0);
  assert.match(c.textContent, /<img src=x onerror=alert\(1\)>/);
});

test("48. a late result after navigation is dropped (physical + wellbeing)", async () => {
  const d = deferredFn();
  const c = new FakeElement("div");
  const ctrl = new AbortController();
  const pending = physicalPage.createPhysicalHealthRenderer({ loadOwn: d.fn, loadCrewMember: d.fn, listCrew: d.fn })(c, REYES, { hash: "#/physical", signal: ctrl.signal });
  ctrl.abort();
  const other = new FakeElement("p");
  other.append("Other route");
  c.replaceChildren(other);
  d.calls[0].resolve(PHYS_REYES);
  await pending;
  await flush();
  assert.equal(c.textContent, "Other route");
  const w = deferredFn();
  const c2 = new FakeElement("div");
  const ctrl2 = new AbortController();
  const p2 = wellbeingPage.createWellbeingRenderer({ loadOwn: w.fn, saveCheckin: w.fn, loadShared: w.fn, listCrew: w.fn })(c2, HADDAD, { hash: "#/wellbeing", signal: ctrl2.signal });
  ctrl2.abort();
  c2.replaceChildren(other);
  w.calls[0].resolve(WB_HADDAD);
  await p2;
  await flush();
  assert.equal(c2.textContent, "Other route");
});

// =====================================================================================
// Wellbeing page
// =====================================================================================

async function renderOwnWellbeing(saveCheckin, loadOwn = counting(WB_HADDAD)) {
  const c = new FakeElement("div");
  await wellbeingPage.createWellbeingRenderer({ loadOwn, saveCheckin, loadShared: counting(null), listCrew: counting(null) })(c, HADDAD, { hash: "#/wellbeing" });
  return { c, loadOwn };
}

test("wellbeing (astronaut): form with 7 fieldsets/legends, no preselected answer or sharing default, history with labels", async () => {
  const { c } = await renderOwnWellbeing(counting({ status: "saved" }));
  const fieldsets = byTag(form(c), "fieldset");
  assert.equal(fieldsets.length, 7);
  assert.deepEqual(fieldsets.map((f) => byTag(f, "legend")[0].textContent), ["Mood", "Stress", "Sleep quality", "Fatigue", "Feeling isolated", "Overall wellbeing", "Who can see this check-in?"]);
  assert.equal(radiosNamed(c, "mood").length, 5);
  assert.equal(radiosNamed(c, "stress").length, 11);
  assert.ok(all(c, (e) => e.tagName === "INPUT").every((i) => !i.checked && !i.hasAttribute("checked")), "nothing preselected");
  assert.deepEqual(radiosNamed(c, "share").map((r) => r.getAttribute("value")), ["private", "shared"]);
  assert.match(sectionOf(c, "checkin-title").textContent, /You already checked in today \(UTC\) at 08:00 UTC/);
  const history = sectionOf(c, "wellbeing-history-title");
  assert.match(history.textContent, /Private/);
  assert.match(history.textContent, /Shared with the Medical Officer/);
  assert.match(sectionOf(c, "wellbeing-summary-title").textContent, /Based on your own check-ins/);
  assert.doesNotMatch(c.textContent, BANNED);
});

test("46. errors: field-level messages, aria-invalid, focused error summary", async () => {
  const save = counting(async (session, answers) => wellbeing.createCheckin(session, answers, { now: NOW }));
  const { c } = await renderOwnWellbeing(save);
  answerAll(c, { mood: 4 }, null);
  form(c).dispatch("submit");
  await flush(); await flush();
  const summary = byClass(c, "health-error-summary")[0];
  assert.equal(summary.hasAttribute("hidden"), false);
  assert.equal(globalThis.document.activeElement, summary);
  assert.match(summary.textContent, /Please answer 6 questions/);
  const stress = byTag(form(c), "fieldset")[1];
  assert.equal(stress.getAttribute("aria-invalid"), "true");
  assert.match(stress.getAttribute("aria-describedby"), /checkin-stress-error/);
  assert.equal(byTag(form(c), "fieldset")[0].getAttribute("aria-invalid"), null, "answered question has no error");
});

test("47. a failed save shows an alert with Retry and keeps the answers; never a success", async () => {
  const save = counting({ status: "unavailable", reason: "database_error" });
  const { c } = await renderOwnWellbeing(save);
  answerAll(c, undefined, "private");
  form(c).dispatch("submit");
  await flush(); await flush();
  const status = byClass(c, "health-status")[0];
  assert.equal(status.getAttribute("role"), "alert");
  assert.match(status.textContent, /not saved/);
  assert.doesNotMatch(status.textContent, /Check-in saved/);
  assert.equal(radiosNamed(c, "mood").find((r) => r.checked).getAttribute("value"), "4", "answers kept");
  assert.equal(radiosNamed(c, "share").find((r) => r.checked).getAttribute("value"), "private");
  assert.equal(all(status, (e) => e.hasAttribute("data-retry")).length, 1);
});

test("39 + 38 (page). share confirmation, then same-day confirmation, then save — each for this attempt only", async () => {
  const responses = [{ status: "confirm_share" }, { status: "confirm_same_day", existingAt: Date.UTC(2026, 10, 14, 8) }, { status: "saved", checkin: { timestamp: NOW, shared: true } }];
  const save = counting(() => responses.shift());
  const loadOwn = counting(WB_HADDAD);
  const { c } = await renderOwnWellbeing(save, loadOwn);
  answerAll(c, undefined, "shared");
  form(c).dispatch("submit");
  await flush(); await flush();
  let box = byClass(c, "health-confirm")[0];
  assert.match(box.textContent, /All six scores will be shared with the Medical Officer\. This check-in can't be edited, and sharing can't be changed or revoked in this version\./);
  assert.equal(globalThis.document.activeElement, byId(c, "checkin-confirm-title"));
  assert.deepEqual(save.calls[0][2], { confirmShare: false, confirmSameDay: false });
  all(box, (e) => e.hasAttribute("data-confirm"))[0].click();
  await flush(); await flush();
  assert.deepEqual(save.calls[1][2], { confirmShare: true, confirmSameDay: false });
  box = byClass(c, "health-confirm")[0];
  assert.match(box.textContent, /You already checked in today.*08:00 UTC.*Add another check-in\?/);
  all(box, (e) => e.hasAttribute("data-confirm"))[0].click();
  await flush(); await flush(); await flush();
  assert.deepEqual(save.calls[2][2], { confirmShare: true, confirmSameDay: true });
  assert.equal(save.calls.length, 3, "no save after only one of the two confirmations");
  const status = byClass(c, "health-status")[0];
  assert.match(status.textContent, /Check-in saved and shared with the Medical Officer\./);
  assert.ok(radiosNamed(c, "mood").every((r) => !r.checked), "form cleared after success");
  assert.equal(loadOwn.calls.length, 2, "history refreshed after save");
  // Next attempt starts without confirmations.
  responses.push({ status: "confirm_share" });
  answerAll(c, undefined, "shared");
  form(c).dispatch("submit");
  await flush(); await flush();
  assert.deepEqual(save.calls[3][2], { confirmShare: false, confirmSameDay: false });
});

test("cancelling a confirmation saves nothing and returns focus to the submit button", async () => {
  const save = counting({ status: "confirm_share" });
  const { c } = await renderOwnWellbeing(save);
  answerAll(c, undefined, "shared");
  form(c).dispatch("submit");
  await flush(); await flush();
  all(byClass(c, "health-confirm")[0], (e) => e.hasAttribute("data-cancel"))[0].click();
  assert.equal(byClass(c, "health-confirm")[0].hasAttribute("hidden"), true);
  assert.equal(globalThis.document.activeElement, all(c, (e) => e.hasAttribute("data-submit"))[0]);
  assert.equal(save.calls.length, 1);
});

test("35 (page). double submit while saving calls the service once; busy state is set", async () => {
  const d = deferredFn();
  const { c } = await renderOwnWellbeing(d.fn);
  answerAll(c, undefined, "private");
  form(c).dispatch("submit");
  form(c).dispatch("submit");
  form(c).dispatch("submit");
  assert.equal(d.calls.length, 1);
  assert.equal(form(c).getAttribute("aria-busy"), "true");
  assert.equal(all(c, (e) => e.hasAttribute("data-submit"))[0].disabled, true);
  d.calls[0].resolve({ status: "saved", checkin: { timestamp: NOW, shared: false } });
  await flush(); await flush();
  assert.equal(form(c).getAttribute("aria-busy"), "false");
  assert.match(byClass(c, "health-status")[0].textContent, /It is private/);
});

test("wellbeing (officer): shared only, permanent privacy notice, shared-only summary, no form", async () => {
  const c = new FakeElement("div");
  await wellbeingPage.createWellbeingRenderer({ loadOwn: counting(null), saveCheckin: counting(null), loadShared: counting(WB_MO_HADDAD), listCrew: counting(null) })(c, MO, { hash: "#/wellbeing/AH-01" });
  assert.equal(byTag(c, "form").length, 0);
  assert.match(c.textContent, /Private check-ins and the private journal are never shown or counted\./);
  assert.match(sectionOf(c, "wellbeing-summary-title").textContent, /Based only on check-ins shared by the astronaut\./);
  assert.doesNotMatch(sectionOf(c, "wellbeing-history-title").textContent, /Private\b(?! check-ins and)/, "no private badge in the officer view");
  assert.equal(byClass(c, "health-checkin").length, WB_MO_HADDAD.checkins.items.length);
  assert.doesNotMatch(c.textContent, BANNED);
});

test("49 + 53. pages import no database module; no banned wording in page/component sources", () => {
  for (const f of ["js/pages/physical-health.js", "js/pages/wellbeing.js", "js/components/health-view.js"]) {
    const src = read(f);
    for (const p of [...src.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1])) {
      assert.doesNotMatch(p, /\/db\//, `${f}: ${p}`);
      if (f.startsWith("js/pages/")) assert.match(p, /^\.\.\/(services|components|core)\//, `${f}: ${p}`);
    }
    assert.doesNotMatch(src, /innerHTML|create\w+Service\(|mock-repositories/, f);
    const strings = [...src.matchAll(/"([^"\n]*)"|`([^`]*)`/g)].map((m) => m[1] ?? m[2]).join("\n");
    assert.doesNotMatch(strings, BANNED, f);
  }
});

test("baseline sentences: descriptive numeric wording, correct plural, no category words", async () => {
  const { baselineSentence } = await import("../../js/components/health-view.js");
  assert.equal(baselineSentence(4, 72, "bpm"), "4 bpm above the stored personal baseline of 72 bpm.");
  assert.equal(baselineSentence(-1, 98, "%"), "1 percentage point below the stored personal baseline of 98 %.");
  assert.equal(baselineSentence(-2, 98, "%"), "2 percentage points below the stored personal baseline of 98 %.");
  assert.equal(baselineSentence(0, 7, "h", 1), "The same as the stored personal baseline of 7.0 h.");
  assert.equal(baselineSentence(null, 72, "bpm"), "No stored personal baseline to compare with.");
});
