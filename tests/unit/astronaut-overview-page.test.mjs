// tests/unit/astronaut-overview-page.test.mjs — the #/overview page module.
// Runs the real page code against a tiny fake DOM (just enough for el(),
// icon() and the renderer). Ready data comes from the real service over the
// seeded mock repositories, so the page is tested with realistic content.
// Run: npm run test:unit

import test from "node:test";
import assert from "node:assert/strict";

import { FakeElement, all, byClass, byTag, byId, sectionOf } from "./fake-dom.mjs";

const page = await import("../../js/pages/astronaut-overview.js");
const svc = await import("../../js/services/astronaut-overview-service.js");
const mock = await import("../../js/db/mock-repositories.js");
const { describeMission } = await import("../../js/services/mission-service.js");

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 14, 15, 30);
const ASTRONAUT = { version: 1, userId: "u-reyes", username: "reyes", displayName: "Jonas Reyes", role: "astronaut", astronautId: "a-04", createdAt: NOW - HOUR, expiresAt: NOW + HOUR };
const OFFICER = { version: 1, userId: "u-medofficer", username: "medofficer", displayName: "Dr. Lena Ortiz", role: "medical_officer", astronautId: "", createdAt: NOW - HOUR, expiresAt: NOW + HOUR };

await mock.resetMock({ now: NOW });
const service = svc.createAstronautOverviewService({
  repos: {
    usersRepo: mock.usersRepo, astronautsRepo: mock.astronautsRepo, measurementsRepo: mock.measurementsRepo,
    dailySummariesRepo: mock.dailySummariesRepo, alertsRepo: mock.alertsRepo, messagesRepo: mock.messagesRepo,
    wellbeingRepo: mock.wellbeingRepo, cognitiveRepo: mock.cognitiveRepo,
  },
  getMissionContext: async () => describeMission(await mock.settingsRepo.get("mission"), NOW),
});
const realLoader = (session) => service.getAstronautOverview(session, { now: NOW });
const READY_REYES = await realLoader(ASTRONAUT);
const READY_HADDAD = await realLoader({ ...ASTRONAUT, userId: "u-haddad", username: "haddad", displayName: "Cmdr. Sami Haddad", astronautId: "a-01" });

/** A loader the test controls: resolve(result) when you want. */
function deferredLoader() {
  const calls = [];
  const loader = (session) => new Promise((resolve) => calls.push({ session, resolve }));
  return { loader, calls };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const BANNED = /\b(healthy|safe|nominal|normal health|medically cleared|no health risk|diagnos|prescri)/i;

// =====================================================================================

test("25. Medical Officer: neutral placeholder with Crew Monitor + Alerts links; the astronaut service is never called", async () => {
  let called = 0;
  const render = page.createOverviewRenderer({ loadOverview: async () => { called += 1; return READY_REYES; } });
  const container = new FakeElement("div");
  await render(container, OFFICER, { signal: new AbortController().signal });
  await flush();
  assert.equal(called, 0);
  const links = byTag(container, "a").map((a) => a.getAttribute("href"));
  assert.deepEqual(links, ["#/crew", "#/alerts"]);
  const text = container.textContent;
  assert.match(text, /Medical Officer overview/);
  assert.doesNotMatch(text, /Jonas|Reyes|AH-0|ALT-|bpm/, "no astronaut data");
  assert.notEqual(container.childNodes[0].getAttribute("aria-busy"), "true");
});

test("ready Overview: sections in the approved order with unique heading ids", async () => {
  const render = page.createOverviewRenderer({ loadOverview: async () => READY_REYES });
  const container = new FakeElement("div");
  await render(container, ASTRONAUT, {});
  const root = container.childNodes[0];
  assert.equal(root.getAttribute("aria-busy"), "false");
  const order = all(root, (e) => e.tagName === "SECTION").map((s) => s.getAttribute("aria-labelledby"));
  assert.deepEqual(order, ["ov-welcome-title", "ov-status-title", "ov-vitals-title", "ov-alerts-title", "ov-message-title", "ov-routine-title", "ov-sleep-title", "ov-links-title"]);
  const ids = all(root, (e) => e.hasAttribute("id")).map((e) => e.getAttribute("id"));
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const id of order) assert.equal(byId(root, id).tagName, "H2", id);
  assert.match(byId(root, "ov-welcome-title").textContent, /Welcome, Jonas Reyes/);
  assert.match(root.textContent, /synthetic demo data/);
});

test("status: Watch for reyes with icon + text + colour class, and the not-a-health-assessment note", async () => {
  const container = new FakeElement("div");
  await page.createOverviewRenderer({ loadOverview: async () => READY_REYES })(container, ASTRONAUT, {});
  const status = sectionOf(container, "ov-status-title");
  const badge = byClass(status, "overview__status-badge")[0];
  assert.ok(badge.classList.includes("badge--warning"), "warning token, not brand orange");
  assert.equal(byTag(badge, "svg").length, 1, "has an icon");
  assert.match(badge.textContent, /Watch/);
  assert.match(status.textContent, /Based on your open alerts only\. This is not a health assessment\./);
  assert.doesNotMatch(container.textContent, BANNED);
});

test("status: 'No open alerts' for haddad, never a health claim", async () => {
  const container = new FakeElement("div");
  await page.createOverviewRenderer({ loadOverview: async () => READY_HADDAD })(container, { ...ASTRONAUT, astronautId: "a-01" }, {});
  const status = sectionOf(container, "ov-status-title");
  assert.match(status.textContent, /No open alerts/);
  assert.ok(byClass(status, "overview__status-badge")[0].classList.includes("badge--ok"));
  assert.doesNotMatch(container.textContent, BANNED);
  // haddad's unacknowledged message is shown read-only (no buttons in that section)
  const message = sectionOf(container, "ov-message-title");
  assert.match(message.textContent, /vital-signs reading/);
  assert.match(message.textContent, /From the Medical Officer/);
  assert.equal(byTag(message, "button").length, 0);
});

test("alerts: listed with number, title, severity, status, UTC time and a Synthetic tag; link to #/alerts; only an 'open details' button", async () => {
  const container = new FakeElement("div");
  await page.createOverviewRenderer({ loadOverview: async () => READY_REYES })(container, ASTRONAUT, {});
  const alerts = sectionOf(container, "ov-alerts-title");
  const items = byClass(alerts, "alert-item");
  assert.equal(items.length, 1);
  const text = items[0].textContent;
  for (const part of ["ALT-0190", "Reduced sleep duration", "Warning", "Acknowledged", "Synthetic", "UTC"]) assert.match(text, new RegExp(part));
  const buttons = byTag(alerts, "button");
  assert.equal(buttons.length, 1, "one button: open the alert's details (no lifecycle actions)");
  assert.equal(buttons[0].getAttribute("data-alert-open"), "1");
  assert.match(text, /Pin 1 · Head/);
  assert.deepEqual(byTag(alerts, "a").map((a) => a.getAttribute("href")), ["#/alerts"]);
  assert.doesNotMatch(alerts.textContent, /unread/i);
});

test("timestamps use <time datetime> and a visible UTC label", async () => {
  const container = new FakeElement("div");
  await page.createOverviewRenderer({ loadOverview: async () => READY_REYES })(container, ASTRONAUT, {});
  const times = byTag(container, "time");
  assert.ok(times.length >= 6, `found ${times.length}`);
  for (const t of times) {
    assert.match(t.getAttribute("datetime"), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(t.textContent, / UTC$/);
  }
});

test("vital rings: 4 rings; simulated vs manual labels; suspect and stale are data-quality labels", async () => {
  const data = structuredClone(READY_REYES);
  const card = (key) => data.vitals.items.find((i) => i.key === key);
  Object.assign(card("heartRate"), { quality: "suspect" });
  Object.assign(card("spo2"), { source: "manual", simulated: false, stale: true });
  const container = new FakeElement("div");
  await page.createOverviewRenderer({ loadOverview: async () => data })(container, ASTRONAUT, {});
  const rings = byClass(container, "vitals-stage__ring");
  assert.deepEqual(rings.map((c) => byClass(c, "scan-ring__label")[0].textContent), ["Heart rate", "SpO₂", "Blood pressure", "Sleep duration"]);
  assert.ok(rings.every((r) => r.tagName === "FIGURE" && byId(r, r.getAttribute("aria-labelledby"))), "each ring is a labelled figure");
  const [hr, spo2, bp] = rings;
  assert.ok(rings.every((c) => byClass(c, "vitals-stage__ring-link")[0].getAttribute("href") === "#/physical"), "every vital offers its health history");
  assert.match(hr.textContent, /Simulated/);
  assert.match(hr.textContent, /Data quality: suspect/);
  assert.ok(!byClass(hr, "badge--warning").length && !byClass(hr, "badge--critical").length, "suspect isn't shown as a health warning");
  assert.match(spo2.textContent, /Manual entry/);
  assert.equal(byClass(spo2, "sim-tag").length, 0, "manual reading not labelled simulated");
  assert.match(spo2.textContent, /No newer reading/);
  assert.match(bp.textContent, /\d+\/\d+/);
  assert.match(bp.textContent, /Your baseline: \d+\/\d+ mmHg/);
  // the visual value is hidden from screen readers and replaced by a spoken sentence
  assert.equal(byClass(hr, "scan-ring__value")[0].getAttribute("aria-hidden"), "true");
  assert.ok(byClass(hr, "sr-only").some((e) => / beats per minute$/.test(e.textContent)), "spoken value with unit");
  assert.ok(byClass(hr, "sr-only").some((e) => e.textContent === " (demo history)"), "spoken provenance");
  // ring fill is a display scale: the arc has no status colour class
  for (const arc of byClass(container, "scan-ring__arc")) assert.equal(arc.getAttribute("class"), "scan-ring__arc");
  // each ring has a dashed connector to its body zone
  assert.equal(byClass(container, "vitals-stage__link").length, 4);
  assert.equal(byClass(container, "vitals-stage__links")[0].getAttribute("aria-hidden"), "true");
});

test("empty and incomplete vitals are honest (no zeros, no invented pair)", async () => {
  const data = structuredClone(READY_REYES);
  data.vitals.items = [
    { key: "heartRate", label: "Heart rate", unit: "bpm", baseline: 72, state: "empty", invalidOnly: false },
    { key: "spo2", label: "SpO₂", unit: "%", baseline: null, state: "empty", invalidOnly: true },
    { key: "bloodPressure", label: "Blood pressure", unit: "mmHg", baseline: null, state: "incomplete" },
    { key: "sleepDuration", label: "Sleep duration", unit: "h", baseline: 7, state: "error" },
  ];
  const container = new FakeElement("div");
  await page.createOverviewRenderer({ loadOverview: async () => data })(container, ASTRONAUT, {});
  const [hr, spo2, bp, sleep] = byClass(container, "vitals-stage__ring");
  assert.match(hr.textContent, /No recent reading/);
  assert.match(spo2.textContent, /marked invalid/);
  assert.match(bp.textContent, /No complete reading/);
  assert.match(sleep.textContent, /Couldn't load this reading/);
  assert.equal(byTag(sleep, "button").length, 1, "Retry");
  for (const c of [hr, spo2, bp]) assert.doesNotMatch(c.textContent, /(^|\D)0(\.0)? ?(bpm|%|mmHg)/);
  for (const c of [hr, spo2, bp, sleep]) assert.equal(byClass(c, "scan-ring__arc").length, 0, "no arc without a value");
  assert.match(spo2.textContent, /No baseline recorded/);
});

test("sleep: CSS bars with a visible summary; missing nights are 'No data', never zero", async () => {
  const data = structuredClone(READY_REYES);
  data.sleep = { status: "ok", nights: READY_REYES.sleep.nights.map((n, i) => (i === 2 ? { ...n, hours: null } : n)), recorded: 6, average: 6.5, baseline: 7, belowBaseline: 4 };
  const container = new FakeElement("div");
  await page.createOverviewRenderer({ loadOverview: async () => data })(container, ASTRONAUT, {});
  const sleep = sectionOf(container, "ov-sleep-title");
  assert.match(sleep.textContent, /6 of 7 nights recorded\. Average 6\.5 h\. Your baseline: 7\.0 h\. 4 of 6 recorded nights below your baseline\./);
  const nights = byClass(sleep, "overview-sleep__night");
  assert.equal(nights.length, 7);
  assert.ok(nights[2].classList.includes("is-missing"));
  assert.match(nights[2].textContent, /No data/);
  assert.equal(byClass(nights[2], "overview-sleep__bar").length, 0, "no zero-height bar for a missing night");
  assert.equal(byClass(nights[0], "overview-sleep__track")[0].getAttribute("aria-hidden"), "true");
  assert.match(byClass(nights[0], "overview-sleep__bar")[0].style["--h"], /^\d+(\.\d)?%$/);
  assert.doesNotMatch(sleep.textContent, BANNED);
  // no data at all
  data.sleep = { status: "ok", nights: data.sleep.nights.map((n) => ({ ...n, hours: null })), recorded: 0, average: null, baseline: 7, belowBaseline: 0 };
  const c2 = new FakeElement("div");
  await page.createOverviewRenderer({ loadOverview: async () => data })(c2, ASTRONAUT, {});
  assert.match(sectionOf(c2, "ov-sleep-title").textContent, /No sleep data in the last seven nights\./);
});

test("routine: UTC day, check-in completion + shared/private only, never due/overdue", async () => {
  const container = new FakeElement("div");
  await page.createOverviewRenderer({ loadOverview: async () => READY_REYES })(container, ASTRONAUT, {});
  const routine = sectionOf(container, "ov-routine-title");
  assert.match(routine.textContent, /Completed today/);
  assert.match(routine.textContent, /Shared with the Medical Officer/);
  assert.match(routine.textContent, /Last completed/);
  assert.doesNotMatch(routine.textContent, /\bdue\b|overdue|mood|stress/i);
});

test("quick links go to the approved routes and say they may be placeholders", async () => {
  const container = new FakeElement("div");
  await page.createOverviewRenderer({ loadOverview: async () => READY_REYES })(container, ASTRONAUT, {});
  const links = sectionOf(container, "ov-links-title");
  assert.deepEqual(byTag(links, "a").map((a) => a.getAttribute("href")), ["#/physical", "#/wellbeing", "#/history", "#/alerts"]);
  assert.match(links.textContent, /may show a placeholder/);
});

test("loading: aria-busy and a status message, then aria-busy=false when done", async () => {
  const { loader, calls } = deferredLoader();
  const container = new FakeElement("div");
  const done = page.createOverviewRenderer({ loadOverview: loader })(container, ASTRONAUT, {});
  const root = container.childNodes[0];
  assert.equal(root.getAttribute("aria-busy"), "true");
  assert.match(root.textContent, /Loading your overview/);
  calls[0].resolve(READY_REYES);
  await done;
  assert.equal(root.getAttribute("aria-busy"), "false");
});

test("an old async result can't overwrite the route that is now on screen", async () => {
  const { loader, calls } = deferredLoader();
  const container = new FakeElement("div");
  const controller = new AbortController();
  const pending = page.createOverviewRenderer({ loadOverview: loader })(container, ASTRONAUT, { signal: controller.signal });
  // The user navigates away: app-shell aborts and renders another route.
  controller.abort();
  const otherRoute = new FakeElement("section");
  otherRoute.append("Health History placeholder");
  container.replaceChildren(otherRoute);
  calls[0].resolve(READY_REYES); // the late Overview result arrives
  await pending;
  await flush();
  assert.equal(container.childNodes.length, 1);
  assert.equal(container.childNodes[0], otherRoute);
  assert.equal(container.textContent, "Health History placeholder");
});

test("Retry: a failed section can be retried; a newer retry wins over an older one", async () => {
  const partial = structuredClone(READY_REYES);
  partial.alerts = { status: "error", items: [], openCount: null, moreCount: 0 };
  partial.overall = svc.deriveOverallStatus(null);
  const { loader, calls } = deferredLoader();
  const container = new FakeElement("div");
  const first = page.createOverviewRenderer({ loadOverview: loader })(container, ASTRONAUT, {});
  calls[0].resolve(partial);
  await first;
  assert.match(sectionOf(container, "ov-alerts-title").textContent, /Couldn't load your alerts/);
  assert.match(sectionOf(container, "ov-status-title").textContent, /Status unavailable/);
  assert.match(sectionOf(container, "ov-vitals-title").textContent, /Heart rate/, "successful sections stay visible");
  const retryButtons = container.childNodes[0].querySelectorAll("[data-retry]");
  assert.ok(retryButtons.length >= 2);
  retryButtons[0].click(); // retry #1
  retryButtons[1].click(); // retry #2 (newer)
  assert.equal(calls.length, 3);
  assert.ok(retryButtons.every((b) => b.disabled), "buttons are disabled while retrying");
  calls[2].resolve(READY_REYES); // newest finishes first
  calls[1].resolve(partial);     // older retry finishes later — must be ignored
  await flush();
  await flush();
  assert.doesNotMatch(container.textContent, /Couldn't load your alerts/);
  assert.match(sectionOf(container, "ov-status-title").textContent, /Watch/);
});

test("full failures: unavailable offers Retry; account mismatch asks to sign in again without Retry", async () => {
  const c1 = new FakeElement("div");
  await page.createOverviewRenderer({ loadOverview: async () => ({ status: "unavailable", reason: "database_error" }) })(c1, ASTRONAUT, {});
  assert.match(c1.textContent, /Overview unavailable/);
  assert.equal(byTag(c1, "button").length, 1);
  assert.equal(all(c1, (e) => e.getAttribute("role") === "alert").length, 1);
  const c2 = new FakeElement("div");
  await page.createOverviewRenderer({ loadOverview: async () => ({ status: "forbidden", reason: "account_mismatch" }) })(c2, ASTRONAUT, {});
  assert.match(c2.textContent, /Please sign in again/);
  assert.equal(byTag(c2, "button").length, 0);
  const c3 = new FakeElement("div");
  await page.createOverviewRenderer({ loadOverview: async () => { throw new Error("boom"); } })(c3, ASTRONAUT, {});
  assert.match(c3.textContent, /Overview unavailable/);
  for (const c of [c1, c2, c3]) assert.doesNotMatch(c.textContent, /Jonas|AH-04|ALT-|bpm/, "no personal data");
});

test("database strings are inserted as text, never as markup", async () => {
  const data = structuredClone(READY_REYES);
  data.alerts.items[0].title = '<img src=x onerror="alert(1)">';
  data.alerts.items[0].explanation = "<script>alert(2)</script>";
  data.astronaut.displayName = "<b>Mallory</b>";
  const container = new FakeElement("div");
  await page.createOverviewRenderer({ loadOverview: async () => data })(container, ASTRONAUT, {});
  assert.equal(byTag(container, "img").length, 0);
  assert.equal(byTag(container, "script").length, 0);
  assert.equal(byTag(container, "b").length, 0);
  assert.match(container.textContent, /<img src=x onerror="alert\(1\)">/);
  assert.ok(all(container, (e) => e.svgMarkup && e.tagName !== "SVG").length === 0, "only icons receive markup");
});

test("messages: empty state names the Medical Officer; nothing claims an unverified sender", async () => {
  const container = new FakeElement("div");
  await page.createOverviewRenderer({ loadOverview: async () => READY_REYES })(container, ASTRONAUT, {});
  const message = sectionOf(container, "ov-message-title");
  assert.match(message.textContent, /No unacknowledged messages from the Medical Officer\./);
  assert.doesNotMatch(message.textContent, /From the Medical Officer/);
  // a failed messages section shows only its own error; other sections stay
  const data = structuredClone(READY_REYES);
  data.messages = { status: "error", latest: null, moreCount: 0 };
  const c2 = new FakeElement("div");
  await page.createOverviewRenderer({ loadOverview: async () => data })(c2, ASTRONAUT, {});
  assert.match(sectionOf(c2, "ov-message-title").textContent, /Couldn't load your messages/);
  for (const id of ["ov-status-title", "ov-alerts-title", "ov-vitals-title", "ov-routine-title", "ov-sleep-title"]) {
    assert.doesNotMatch(sectionOf(c2, id).textContent, /Couldn't load/, id);
  }
});

// ---- Body-scan redesign: pins, pop-up, action-plan drawer, activity --------------------

const alertsSvc = await import("../../js/services/alerts-service.js");
const historySvc = await import("../../js/services/history-service.js");
const { createPlanProgress } = await import("../../js/core/action-plan-progress.js");
const alerts = alertsSvc.createAlertsService({ repos: mock, withTransaction: mock.withTransaction });
const history = historySvc.createHistoryService({ repos: mock });
const realDetail = (session, number) => alerts.getAlertDetail(session, number, { now: NOW });
const realActivity = (session) => history.getOwnHistory(session, { days: 7 }, { now: NOW });

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), map };
}

async function renderScan(extra = {}) {
  const host = new FakeElement("body");
  const container = new FakeElement("div");
  const storage = memoryStorage();
  const progress = createPlanProgress({ storage: () => storage });
  await page.createOverviewRenderer({ loadOverview: async () => READY_REYES, loadAlertDetail: realDetail, loadActivity: realActivity, progress, host, ...extra })(container, ASTRONAUT, extra.options || {});
  await flush();
  return { host, container, storage, progress };
}
const openDialogOf = (host) => byClass(host, "modal-backdrop")[0];

test("body scan: decorative wireframe body on the dark stage; one numbered pin per open alert, as a labelled button", async () => {
  const { container } = await renderScan();
  const stage = sectionOf(container, "ov-vitals-title");
  assert.ok(stage.classList.includes("scan-stage"));
  const svg = byClass(stage, "scan-body__svg")[0];
  assert.equal(svg.getAttribute("aria-hidden"), "true", "the drawing is decorative");
  const pins = byClass(stage, "scan-pin");
  assert.equal(pins.length, READY_REYES.alerts.items.length);
  assert.equal(pins[0].tagName, "BUTTON");
  assert.match(pins[0].getAttribute("aria-label"), /^Alert 1: ALT-0190 Reduced sleep duration — Warning, Head\. Open details\.$/);
  assert.ok(pins[0].classList.includes("scan-pin--warning"));
  assert.equal(byClass(pins[0], "scan-pin__num")[0].textContent, "1");
  assert.match(stage.textContent, /Illustration only/);
});

test("pin → pop-up with severity, body location, rule, readings and limitation; lifecycle buttons disabled with reasons", async () => {
  const { host, container } = await renderScan();
  const pin = byClass(container, "scan-pin")[0];
  pin.click();
  await flush();
  const backdrop = openDialogOf(host);
  assert.ok(backdrop, "the pop-up opened");
  const dialog = backdrop.childNodes[0];
  assert.equal(dialog.getAttribute("role"), "dialog");
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.match(byId(dialog, dialog.getAttribute("aria-labelledby")).textContent, /ALT-0190 · Reduced sleep duration/);
  const text = dialog.textContent;
  for (const part of ["Warning", "Acknowledged", "Head (pin 1)", "PHY-05", "What was detected", "Key readings", "not clinically validated"]) assert.ok(text.includes(part), part);
  const buttons = byTag(dialog, "button");
  const ack = buttons.find((b) => b.textContent === "Acknowledge");
  const msg = buttons.find((b) => b.textContent === "Message the Medical Officer");
  for (const b of [ack, msg]) {
    assert.ok(b.hasAttribute("disabled"), b.textContent);
    assert.match(byId(dialog, b.getAttribute("aria-describedby")).textContent, /Medical Officer|isn't available/);
  }
  assert.ok(buttons.some((b) => b.hasAttribute("data-plan-open") && !b.hasAttribute("disabled")));
  assert.equal(text.split("not clinically validated").length, 2, "the threshold label is shown once");
  assert.doesNotMatch(text.replace("This is not a diagnosis", ""), BANNED, "only the stored disclaimer mentions diagnosis");
  // Esc closes and focus returns to the pin
  backdrop.dispatch("keydown", { key: "Escape" });
  assert.equal(openDialogOf(host), undefined);
  assert.equal(globalThis.document.activeElement, pin);
});

test("'View action plan' → drawer with synthetic notice, progress, steps, video placeholder, timeline; ticks are stored per user and alert", async () => {
  const { host, container, storage } = await renderScan();
  const pin = byClass(container, "scan-pin")[0];
  pin.click();
  await flush();
  byTag(openDialogOf(host), "button").find((b) => b.hasAttribute("data-plan-open")).click();
  const backdrop = openDialogOf(host);
  assert.ok(backdrop.classList.includes("drawer-backdrop"));
  const drawer = backdrop.childNodes[0];
  const text = drawer.textContent;
  assert.match(text, /Synthetic educational content — not medical advice/);
  assert.match(text, /Sleep alert review/);
  assert.match(text, /0 of 4 review steps ticked/);
  assert.match(text, /Video guide/);
  assert.match(text, /Placeholder/);
  assert.match(text, /Alert activity/);
  assert.doesNotMatch(text, BANNED);
  for (const name of ["Escalate", "Mark resolved"]) {
    const b = byTag(drawer, "button").find((x) => x.textContent === name);
    assert.ok(b.hasAttribute("disabled"), name);
    assert.ok(byId(drawer, b.getAttribute("aria-describedby")), `${name} explains why`);
  }
  const boxes = all(drawer, (e) => e.tagName === "INPUT" && e.getAttribute("type") === "checkbox");
  assert.equal(boxes.length, 4);
  boxes[0].dispatch("change", { target: { checked: true } });
  assert.match(drawer.textContent, /1 of 4 review steps ticked/);
  assert.equal(byClass(drawer, "ov-plan__progress")[0].getAttribute("value"), "1");
  assert.deepEqual(JSON.parse(storage.getItem("astrohealth.actionplan.v1")), { "u-reyes": { "ALT-0190": ["recent"] } });
  // closing returns focus to the pin; reopening shows the stored tick
  byClass(drawer, "dialog__close")[0].click();
  assert.equal(globalThis.document.activeElement, pin);
  pin.click();
  await flush();
  byTag(openDialogOf(host), "button").find((b) => b.hasAttribute("data-plan-open")).click();
  assert.match(openDialogOf(host).textContent, /1 of 4 review steps ticked/);
});

test("the Open alerts list opens the same pop-up; a failed detail load still shows the listed alert honestly", async () => {
  const { host, container } = await renderScan({ loadAlertDetail: async () => { throw new Error("db"); } });
  byTag(sectionOf(container, "ov-alerts-title"), "button")[0].click();
  await flush();
  const text = openDialogOf(host).textContent;
  assert.match(text, /ALT-0190/);
  assert.match(text, /Full details couldn't be loaded/);
  assert.doesNotMatch(text, /Key readings/, "no readings are invented");
});

test("alert activity: newest alert events from the last 7 days, linked to their alert; failure is reported", async () => {
  const { container } = await renderScan();
  const box = byClass(container, "ov-activity")[0];
  const links = byTag(box, "a").map((a) => a.getAttribute("href"));
  assert.ok(links.length >= 1 && links.length <= 6, `found ${links.length}`);
  assert.ok(links.every((h) => /^#\/alerts\/ALT-\d{4}$/.test(h)));
  const { container: c2 } = await renderScan({ loadActivity: async () => ({ status: "unavailable" }) });
  assert.match(byClass(c2, "ov-activity")[0].textContent, /Alert activity couldn't be loaded/);
});

test("navigating away closes an open pop-up", async () => {
  const controller = new AbortController();
  const { host, container } = await renderScan({ options: { signal: controller.signal } });
  byClass(container, "scan-pin")[0].click();
  await flush();
  assert.ok(openDialogOf(host));
  controller.abort();
  assert.equal(openDialogOf(host), undefined);
});
