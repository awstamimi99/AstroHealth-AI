// tests/unit/crew-monitor-page.test.mjs — Medical Officer #/overview and
// #/crew / #/crew/AH-0n page modules, run against the shared fake DOM.
// Realistic data comes from the real crew service over the seeded mock.
// Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";

import { FakeElement, all, byClass, byTag, byId, sectionOf } from "./fake-dom.mjs";

const moPage = await import("../../js/pages/officer-overview.js");
const crewPage = await import("../../js/pages/crew-monitor.js");
const svc = await import("../../js/services/crew-monitor-service.js");
const mock = await import("../../js/db/mock-repositories.js");
const { describeMission } = await import("../../js/services/mission-service.js");

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 14, 15, 30);
const MO = { version: 1, userId: "u-medofficer", username: "medofficer", displayName: "Dr. Lena Ortiz", role: "medical_officer", astronautId: "", createdAt: NOW - HOUR, expiresAt: NOW + HOUR };
const BANNED = /\b(healthy|safe\b|normal health|medically cleared|fit for duty|no health risk|health score|nominal|diagnosis of)/i;

await mock.resetMock({ now: NOW });
const service = svc.createCrewMonitorService({
  repos: {
    usersRepo: mock.usersRepo, astronautsRepo: mock.astronautsRepo, measurementsRepo: mock.measurementsRepo,
    dailySummariesRepo: mock.dailySummariesRepo, alertsRepo: mock.alertsRepo, messagesRepo: mock.messagesRepo,
    wellbeingRepo: mock.wellbeingRepo, cognitiveRepo: mock.cognitiveRepo,
  },
  getMissionContext: async () => describeMission(await mock.settingsRepo.get("mission"), NOW),
});
const SNAPSHOT = await service.getCrewSnapshot(MO, { now: NOW });
const DETAIL_REYES = await service.getCrewMemberDetail(MO, "AH-04", { now: NOW });
const DETAIL_HADDAD = await service.getCrewMemberDetail(MO, "AH-01", { now: NOW });

const flush = () => new Promise((r) => setTimeout(r, 0));
function deferred() {
  const calls = [];
  const fn = (...args) => new Promise((resolve) => calls.push({ args, resolve }));
  return { fn, calls };
}
const renderMO = (data) => {
  const c = new FakeElement("div");
  return moPage.createMedicalOfficerOverviewRenderer({ loadSnapshot: async () => data })(c, MO, {}).then(() => c);
};
function renderCrew({ hash = "#/crew", snapshot = SNAPSHOT, detail = DETAIL_REYES, focus = false } = {}) {
  const c = new FakeElement("div");
  const seen = { snapshot: 0, detail: [] };
  const render = crewPage.createCrewMonitorRenderer({
    loadSnapshot: async () => { seen.snapshot += 1; return snapshot; },
    loadDetail: async (session, crewId) => { seen.detail.push(crewId); return typeof detail === "function" ? detail(crewId) : detail; },
  });
  return render(c, MO, { hash, focus }).then(() => ({ c, seen }));
}

// =====================================================================================
// Medical Officer #/overview
// =====================================================================================

test("MO overview: welcome, crew summary counts and the priority queue as an ordered list", async () => {
  const c = await renderMO(SNAPSHOT);
  const root = c.childNodes[0];
  assert.equal(root.getAttribute("aria-busy"), "false");
  assert.deepEqual(all(root, (e) => e.tagName === "SECTION").map((s) => s.getAttribute("aria-labelledby")), ["mo-welcome-title", "mo-scan-title", "mo-summary-title", "mo-queue-title"]);
  assert.match(byId(root, "mo-welcome-title").textContent, /Welcome, Dr\. Lena Ortiz/);
  const summary = sectionOf(root, "mo-summary-title");
  assert.match(summary.textContent, /4 crew members · 2 with open alerts\./);
  const counts = Object.fromEntries(byClass(summary, "crew-counts__item").map((li) => [li.childNodes[0].textContent, li.childNodes[1].textContent]));
  assert.deepEqual(counts, { "Critical alert": "0", Watch: "1", Info: "1", "Status unavailable": "0", "Data needs review": "0", "No open alerts": "2" });
  assert.deepEqual(byClass(summary, "crew-counts__link").map((a) => a.getAttribute("href")), ["#/alerts", "#/alerts", "#/alerts", "#/crew", "#/crew", "#/crew"]);
  assert.match(summary.textContent, /based on stored open alerts only\. This is not a health assessment\./i);
  const queue = byTag(sectionOf(root, "mo-queue-title"), "ol")[0];
  assert.ok(queue, "ordered list");
  const items = byTag(queue, "li");
  assert.equal(items.length, 2, "only crew needing attention");
  assert.match(items[0].textContent, /Jonas Reyes · AH-04.*Watch.*ALT-0190/);
  assert.match(items[1].textContent, /Mei Chen · AH-03.*Info.*ALT-0189/);
  assert.deepEqual(byTag(queue, "a").map((a) => a.getAttribute("href")), ["#/crew/AH-04", "#/crew/AH-03"]);
  assert.ok(byTag(root, "a").some((a) => a.getAttribute("href") === "#/crew"), "link to Crew Monitor");
  assert.doesNotMatch(root.textContent, BANNED);
  assert.doesNotMatch(root.textContent, /All astronaut health, medical, mission and simulation records shown here/); // banner removed; the footer disclaimer stays
});

test("MO overview: empty queue wording and status-unavailable retry", async () => {
  const quiet = structuredClone(SNAPSHOT);
  quiet.crew = quiet.crew.map((m) => ({ ...m, state: { ...svc.CREW_STATES.clear, reason: "x", note: svc.CREW_STATUS_NOTE } }));
  let c = await renderMO(quiet);
  assert.match(sectionOf(c, "mo-queue-title").textContent, /No crew member has open alerts or data needing review\./);
  const down = structuredClone(SNAPSHOT);
  down.summary = { ...down.summary, withOpenAlerts: null, unavailable: 4, watch: 0, info: 0, noOpenAlerts: 0 };
  c = await renderMO(down);
  assert.match(sectionOf(c, "mo-summary-title").textContent, /Open alerts couldn't be loaded/);
  assert.equal(byTag(sectionOf(c, "mo-summary-title"), "button").length, 1, "Retry");
});

test("MO overview: refusals show no crew data; a late result after navigation is dropped", async () => {
  for (const reason of ["account_mismatch", "database_error"]) {
    const c = await renderMO({ status: reason === "database_error" ? "unavailable" : "forbidden", reason });
    assert.doesNotMatch(c.textContent, /AH-0|Reyes|ALT-/);
    assert.equal(all(c, (e) => e.getAttribute("role") === "alert").length, 1);
  }
  const { fn, calls } = deferred();
  const c = new FakeElement("div");
  const controller = new AbortController();
  const pending = moPage.createMedicalOfficerOverviewRenderer({ loadSnapshot: fn })(c, MO, { signal: controller.signal });
  controller.abort();
  const other = new FakeElement("p");
  other.append("Another route");
  c.replaceChildren(other);
  calls[0].resolve(SNAPSHOT);
  await pending;
  await flush();
  assert.equal(c.textContent, "Another route");
});

// =====================================================================================
// Routing inside #/crew
// =====================================================================================

test("parseCrewRoute: strict AH-dd detail ids; anything else under #/crew/ is invalid", () => {
  assert.deepEqual(crewPage.parseCrewRoute("#/crew"), { view: "list" });
  assert.deepEqual(crewPage.parseCrewRoute("#/crew?sort=x"), { view: "list" });
  assert.deepEqual(crewPage.parseCrewRoute("#/crew/AH-01"), { view: "detail", crewId: "AH-01" });
  for (const bad of ["#/crew/a-01", "#/crew/AH-1", "#/crew/ah-01", "#/crew/AH-001", "#/crew/AH-01/", "#/crew/AH-01/x", "#/crew/AH-01?x", "#/crew/", "#/crew/%41H-01", "#/crew/../AH-01", "", null]) {
    assert.deepEqual(crewPage.parseCrewRoute(bad), { view: "invalid" }, String(bad));
  }
});

test("invalid nested crew routes never select an astronaut: not-found view, snapshot not loaded", async () => {
  const { c, seen } = await renderCrew({ hash: "#/crew/a-01", detail: (crewId) => ({ status: "not_found", reason: crewId ? "unknown_crew_id" : "invalid_crew_id" }) });
  assert.deepEqual(seen.detail, [""], "the service is asked with an empty id (it still verifies the officer)");
  assert.equal(seen.snapshot, 0);
  assert.match(c.textContent, /Crew member not found/);
  assert.ok(byTag(c, "a").some((a) => a.getAttribute("href") === "#/crew"), "back to the list");
  assert.doesNotMatch(c.textContent, /Reyes|Haddad|AH-04/);
  const unknown = await renderCrew({ hash: "#/crew/AH-99", detail: { status: "not_found", reason: "unknown_crew_id" } });
  assert.deepEqual(unknown.seen.detail, ["AH-99"]);
  assert.match(unknown.c.textContent, /No crew member with that ID exists/);
});

// =====================================================================================
// #/crew list
// =====================================================================================

test("crew list: one card per astronaut in rank order with HR, SpO₂, sleep (no blood pressure) and a detail link", async () => {
  const { c, seen } = await renderCrew();
  assert.equal(seen.snapshot, 1);
  assert.deepEqual(seen.detail, []);
  const cards = byClass(c, "crew-card");
  assert.deepEqual(cards.map((card) => byTag(card, "h3")[0].textContent), ["Jonas Reyes · AH-04", "Mei Chen · AH-03", "Sami Haddad · AH-01", "Aisha Karim · AH-02"]);
  for (const card of cards) {
    assert.deepEqual(byClass(card, "crew-vital__label").map((e) => e.textContent), ["Heart rate", "SpO₂", "Sleep duration"]);
    assert.doesNotMatch(card.textContent, /Blood pressure|mmHg/);
    assert.ok(byClass(card, "badge").some((b) => byTag(b, "svg").length === 1), "status badge has an icon");
    assert.match(card.textContent, /Last shared check-in .* UTC/);
  }
  assert.deepEqual(cards.map((card) => byTag(card, "a")[0].getAttribute("href")), ["#/crew/AH-04", "#/crew/AH-03", "#/crew/AH-01", "#/crew/AH-02"]);
  assert.match(cards[2].textContent, /1 awaiting acknowledgement/, "Haddad's verified pending message");
  assert.match(cards[0].textContent, /1 replied/);
  assert.ok(byClass(cards[0], "badge--warning").length >= 1, "Watch uses the warning token");
  assert.match(c.textContent, /Based on stored open alerts only\. This is not a health assessment\./);
  assert.doesNotMatch(c.textContent, BANNED);
});

test("crew list: open alerts across the crew with identity; shared wellbeing shows dates only", async () => {
  const { c } = await renderCrew();
  const alerts = sectionOf(c, "crew-alerts-title");
  const titles = byClass(alerts, "alert-item__title").map((e) => e.textContent);
  assert.deepEqual(titles, ["Jonas Reyes (AH-04) · ALT-0190 · Reduced sleep duration", "Mei Chen (AH-03) · ALT-0189 · Supportive check-in recommended"]);
  assert.equal(byTag(alerts, "button").length, 0, "no alert actions");
  assert.match(alerts.textContent, /Synthetic/);
  const shared = sectionOf(c, "crew-shared-title");
  assert.equal(byTag(shared, "li").length, 4);
  assert.doesNotMatch(shared.textContent, /mood|stress|\/ 5|\/ 10/i, "no scores in the list view");
  assert.match(shared.textContent, /Private check-ins and journals are never shown/);
});

// =====================================================================================
// #/crew/AH-0n detail
// =====================================================================================

test("detail: heading gets focus on navigation; profile, status, readings incl. BP, shared scores, sleep, cognitive, messages", async () => {
  const { c, seen } = await renderCrew({ hash: "#/crew/AH-04", focus: true });
  assert.deepEqual(seen.detail, ["AH-04"]);
  const heading = byId(c, "crew-detail-title");
  assert.equal(heading.textContent, "Jonas Reyes · AH-04");
  assert.equal(globalThis.document.activeElement, heading, "focus moved to the crew member's name");
  assert.equal(heading.getAttribute("tabindex"), "-1");
  assert.match(sectionOf(c, "crew-detail-status-title").textContent, /Watch.*ALT-0190.*not a health assessment/);
  const vitals = byClass(c, "vitals-stage__ring").map((v) => byClass(v, "scan-ring__label")[0].textContent);
  assert.deepEqual(vitals, ["Heart rate", "SpO₂", "Blood pressure", "Sleep duration"]);
  const shared = sectionOf(c, "crew-detail-wellbeing-title");
  assert.equal(byClass(shared, "crew-shared__item").length, 7);
  assert.match(shared.textContent, /Mood\d \/ 5Stress\d+ \/ 10/);
  assert.match(shared.textContent, /Private check-ins and the private journal are never shown/);
  assert.match(sectionOf(c, "crew-detail-sleep-title").textContent, /7 of 7 nights recorded/);
  assert.match(sectionOf(c, "crew-detail-cognitive-title").textContent, /Last completed .* UTC/);
  const messages = sectionOf(c, "crew-detail-messages-title");
  assert.match(messages.textContent, /From the Medical Officer.*Replied/);
  assert.match(messages.textContent, /Reply from Jonas Reyes: Understood — resting early tonight\./);
  assert.equal(byTag(messages, "button").length, 0, "read-only");
  assert.ok(byTag(c, "a").some((a) => a.getAttribute("href") === "#/crew"), "Back to Crew Monitor");
  assert.doesNotMatch(c.textContent, BANNED);
  for (const t of byTag(c, "time")) assert.match(t.textContent, / UTC$/);
});

test("detail: focus is not moved on a first page load (only on in-app navigation)", async () => {
  globalThis.document.activeElement = null;
  await renderCrew({ hash: "#/crew/AH-01", detail: DETAIL_HADDAD, focus: false });
  assert.equal(globalThis.document.activeElement, null);
});

test("detail: Haddad's pending verified message and no private check-in content", async () => {
  const { c } = await renderCrew({ hash: "#/crew/AH-01", detail: DETAIL_HADDAD });
  assert.match(sectionOf(c, "crew-detail-messages-title").textContent, /From the Medical Officer.*Awaiting acknowledgement/);
  const priv = (await mock.wellbeingRepo.getRange("a-01")).filter((w) => w.sharedWithMedical === 0);
  const shownTimes = byTag(sectionOf(c, "crew-detail-wellbeing-title"), "time").map((t) => t.getAttribute("datetime"));
  for (const p of priv) assert.ok(!shownTimes.includes(new Date(p.timestamp).toISOString()), "private check-in not shown");
  const journal = await mock.journalRepo.getByAstronaut("a-01");
  for (const j of journal) assert.ok(!c.textContent.includes(j.text), "journal text never shown");
});

test("detail: failed sections show their own Retry; the rest stays visible", async () => {
  const data = structuredClone(DETAIL_REYES);
  data.sharedWellbeing = { status: "error", items: [] };
  data.messages = { status: "error", items: [], moreCount: 0 };
  const { c } = await renderCrew({ hash: "#/crew/AH-04", detail: data });
  assert.match(sectionOf(c, "crew-detail-wellbeing-title").textContent, /Couldn't load shared check-ins/);
  assert.match(sectionOf(c, "crew-detail-messages-title").textContent, /Couldn't load messages/);
  assert.match(sectionOf(c, "crew-detail-vitals-title").textContent, /Heart rate/);
  assert.equal(all(c, (e) => e.hasAttribute("data-retry")).length, 2);
});

test("Retry: a newer retry wins over an older one; buttons disabled while loading", async () => {
  const failing = structuredClone(SNAPSHOT);
  failing.alerts = { status: "error", items: [], moreCount: 0 };
  const { fn, calls } = deferred();
  const c = new FakeElement("div");
  const render = crewPage.createCrewMonitorRenderer({ loadSnapshot: fn, loadDetail: fn });
  const first = render(c, MO, { hash: "#/crew" });
  calls[0].resolve(failing);
  await first;
  const buttons = c.childNodes[0].querySelectorAll("[data-retry]");
  assert.ok(buttons.length >= 1);
  buttons[0].click();
  buttons[0].click();
  assert.ok(buttons.every((b) => b.disabled));
  calls[2].resolve(SNAPSHOT);
  calls[1].resolve(failing);
  await flush();
  await flush();
  assert.doesNotMatch(c.textContent, /Couldn't load the crew's alerts/);
  assert.match(c.textContent, /ALT-0190/);
});

test("database strings are inserted as text, never markup", async () => {
  const data = structuredClone(DETAIL_REYES);
  data.profile.name = "<img src=x onerror=alert(1)>";
  data.alerts.items[0].explanation = "<script>alert(2)</script>";
  data.messages.items[0].body = "<b>bold</b>";
  const { c } = await renderCrew({ hash: "#/crew/AH-04", detail: data });
  assert.equal(byTag(c, "img").length + byTag(c, "script").length + byTag(c, "b").length, 0);
  assert.match(c.textContent, /<img src=x onerror=alert\(1\)>/);
});

// =====================================================================================
// Body-scan redesign: Medical Officer views
// =====================================================================================

const alertsSvc = await import("../../js/services/alerts-service.js");
const alertsService = alertsSvc.createAlertsService({ repos: mock, withTransaction: mock.withTransaction });
const realAlertDetail = (session, number) => alertsService.getAlertDetail(session, number, { now: NOW });

test("MO overview: one dark body-scan card per crew member, in review order, with a top-alert pin and 3 small rings", async () => {
  const visited = [];
  const c = new FakeElement("div");
  await moPage.createMedicalOfficerOverviewRenderer({ loadSnapshot: async () => SNAPSHOT, navigate: (h) => visited.push(h) })(c, MO, {});
  const scan = sectionOf(c, "mo-scan-title");
  const cards = byClass(scan, "mo-scan-card");
  assert.deepEqual(cards.map((k) => byClass(k, "mo-scan-card__name")[0].textContent), SNAPSHOT.crew.map((m) => `${m.name} · ${m.crewId}`));
  assert.ok(cards.every((k) => k.classList.includes("scan-stage")), "dark scan stage");
  const reyes = cards[0];
  const pins = byClass(reyes, "scan-pin");
  assert.equal(pins.length, 1);
  assert.equal(pins[0].tagName, "BUTTON");
  assert.match(pins[0].getAttribute("aria-label"), /^Jonas Reyes: top Alert 1: ALT-0190 Reduced sleep duration — Warning, Head\. Open crew member body scan\.$/);
  pins[0].click();
  assert.deepEqual(visited, ["#/crew/AH-04"]);
  assert.deepEqual(byClass(reyes, "scan-ring__label").map((l) => l.textContent), ["Heart rate", "SpO₂", "Sleep duration"]);
  assert.match(reyes.textContent, /pin 1: ALT-0190 · Reduced sleep duration \(Head\)/);
  assert.ok(byTag(reyes, "a").some((a) => a.getAttribute("href") === "#/crew/AH-04"), "text link as well as the pin");
  const clear = cards.find((k) => /No open alerts\./.test(k.textContent));
  assert.ok(clear, "a crew member without alerts");
  assert.equal(byClass(clear, "scan-pin").length, 0);
  const ids = all(c, (e) => e.hasAttribute("id")).map((e) => e.getAttribute("id"));
  assert.equal(new Set(ids).size, ids.length, "ids are unique across cards");
  assert.match(scan.textContent, /illustrations only — not a health assessment/);
  assert.doesNotMatch(scan.textContent, BANNED);
});

function renderDetail(extra = {}) {
  const c = new FakeElement("div");
  const host = new FakeElement("body");
  const render = crewPage.createCrewMonitorRenderer({ loadSnapshot: async () => SNAPSHOT, loadDetail: async () => DETAIL_REYES, loadAlertDetail: realAlertDetail, host, ...extra });
  return render(c, MO, { hash: "#/crew/AH-04", ...(extra.options || {}) }).then(() => ({ c, host }));
}

test("crew detail: body-scan stage with 4 rings, dashed connectors and a numbered pin per open alert", async () => {
  const { c } = await renderDetail();
  const stage = sectionOf(c, "crew-detail-vitals-title");
  assert.ok(stage.classList.includes("scan-stage"));
  assert.equal(byClass(stage, "vitals-stage__ring").length, 4);
  assert.equal(byClass(stage, "vitals-stage__link").length, 4);
  assert.equal(byClass(stage, "scan-body__svg")[0].getAttribute("aria-hidden"), "true");
  const pins = byClass(stage, "scan-pin");
  assert.equal(pins.length, DETAIL_REYES.alerts.items.length);
  assert.match(pins[0].getAttribute("aria-label"), /^Jonas Reyes: Alert 1: ALT-0190 Reduced sleep duration — Warning, Head\. Open details\.$/);
  const bp = byClass(stage, "vitals-stage__ring")[2];
  assert.match(bp.textContent, /\d+\/\d+/);
  assert.ok(byClass(bp, "sr-only").some((e) => / over \d+ millimetres of mercury$/.test(e.textContent)));
  const alerts = sectionOf(c, "crew-detail-alerts-title");
  assert.match(alerts.textContent, /Pin 1 · Head/);
  assert.equal(byTag(alerts, "button").length, 1, "only 'open details' — no lifecycle actions here");
});

test("crew detail: pin → read-only pop-up with crew member, rule, readings; review link to the Alerts page; Esc returns focus", async () => {
  const { c, host } = await renderDetail();
  const pin = byClass(c, "scan-pin")[0];
  pin.click();
  await flush();
  const backdrop = byClass(host, "modal-backdrop")[0];
  assert.ok(backdrop);
  const dialog = backdrop.childNodes[0];
  assert.equal(dialog.getAttribute("role"), "dialog");
  const text = dialog.textContent;
  for (const part of ["ALT-0190 · Reduced sleep duration", "Jonas Reyes (AH-04)", "Head (pin 1)", "PHY-05", "Key readings", "not clinically validated", "read-only"]) assert.ok(text.includes(part), part);
  assert.equal(byTag(dialog, "button").filter((b) => !b.classList.includes("dialog__close")).length, 0, "no acknowledge/resolve buttons in the pop-up");
  assert.deepEqual(byTag(dialog, "a").map((a) => a.getAttribute("href")), ["#/alerts/ALT-0190"]);
  backdrop.dispatch("keydown", { key: "Escape" });
  assert.equal(byClass(host, "modal-backdrop").length, 0);
  assert.equal(globalThis.document.activeElement, pin);
});

test("crew detail: the alert list opens the same pop-up; a failed detail load says so and invents nothing; navigating away closes it", async () => {
  const controller = new AbortController();
  const { c, host } = await renderDetail({ loadAlertDetail: async () => { throw new Error("db"); }, options: { signal: controller.signal } });
  byTag(sectionOf(c, "crew-detail-alerts-title"), "button")[0].click();
  await flush();
  const text = byClass(host, "modal-backdrop")[0].textContent;
  assert.match(text, /Full details couldn't be loaded/);
  assert.doesNotMatch(text, /Key readings/);
  controller.abort();
  assert.equal(byClass(host, "modal-backdrop").length, 0);
});
